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
const { generateRecommendation, findISCappedCampaignIds } = require('../services/budget-recommender');
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
        async update({ spreadsheetId, range, valueInputOption, resource }) {
          const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=${valueInputOption || 'RAW'}`;
          try {
            const res = await axios.put(url, resource, {
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            });
            return { data: res.data };
          } catch (err) {
            if (err.response) {
              console.error(`[SheetsClient] HTTP ${err.response.status} for update "${range}":`, JSON.stringify(err.response.data));
            }
            throw err;
          }
        },
      },
    },
  };
}

/**
 * Finds the override entry for an account name using flexible matching.
 * Matches if the override key is contained in the account name or vice versa.
 * This handles variations like "Alan Jay Auto" vs "Alan Jay Auto Group"
 * vs "Alan Jay Automotive Group" in Google Ads account names.
 *
 * @param {string} accountName - Lowercase account name
 * @returns {{ key: string, override: Object }|null}
 */
function findOverride(accountName) {
  if (!accountName) return null;
  // Exact match first
  if (ACCOUNT_OVERRIDES[accountName]) {
    return { key: accountName, override: ACCOUNT_OVERRIDES[accountName] };
  }
  // Flexible match: account name contains override key or vice versa
  for (const [key, override] of Object.entries(ACCOUNT_OVERRIDES)) {
    if (accountName.includes(key) || key.includes(accountName)) {
      return { key, override };
    }
  }
  return null;
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
  const match = findOverride(accountName);
  let filtered = campaignSpend;

  // Source account: remove excluded campaigns
  if (match && match.override.excludeCampaigns) {
    const excludeSet = new Set(match.override.excludeCampaigns.map(n => n.toLowerCase()));
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
 * Uses flexible matching for both source and target account names.
 *
 * @param {string} targetName - Lowercase account name
 * @returns {{ sourceAccount: string, campaignNames: string[] }[]}
 */
function findRedirectsTo(targetName) {
  const redirects = [];
  for (const [source, override] of Object.entries(ACCOUNT_OVERRIDES)) {
    if (!override.excludeCampaigns || !override.redirectSpendTo) continue;
    const target = override.redirectSpendTo;
    // Flexible match: target contains redirectSpendTo or vice versa
    if (target === targetName || targetName.includes(target) || target.includes(targetName)) {
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
 * Writes per-campaign search impression share data to the Google Sheet.
 * Finds the row matching the account name and writes IS data to column E onward.
 *
 * Column I: campaign IS summary (e.g., "Brand: 45.2% | VLA: 62.1%")
 *
 * @param {Object} sheetsClient - Sheets API client with values.update
 * @param {string} spreadsheetId - Google Sheets spreadsheet ID
 * @param {string} accountName - Lowercase account name to match
 * @param {Object[]} goals - Parsed goals (to find the row index)
 * @param {Object[]} campaignIS - Per-campaign IS data
 */
async function writeImpressionShareToSheet(sheetsClient, spreadsheetId, accountName, goals, campaignIS) {
  if (!sheetsClient?.spreadsheets?.values?.update || !spreadsheetId || !campaignIS?.length) return;

  // Find which row this account is in (goals array is 0-indexed, sheet rows start at 2)
  const rowIndex = goals.findIndex(g => g.dealerName.toLowerCase() === accountName);
  if (rowIndex < 0) return;

  const sheetRow = rowIndex + 2; // Row 1 is header, data starts at row 2

  // Build summary string: "Campaign: IS% (BLS%)" for each campaign
  const summary = campaignIS
    .map(c => {
      const bls = c.budgetLostShare != null ? ` (${c.budgetLostShare}% lost)` : '';
      return `${c.campaignName}: ${c.impressionShare}%${bls}`;
    })
    .join(' | ');

  const range = `PPC Spend Pace!I${sheetRow}`;

  try {
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      resource: { values: [[summary]] },
    });
  } catch (err) {
    // Log but don't throw — this is non-fatal
    console.warn(`[IS Write] Failed to write IS to row ${sheetRow}:`, err.message);
  }
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

      // Phase 1: Fetch all data in parallel — need change date before impression share
      const [campaignSpend, sharedBudgets, dedicatedBudgets, inventoryResult, goals, lastChange] =
        await Promise.all([
          googleAds.getMonthSpend(restCtx),
          googleAds.getSharedBudgets(restCtx),
          googleAds.getDedicatedBudgets(restCtx).catch(err => {
            console.warn('Dedicated budgets fetch failed (non-fatal):', err.message);
            return [];
          }),
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

      // Phase 2: Impression share — use post-change date range if a budget change exists
      const impressionShare = await googleAds.getImpressionShare(restCtx, lastChange.changeDate || undefined);

      // Find goal matching this account by name (case-insensitive, trimmed)
      const searchName = (accountName || '').trim().toLowerCase();
      const goal = goals.find(g => g.dealerName.toLowerCase() === searchName);

      if (!goal) {
        const hint = goals.length === 0
          ? 'Could not load goals from spreadsheet. Check Sheets permissions (re-login to grant spreadsheets scope).'
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
          const sourceAcct = accounts.find(a => {
            const n = (a.name || '').toLowerCase();
            return n === redirect.sourceAccount || n.includes(redirect.sourceAccount) || redirect.sourceAccount.includes(n);
          });
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
      const overrideMatch = findOverride(searchName);
      const excludeNames = overrideMatch ? overrideMatch.override.excludeCampaigns : [];

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

      // Vehicle inventory from VLA feed
      const newVehicleCount = (inventoryResult && inventoryResult.newCount) || 0;
      const usedVehicleCount = (inventoryResult && inventoryResult.usedCount) || 0;
      const inventorySource = (inventoryResult && inventoryResult.source) || 'none';

      // Geo expansion: fetch proximity targets + geographic performance for IS-capped campaigns
      let geoTargets = null;
      const isCappedIds = findISCappedCampaignIds(impressionShare, sharedBudgets);
      if (isCappedIds.length > 0) {
        try {
          const [proximityData, geoPerf] = await Promise.all([
            googleAds.getCampaignProximityTargets(restCtx, isCappedIds),
            googleAds.getGeographicPerformance(restCtx, isCappedIds),
          ]);

          // Build maps keyed by campaignId for easy lookup in recommender
          const proximityMap = new Map();
          for (const p of proximityData) {
            // Keep the one with the largest radius per campaign
            const existing = proximityMap.get(p.campaignId);
            if (!existing || p.radiusMiles > existing.radiusMiles) {
              proximityMap.set(p.campaignId, p);
            }
          }

          const nearbyMap = new Map();
          for (const g of geoPerf) {
            if (!nearbyMap.has(g.campaignId)) nearbyMap.set(g.campaignId, []);
            nearbyMap.get(g.campaignId).push(g);
          }

          geoTargets = { proximity: proximityMap, nearby: nearbyMap };
        } catch (err) {
          console.warn('Geo expansion data fetch failed (non-fatal):', err.message);
        }
      }

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
        geoTargets,
      });

      // Per-campaign impression share breakdown for the dashboard
      const campaignIS = (impressionShare || [])
        .filter(d => d.impressionShare != null)
        .map(d => ({
          campaignName: d.campaignName,
          impressionShare: Math.round(d.impressionShare * 1000) / 10,
          budgetLostShare: d.budgetLostShare != null ? Math.round(d.budgetLostShare * 1000) / 10 : null,
        }))
        .sort((a, b) => a.impressionShare - b.impressionShare);

      const response = { customerId: customerId.replace(/-/g, ''), ...recommendation, campaignIS };
      // Enrich inventory with used count and data source
      if (response.inventory) {
        response.inventory.usedCount = usedVehicleCount;
        response.inventory.source = inventorySource;
      }
      if (lastChange.changeDate) {
        response.changeDate = lastChange.changeDate;
      }
      if (postChangeAvg && postChangeAvg.daysTracked > 0) {
        response.postChangeAvg = postChangeAvg;
      }
      if (postChangeWarning) {
        response.postChangeWarning = postChangeWarning;
      }

      // Write impression share back to Google Sheet (non-blocking, non-fatal)
      writeImpressionShareToSheet(activeSheets, spreadsheetId, searchName, goals, campaignIS)
        .catch(err => console.warn('IS sheet write failed (non-fatal):', err.message));

      res.json(response);
    } catch (err) {
      console.error('Pacing error:', err.message);
      next(err);
    }
  });

  return router;
}

module.exports = { createPacingRouter, applySpendOverrides, findRedirectsTo, findOverride, computePostChangeAvg };
