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
const { ACCOUNT_OVERRIDES } = require('../services/strategy-rules');

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
 * Applies ACCOUNT_OVERRIDES to campaign spend data.
 * - Source accounts: excluded campaigns are filtered out
 * - Target accounts: excluded campaigns' spend is added in
 *
 * @param {Object[]} campaignSpend - Campaign spend array from getMonthSpend
 * @param {string} accountName - Current account name (lowercase)
 * @param {Object|null} redirectedSpend - Spend from source account to add (for target accounts)
 * @returns {Object[]} Filtered campaign spend
 */
function applySpendOverrides(campaignSpend, accountName, redirectedSpend) {
  const override = ACCOUNT_OVERRIDES[accountName];
  let filtered = campaignSpend;

  // Source account: remove excluded campaigns
  if (override && override.excludeCampaigns) {
    const excludeSet = new Set(override.excludeCampaigns.map(n => n.toLowerCase()));
    filtered = campaignSpend.filter(c => !excludeSet.has(c.campaignName.toLowerCase()));
  }

  // Target account: add redirected spend
  if (redirectedSpend && redirectedSpend.length > 0) {
    filtered = [...filtered, ...redirectedSpend];
  }

  return filtered;
}

/**
 * Finds campaigns that should be redirected TO the given account name.
 * Scans all overrides for redirectSpendTo matching the target account.
 *
 * @param {string} targetName - Lowercase account name
 * @returns {{ sourceAccount: string, campaignNames: string[] }[]}
 */
function findRedirectsTo(targetName) {
  const redirects = [];
  for (const [source, override] of Object.entries(ACCOUNT_OVERRIDES)) {
    if (override.redirectSpendTo === targetName && override.excludeCampaigns) {
      redirects.push({ sourceAccount: source, campaignNames: override.excludeCampaigns });
    }
  }
  return redirects;
}

/**
 * Computes post-change daily average spend from daily breakdown data.
 *
 * @param {Object[]} dailyBreakdown - From getDailySpendBreakdown
 * @param {string} changeDate - YYYY-MM-DD of the last budget change
 * @param {string[]} [excludeCampaigns] - Campaign names to exclude (lowercase)
 * @returns {{ changeDate: string, dailyAvg: number, daysTracked: number }}
 */
