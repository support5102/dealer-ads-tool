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
const { requireAuth } = require('../middleware/auth');
const googleAds = require('../services/google-ads');
const { readGoals } = require('../services/goal-reader');
const { generateRecommendation } = require('../services/budget-recommender');

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
    const { customerId } = req.query;

    if (!customerId) {
      return res.status(400).json({ error: 'Missing customerId query parameter.' });
    }

    try {
      const mccId = req.session.mccId;
      const client = googleAds.createClient(
        config.googleAds,
        req.session.tokens.refresh_token,
        customerId,
        mccId
      );

      // Fetch all data in parallel
      const [campaignSpend, sharedBudgets, impressionShare, inventoryResult, goals] =
        await Promise.all([
          googleAds.getMonthSpend(client),
          googleAds.getSharedBudgets(client),
          googleAds.getImpressionShare(client),
          googleAds.getInventory(client),
          readGoals(sheetsClient, spreadsheetId),
        ]);

      // Find goal matching this customer ID
      const goal = goals.find(g => g.customerId === customerId.replace(/-/g, ''));

      if (!goal) {
        return res.status(404).json({
          error: `No goal found for customer ${customerId}. Add this account to the goals spreadsheet.`,
          customerId,
        });
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
        impressionShare,
        inventoryCount: newVehicleCount,
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        currentDay: now.getDate(),
      });

      res.json(recommendation);
    } catch (err) {
      console.error('Pacing error:', err.message);
      next(err);
    }
  });

  return router;
}

module.exports = { createPacingRouter };
