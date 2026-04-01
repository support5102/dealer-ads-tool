/**
 * Budget Adjustments Routes — scan, review, approve, and execute budget changes.
 *
 * Called by: src/server.js
 * Calls: pacing-fetcher, pacing-detector, adjustment-generator, change-executor,
 *        adjustment-store, google-ads, goal-reader, audit-log
 *
 * Routes:
 *   POST /api/budget-adjustments/scan           → Trigger detection scan across accounts
 *   GET  /api/budget-adjustments/pending         → List pending adjustments
 *   GET  /api/budget-adjustments/:id             → Get single adjustment detail
 *   POST /api/budget-adjustments/:id/approve     → Approve + execute
 *   POST /api/budget-adjustments/:id/reject      → Reject with optional reason
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { fetchAccountPacing } = require('../services/pacing-fetcher');
const { detectInterventions } = require('../services/pacing-detector');
const { generateExecutableAdjustments } = require('../services/adjustment-generator');
const { store, STATUSES } = require('../services/adjustment-store');
const { readGoals } = require('../services/goal-reader');
const googleAds = require('../services/google-ads');
const { calculatePacing } = require('../services/pacing-calculator');
const { logAudit } = require('../utils/audit-log');
const changeHistory = require('../services/change-history');
const dealerContextStore = require('../services/dealer-context-store');
const { extractDealerContext } = require('../services/dealer-context-extractor');

/**
 * Creates a lightweight Google Sheets client from an access token.
 * Same pattern as pacing.js — thin REST wrapper, no googleapis dependency.
 */
function createSheetsClient(accessToken) {
  return {
    spreadsheets: {
      values: {
        async get({ spreadsheetId, range }) {
          const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
          const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
          if (!resp.ok) throw new Error(`Sheets API error: ${resp.status}`);
          return { data: await resp.json() };
        },
      },
    },
  };
}

/**
 * Creates budget adjustment routes.
 * @param {Object} config - App configuration
 * @param {Object} [deps] - Injectable dependencies for testing
 * @param {Object} [deps.sheetsClient] - Google Sheets API client
 * @param {string} [deps.spreadsheetId] - Google Sheets spreadsheet ID
 * @returns {express.Router}
 */