function computePostChangeAvg(dailyBreakdown, changeDate, excludeCampaigns) {
  const excludeSet = new Set((excludeCampaigns || []).map(n => n.toLowerCase()));

  // Include only days on or after the change date
  const postChangeRows = dailyBreakdown.filter(
    r => r.date >= changeDate && !excludeSet.has(r.campaignName.toLowerCase())
  );

  // Group by date to count distinct days and total spend
  const dayTotals = new Map();
  for (const row of postChangeRows) {
    dayTotals.set(row.date, (dayTotals.get(row.date) || 0) + row.spend);
  }

  const daysTracked = dayTotals.size;
  const totalSpend = [...dayTotals.values()].reduce((s, v) => s + v, 0);
  const dailyAvg = daysTracked > 0 ? Math.round((totalSpend / daysTracked) * 100) / 100 : 0;

  return { changeDate, dailyAvg, daysTracked };
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

      // Fetch all data in parallel — inventory, dedicated budgets, sheets, and change history are non-fatal
      const [campaignSpend, sharedBudgets, dedicatedBudgets, impressionShare, inventoryResult, goals, lastChange] =
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
          googleAds.getLastBudgetChange(restCtx),
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

      // Apply spend overrides — exclude/redirect campaigns between accounts
      const redirects = findRedirectsTo(searchName);
      let redirectedSpend = [];
      let redirectedDailyRows = [];
      if (redirects.length > 0) {
        // Fetch spend from source accounts to capture redirected campaigns
        const accounts = req.session.accounts || [];
        for (const redirect of redirects) {
          const sourceAcct = accounts.find(a => (a.name || '').toLowerCase() === redirect.sourceAccount);
          if (sourceAcct) {
            const sourceCtx = { ...restCtx, customerId: sourceAcct.id.replace(/-/g, '') };
            const nameSet = new Set(redirect.campaignNames.map(n => n.toLowerCase()));
            try {
              const sourceSpend = await googleAds.getMonthSpend(sourceCtx);
              const matched = sourceSpend.filter(c => nameSet.has(c.campaignName.toLowerCase()));
              redirectedSpend.push(...matched);
            } catch (err) {
              console.warn(`Redirect spend fetch from ${redirect.sourceAccount} failed (non-fatal):`, err.message);
            }
            // Also fetch daily breakdown from source for post-change tracking
            try {
              const sourceDaily = await googleAds.getDailySpendBreakdown(sourceCtx);
              const matchedDaily = sourceDaily.filter(r => nameSet.has(r.campaignName.toLowerCase()));
              redirectedDailyRows.push(...matchedDaily);
            } catch (err) {
              console.warn(`Redirect daily breakdown from ${redirect.sourceAccount} failed (non-fatal):`, err.message);
            }
          }
        }
      }

      const adjustedSpend = applySpendOverrides(campaignSpend, searchName, redirectedSpend);

      // Fetch daily breakdown if a budget was changed this month — used for both
      // the post-change avg card AND to rebase "Current Daily Spend" to post-change rates
      let dailyBreakdown = null;
      let postChangeAvg = null;
      let postChangeWarning = null;
      const override = ACCOUNT_OVERRIDES[searchName];
      const excludeNames = override ? override.excludeCampaigns : [];

      if (lastChange.changeDate) {
        try {
          dailyBreakdown = await googleAds.getDailySpendBreakdown(restCtx);
          // Merge in redirected daily rows (e.g., Allstar gets Pmax VLA daily data from Alan Jay)
          if (redirectedDailyRows.length > 0) {
            dailyBreakdown = [...dailyBreakdown, ...redirectedDailyRows];
          }
          postChangeAvg = computePostChangeAvg(dailyBreakdown, lastChange.changeDate, excludeNames);
          // If post-change data has zero days tracked, warn — data may not be available yet
          if (postChangeAvg && postChangeAvg.daysTracked === 0) {
            postChangeWarning = `Budget changed on ${lastChange.changeDate} but no spend data available yet — using full-month averages`;
            dailyBreakdown = null; // fall back to full-month in generateRecommendation
          }
        } catch (err) {
          console.warn('Daily breakdown fetch failed (non-fatal):', err.message);
          postChangeWarning = `Budget changed on ${lastChange.changeDate} but daily breakdown unavailable — using full-month averages`;
        }
      }

      // Count new vehicle inventory
      const items = (inventoryResult && inventoryResult.items) || [];
      const newVehicleCount = items.filter(
        item => item.condition === 'NEW'
      ).length;

      const now = new Date();
      const recommendation = generateRecommendation({
        goal,
        campaignSpend: adjustedSpend,
        sharedBudgets,
        dedicatedBudgets,
        impressionShare,
        inventoryCount: newVehicleCount,
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        currentDay: now.getDate(),
        dailyBreakdown: dailyBreakdown || undefined,
        changeDate: lastChange.changeDate || undefined,
        excludeCampaigns: excludeNames,
      });

      const response = { customerId: customerId.replace(/-/g, ''), ...recommendation };
      if (postChangeAvg && postChangeAvg.daysTracked > 0) {
        response.postChangeAvg = postChangeAvg;
      }
      if (postChangeWarning) {
        response.postChangeWarning = postChangeWarning;
      }

      res.json(response);
    } catch (err) {
      console.error('Pacing error:', err.message);
      next(err);
    }
  });

  return router;
}

module.exports = { createPacingRouter, applySpendOverrides, findRedirectsTo, computePostChangeAvg };
