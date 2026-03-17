/**
 * Pacing Routes — budget pacing dashboard API.
 *
 * Called by: src/server.js (mounted at /api/*)
 * Calls: services/google-ads.js, services/goal-reader.js, services/budget-recommender.js
 *
 * Routes:
 *   GET /api/pacing?customerId=X  → Pacing recommendation for one dealer account
 */

const express = require('express');
const axios   = require('axios');
const { requireAuth } = require('../middleware/auth');
const googleAds = require('../services/google-ads');
const { readGoals } = require('../services/goal-reader');
const { generateRecommendation } = require('../services/budget-recommender');

/**
 * Creates a lightweight Google Sheets client from an OAuth access token.
 * Matches the googleapis SDK interface: client.spreadsheets.values.get({spreadsheetId, range})
 *
 * @param {string} accessToken - OAuth2 access token with spreadsheets.readonly scope
 * @returns {Object} Sheets-compatible client
 */
function createSheetsClient(accessToken) {
  return {
    spreadsheets: {
      values: {
        async get({ spreadsheetId, range }) {
          const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
          try {
            const res = await axios.get(url, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            return { data: res.data };
          } catch (err) {
            if (err.response) {
              console.error(`[SheetsClient] HTTP ${err.response.status} for range "${range}":`, JSON.stringify(err.response.data));
            }
            throw err;
          }
        },
      },
    },
  };
}

/**
 * Creates pacing routes with the given config.
 *
 * @param {Object} config - App configuration from config.js
 * @param {Object} [deps] - Injectable dependencies
 * @param {Object} [deps.sheetsClient] - Google Sheets API client
 * @param {string} [deps.spreadsheetId] - Google Sheets spreadsheet ID
 * @returns {express.Router} Configured pacing router
 */
function createPacingRouter(config, deps = {}) {
  const router = express.Router();
  const sheetsClient = deps.sheetsClient || null;
  const spreadsheetId = deps.spreadsheetId || process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '';

  router.get('/api/pacing', requireAuth, async (req, res, next) => {
    const { customerId, accountName } = req.query;

    if (!customerId) {
      return res.status(400).json({ error: 'Missing customerId query parameter.' });
    }

    try {
      const mccId = req.session.mccId || config.googleAds.mccId;

      // Refresh access token for REST calls
      const accessToken = await googleAds.refreshAccessToken(config.googleAds, req.session.tokens.refresh_token);
      req.session.tokens.access_token = accessToken;

      // REST context for all Google Ads queries (avoids gRPC issues on Railway)
      const restCtx = {
        accessToken,
        developerToken: config.googleAds.developerToken,
        customerId: customerId.replace(/-/g, ''),
        loginCustomerId: mccId,
      };

      // Use injected sheets client (tests) or create one from OAuth token (production)
      const activeSheets = sheetsClient || createSheetsClient(accessToken);

      // Fetch all data in parallel — inventory, dedicated budgets, and sheets are non-fatal
      const [campaignSpend, sharedBudgets, dedicatedBudgets, impressionShare, inventoryResult, goals] =
        await Promise.all([
          googleAds.getMonthSpend(restCtx),
          googleAds.getSharedBudgets(restCtx),
          googleAds.getDedicatedBudgets(restCtx).catch(err => {
            console.warn('Dedicated budgets fetch failed (non-fatal):', err.message);
            return [];
          }),
          googleAds.getImpressionShare(restCtx),
          googleAds.getInventory(restCtx).catch(err => {
            console.warn('Inventory fetch failed (non-fatal):', err.message);
            return { items: [], truncated: false };
          }),
          readGoals(activeSheets, spreadsheetId).catch(err => {
            console.warn('Goals fetch failed:', err.message);
            return [];
          }),
        ]);

      // Find goal matching this account by name (case-insensitive, trimmed)
      const searchName = (accountName || '').trim().toLowerCase();
      const goal = goals.find(g => g.dealerName.toLowerCase() === searchName);

      if (!goal) {
        const hint = goals.length === 0
          ? 'Could not load goals from spreadsheet. Check Sheets permissions (re-login to grant spreadsheets.readonly scope).'
          : `No goal found for "${accountName || customerId}" in the spreadsheet. Available: ${goals.slice(0, 5).map(g => g.dealerName).join(', ')}${goals.length > 5 ? '...' : ''}`;
        return res.status(404).json({ error: hint, customerId, goalsLoaded: goals.length });
      }

      // Count new vehicle inventory
      const items = (inventoryResult && inventoryResult.items) || [];
      const newVehicleCount = items.filter(
        item => item.condition === 'NEW'
      ).length;

      const now = new Date();
      const recommendation = generateRecommendation({
        goal,
        campaignSpend,
        sharedBudgets,
        dedicatedBudgets,
        impressionShare,
        inventoryCount: newVehicleCount,
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        currentDay: now.getDate(),
      });

      res.json({ customerId: customerId.replace(/-/g, ''), ...recommendation });
    } catch (err) {
      console.error('Pacing error:', err.message);
      next(err);
    }
  });

  return router;
}

module.exports = { createPacingRouter };