function createBudgetAdjustmentsRouter(config, deps = {}) {
  const router = express.Router();
  const sheetsClient = deps.sheetsClient || null;
  const spreadsheetId = deps.spreadsheetId || process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '';

  // ── POST /api/budget-adjustments/scan ──
  // Scans all accounts, detects pacing issues, generates adjustment recommendations
  router.post('/api/budget-adjustments/scan', requireAuth, async (req, res, next) => {
    try {
      const accounts = req.session.accounts || [];
      const mccId = req.session.mccId;

      if (!accounts.length || !req.session.tokens?.access_token) {
        return res.status(400).json({ error: 'No accounts connected. Please select an account first.' });
      }

      // Early-month guard: skip if before day 5
      const currentDay = new Date().getDate();
      if (currentDay < 5) {
        return res.json({
          flagged: [],
          adjustments: [],
          message: 'Too early in the month for reliable pacing detection (day < 5).',
        });
      }

      // Refresh token
      const accessToken = await googleAds.refreshAccessToken(config.googleAds, req.session.tokens.refresh_token);
      req.session.tokens.access_token = accessToken;

      // Fetch goals from Google Sheets
      const activeSheets = sheetsClient || createSheetsClient(accessToken);
      const goals = await readGoals(activeSheets, spreadsheetId);

      // Match accounts to goals
      const matched = [];
      for (const account of accounts) {
        const goal = goals.find(g =>
          g.dealerName.trim().toLowerCase() === account.name.trim().toLowerCase()
        );
        if (goal && goal.monthlyBudget > 0) {
          matched.push({ account, goal });
        }
      }

      if (matched.length === 0) {
        return res.json({ flagged: [], adjustments: [], message: 'No accounts with budgets found.' });
      }

      // Extract dealer context from Sheet notes in parallel (best-effort, non-blocking)
      if (config.claude?.apiKey) {
        const contextPromises = matched
          .filter(({ goal }) => goal.dealerNotes)
          .map(({ account, goal }) =>
            extractDealerContext(config.claude, goal.dealerName, goal.dealerNotes)
              .then(ctx => dealerContextStore.save(account.id, ctx))
              .catch(() => {}) // best-effort
          );
        await Promise.allSettled(contextPromises);
      }

      // Fetch pacing for all matched accounts
      const pacingResults = [];
      const BATCH_SIZE = 6;
      for (let i = 0; i < matched.length; i += BATCH_SIZE) {
        const batch = matched.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.allSettled(
          batch.map(({ account, goal }) =>
            fetchAccountPacing({
              account, goal, accessToken,
              developerToken: config.googleAds.developerToken,
              loginCustomerId: mccId,
            })
          )
        );
        for (const result of batchResults) {
          if (result.status === 'fulfilled') pacingResults.push(result.value);
        }
      }

      // Detect which accounts need intervention
      const flagged = detectInterventions(pacingResults);

      if (flagged.length === 0) {
        return res.json({ flagged: [], adjustments: [], message: 'All accounts pacing within acceptable range.' });
      }

      // For each flagged account, generate adjustment recommendations
      const adjustmentBatches = [];
      for (const account of flagged) {
        try {
          const matchedEntry = matched.find(m => m.account.id === account.customerId);
          if (!matchedEntry) continue;

          const restCtx = {
            accessToken,
            developerToken: config.googleAds.developerToken,
            customerId: account.customerId.replace(/-/g, ''),
            loginCustomerId: mccId,
          };

          // Fetch budget structures and IS data needed for recommendations
          const [dedicatedBudgets, sharedBudgets, impressionShare, campaignSpend, inventory] = await Promise.all([
            googleAds.getDedicatedBudgets(restCtx),
            googleAds.getSharedBudgets(restCtx),
            googleAds.getImpressionShare(restCtx, account.changeDate),
            googleAds.getMonthSpend(restCtx),
            googleAds.getInventory(restCtx),
          ]);

          // Build inventory by model from campaign names + total inventory
          // (Phase 1 limitation: we use total inventory distributed by VLA campaign count)
          const inventoryByModel = buildInventoryByModel(dedicatedBudgets, inventory);

          // Calculate pacing for adjustment generator
          const now = new Date();
          const mtdSpend = campaignSpend.reduce((sum, c) => sum + c.spend, 0);
          const pacing = calculatePacing({
            monthlyBudget: matchedEntry.goal.monthlyBudget,
            spendToDate: mtdSpend,
            year: now.getFullYear(),
            month: now.getMonth() + 1,
            currentDay: now.getDate(),
            currentInventory: inventory.totalCount,
            baselineInventory: matchedEntry.goal.baselineInventory,
          });

          // Build spend map
          const daysElapsed = pacing.daysElapsed || 1;
          const spendMap = new Map();
          for (const c of campaignSpend) {
            spendMap.set(String(c.campaignId), c.spend / daysElapsed);
          }

          const batch = generateExecutableAdjustments({
            customerId: account.customerId,
            dealerName: account.dealerName,
            pacing,
            dedicatedBudgets,
            sharedBudgets,
            campaignSpend,
            impressionShareData: impressionShare,
            inventoryByModel,
            spendMap,
            direction: account.direction,
            dealerContext: dealerContextStore.getContext(account.customerId),
          });

          if (batch.adjustments.length > 0) {
            // Expire any existing pending adjustments for this account (supersede)
            const existing = store.listForAccount(account.customerId);
            for (const old of existing) {
              store.reject(old.adjustmentId, 'system', 'Superseded by new scan');
            }
            store.save(batch);
            adjustmentBatches.push({
              adjustmentId: batch.adjustmentId,
              customerId: batch.customerId,
              dealerName: batch.dealerName,
              direction: batch.direction,
              urgency: account.urgency,
              reasons: account.reasons,
              adjustmentCount: batch.adjustments.length,
              summary: batch.summary,
              expiresAt: batch.expiresAt,
            });
          }
        } catch (err) {
          console.warn(`Failed to generate adjustments for ${account.dealerName}:`, err.message);
        }
      }

      logAudit({
        action: 'budget_scan',
        email: req.session.userEmail || 'unknown',
        accountsScanned: pacingResults.length,
        accountsFlagged: flagged.length,
        adjustmentsGenerated: adjustmentBatches.length,
      });

      res.json({
        flagged: flagged.map(f => ({
          customerId: f.customerId,
          dealerName: f.dealerName,
          direction: f.direction,
          urgency: f.urgency,
          reasons: f.reasons,
          paceVariance: f.paceVariance,
        })),
        adjustments: adjustmentBatches,
        message: `Found ${flagged.length} account(s) needing adjustment.`,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/budget-adjustments/pending ──
  router.get('/api/budget-adjustments/pending', requireAuth, (req, res) => {
    const pending = store.list(STATUSES.PENDING);
    res.json({ adjustments: pending });
  });

  // ── GET /api/budget-adjustments/:id ──
  router.get('/api/budget-adjustments/:id', requireAuth, (req, res) => {
    const batch = store.get(req.params.id);
    if (!batch) return res.status(404).json({ error: 'Adjustment not found' });
    res.json(batch);
  });

  // ── POST /api/budget-adjustments/:id/approve ──
  // Approves and executes budget changes
  router.post('/api/budget-adjustments/:id/approve', requireAuth, async (req, res, next) => {
    try {
      const email = req.session.userEmail || 'unknown';

      // Pre-check: batch must exist and be pending before we do anything
      const pendingBatch = store.get(req.params.id);
      if (!pendingBatch || pendingBatch.status !== STATUSES.PENDING) {
        return res.status(400).json({
          error: 'Cannot approve — adjustment is not pending (may have expired or already been processed).',
        });
      }

      // Refresh access token (may be stale if time passed since scan)
      const accessToken = await googleAds.refreshAccessToken(config.googleAds, req.session.tokens.refresh_token);
      req.session.tokens.access_token = accessToken;
      const mccId = req.session.mccId;
      const restCtx = {
        accessToken,
        developerToken: config.googleAds.developerToken,
        customerId: pendingBatch.customerId.replace(/-/g, ''),
        loginCustomerId: mccId,
      };

      // Staleness check BEFORE transitioning to approved
      const [currentDedicated, currentShared] = await Promise.all([
        googleAds.getDedicatedBudgets(restCtx),
        googleAds.getSharedBudgets(restCtx),
      ]);

      const currentBudgets = new Map();
      for (const b of currentDedicated) currentBudgets.set(b.resourceName, b.dailyBudget);
      for (const b of currentShared) currentBudgets.set(b.resourceName, b.dailyBudget);

      const staleAdjustments = [];
      for (const adj of pendingBatch.adjustments) {
        const currentBudget = currentBudgets.get(adj.resourceName);
        if (currentBudget != null && Math.abs(currentBudget - adj.currentDailyBudget) > 1) {
          staleAdjustments.push({
            target: adj.target,
            expectedBudget: adj.currentDailyBudget,
            actualBudget: currentBudget,
          });
        }
      }

      if (staleAdjustments.length > 0) {
        logAudit({
          action: 'budget_adjustment_stale',
          email,
          customerId: pendingBatch.customerId,
          adjustmentId: pendingBatch.adjustmentId,
          staleCount: staleAdjustments.length,
        });
        return res.status(409).json({
          error: 'Stale recommendation — budgets have changed since this scan. Please re-scan.',
          staleAdjustments,
        });
      }

      // Now transition to approved (staleness check passed)
      const batch = store.approve(req.params.id, email);
      if (!batch) {
        // Race: another request approved/rejected between our check and here
        return res.status(400).json({ error: 'Adjustment was modified by another request.' });
      }

      // Execute budget changes
      const client = googleAds.createClient(
        config.googleAds,
        req.session.tokens.refresh_token,
        batch.customerId.replace(/-/g, ''),
        mccId
      );

      const results = { applied: 0, failed: 0, details: [] };

      for (const adj of batch.adjustments) {
        try {
          // Use resourceName directly instead of looking up by campaign name
          const newAmountMicros = Math.round(adj.recommendedDailyBudget * 1_000_000);
          const previousAmountMicros = Math.round(adj.currentDailyBudget * 1_000_000);

          await client.campaignBudgets.update([{
            resource_name: adj.resourceName,
            amount_micros: newAmountMicros,
          }]);

          results.applied++;
          results.details.push({
            target: adj.target,
            previousBudget: adj.currentDailyBudget,
            newBudget: adj.recommendedDailyBudget,
            change: adj.change,
            success: true,
          });
          changeHistory.addEntry({
            action: 'budget_change',
            userEmail: email,
            accountId: batch.customerId,
            dealerName: batch.dealerName,
            details: { campaignName: adj.target, previousValue: `$${adj.currentDailyBudget}/day`, newValue: `$${adj.recommendedDailyBudget}/day`, reason: batch.direction },
            source: 'auto_adjuster',
            success: true,
          });
        } catch (err) {
          results.failed++;
          results.details.push({
            target: adj.target,
            error: err.message,
            success: false,
          });
          changeHistory.addEntry({
            action: 'budget_change',
            userEmail: email,
            accountId: batch.customerId,
            dealerName: batch.dealerName,
            details: { campaignName: adj.target, reason: batch.direction },
            source: 'auto_adjuster',
            success: false,
            error: err.message,
          });
        }
      }

      store.recordExecution(batch.adjustmentId, results);

      logAudit({
        action: 'budget_adjustment_execute',
        email,
        customerId: batch.customerId,
        dealerName: batch.dealerName,
        adjustmentId: batch.adjustmentId,
        direction: batch.direction,
        applied: results.applied,
        failed: results.failed,
        changes: results.details.map(d => ({
          target: d.target,
          previousBudget: d.previousBudget,
          newBudget: d.newBudget,
          success: d.success,
        })),
      });

      res.json({
        message: `Executed ${results.applied} of ${batch.adjustments.length} budget changes.`,
        results,
        batch: store.get(batch.adjustmentId),
      });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/budget-adjustments/:id/reject ──
  router.post('/api/budget-adjustments/:id/reject', requireAuth, (req, res) => {
    const email = req.session.userEmail || 'unknown';
    const reason = req.body.reason || null;
    const batch = store.reject(req.params.id, email, reason);

    if (!batch) {
      return res.status(400).json({
        error: 'Cannot reject — adjustment is not pending.',
      });
    }

    logAudit({
      action: 'budget_adjustment_reject',
      email,
      customerId: batch.customerId,
      adjustmentId: batch.adjustmentId,
      reason,
    });

    res.json({ message: 'Adjustment rejected.', batch });
  });

  return router;
}

/**
 * Builds an inventory-by-model map from VLA campaign names and total inventory.
 * Distributes total inventory proportionally across detected models.
 *
 * @param {Object[]} dedicatedBudgets - From getDedicatedBudgets()
 * @param {Object} inventory - From getInventory() { totalCount }
 * @returns {Object} Map of model → estimated count
 */
function buildInventoryByModel(dedicatedBudgets, inventory) {
  const { classifyCampaign, extractModel, CAMPAIGN_TYPES } = require('../services/campaign-classifier');
  const totalCount = inventory?.totalCount || 0;
  if (totalCount === 0) return {};

  // Find all VLA campaigns and extract model names
  const models = new Set();
  for (const b of (dedicatedBudgets || [])) {
    const type = classifyCampaign(b.campaignName, b.channelType);
    if (type === CAMPAIGN_TYPES.VLA) {
      const model = extractModel(b.campaignName);
      if (model) models.add(model);
    }
  }

  if (models.size === 0) return {};

  // Distribute total inventory evenly across models as a baseline estimate
  // (Real per-model inventory would come from a feed/sheet in a future phase)
  const perModel = Math.round(totalCount / models.size);
  const result = {};
  for (const model of models) {
    result[model] = perModel;
  }
  return result;
}

module.exports = { createBudgetAdjustmentsRouter, buildInventoryByModel };
