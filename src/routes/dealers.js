/**
 * Dealers Routes — CRUD API for dealer goals admin UI.
 *
 * Mounted by: src/server.js
 *
 * Routes:
 *   GET    /api/dealers                          → list all dealers
 *   POST   /api/dealers                          → create dealer
 *   PATCH  /api/dealers/:dealerName              → update non-budget fields
 *   PUT    /api/dealers/:dealerName/budget        → update monthly budget (requires note)
 *   DELETE /api/dealers/:dealerName              → delete dealer
 *   GET    /api/dealers/:dealerName/history      → budget change history
 *   POST   /api/dealers/import-from-sheet        → one-time sheet-to-DB import
 */

const express = require('express');
const axios = require('axios');
const { requireAuth } = require('../middleware/auth');
const store = require('../services/dealer-goals-store');
const googleAds = require('../services/google-ads');

/**
 * Creates a lightweight Google Sheets client from an OAuth access token.
 * Mirrors the identical helper in routes/pacing.js.
 *
 * @param {string} accessToken - OAuth2 access token
 * @returns {Object} Sheets-compatible client
 */
function createSheetsClient(accessToken) {
  return {
    spreadsheets: {
      values: {
        async get({ spreadsheetId, range }) {
          const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
          const res = await axios.get(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          return { data: res.data };
        },
      },
    },
  };
}

/**
 * Returns true if any of the fields that matter for the import diff have changed.
 *
 * @param {object} existing - Goal currently in DB
 * @param {object} incoming - Goal from the sheet
 * @returns {boolean}
 */
function didAnyFieldChange(existing, incoming) {
  return (
    existing.monthlyBudget !== incoming.monthlyBudget ||
    existing.newBudget     !== incoming.newBudget     ||
    existing.usedBudget    !== incoming.usedBudget    ||
    existing.miscNotes     !== incoming.miscNotes     ||
    existing.pacingMode    !== incoming.pacingMode    ||
    existing.pacingCurveId !== incoming.pacingCurveId
  );
}

/**
 * Creates the dealers router.
 *
 * @param {Object} [config] - App configuration from config.js (needed for import route)
 * @returns {express.Router}
 */
function createDealersRouter(config) {
  const router = express.Router();

  // ── GET /api/dealers ─────────────────────────────────────────────────────────
  router.get('/api/dealers', requireAuth, async (req, res, next) => {
    try {
      await store.loadAll();
      const dealers = store.allGoals();
      res.json({ dealers });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/dealers ─────────────────────────────────────────────────────────
  router.post('/api/dealers', requireAuth, async (req, res, next) => {
    try {
      const {
        dealerName,
        monthlyBudget,
        newBudget,
        usedBudget,
        miscNotes,
        pacingMode,
        pacingCurveId,
        vlaBudget,
        keywordBudget,
      } = req.body || {};

      if (!dealerName || String(dealerName).trim() === '') {
        return res.status(400).json({ error: 'dealerName is required and must not be blank' });
      }
      const budget = parseFloat(monthlyBudget);
      if (!Number.isFinite(budget) || budget <= 0) {
        return res.status(400).json({ error: 'monthlyBudget must be a positive number' });
      }

      const updatedBy = req.session.userEmail || 'unknown';

      const goal = await store.upsertGoal({
        dealerName: String(dealerName).trim(),
        monthlyBudget: budget,
        newBudget:     newBudget     != null ? parseFloat(newBudget)     : null,
        usedBudget:    usedBudget    != null ? parseFloat(usedBudget)    : null,
        miscNotes:     miscNotes     ?? null,
        pacingMode:    pacingMode    ?? 'one_click',
        pacingCurveId: pacingCurveId ?? null,
        vlaBudget:     vlaBudget     != null ? parseFloat(vlaBudget)     : null,
        keywordBudget: keywordBudget != null ? parseFloat(keywordBudget) : null,
        updatedBy,
      });

      res.status(201).json({ dealer: goal });
    } catch (err) {
      next(err);
    }
  });

  // ── PATCH /api/dealers/:dealerName ────────────────────────────────────────────
  // Updates non-budget fields only. Does NOT touch monthlyBudget.
  router.patch('/api/dealers/:dealerName', requireAuth, async (req, res, next) => {
    try {
      const dealerName = decodeURIComponent(req.params.dealerName);

      // Load current state
      await store.loadAll();
      const current = store.allGoals().find(g => g.dealerName === dealerName);
      if (!current) {
        return res.status(404).json({ error: `Dealer not found: ${dealerName}` });
      }

      const {
        pacingMode,
        pacingCurveId,
        miscNotes,
        newBudget,
        usedBudget,
        vlaBudget,
        keywordBudget,
      } = req.body || {};

      const updatedBy = req.session.userEmail || 'unknown';

      // Merge patch fields over current state; keep monthlyBudget unchanged
      const merged = {
        dealerName:    current.dealerName,
        monthlyBudget: current.monthlyBudget,
        newBudget:     newBudget     !== undefined ? (newBudget     != null ? parseFloat(newBudget)     : null) : current.newBudget,
        usedBudget:    usedBudget    !== undefined ? (usedBudget    != null ? parseFloat(usedBudget)    : null) : current.usedBudget,
        miscNotes:     miscNotes     !== undefined ? miscNotes     : current.miscNotes,
        pacingMode:    pacingMode    !== undefined ? pacingMode    : current.pacingMode,
        pacingCurveId: pacingCurveId !== undefined ? pacingCurveId : current.pacingCurveId,
        vlaBudget:     vlaBudget     !== undefined ? (vlaBudget    != null ? parseFloat(vlaBudget)     : null) : current.vlaBudget,
        keywordBudget: keywordBudget !== undefined ? (keywordBudget != null ? parseFloat(keywordBudget) : null) : current.keywordBudget,
        updatedBy,
      };

      const goal = await store.upsertGoal(merged);
      res.json({ dealer: goal });
    } catch (err) {
      next(err);
    }
  });

  // ── PUT /api/dealers/:dealerName/budget ───────────────────────────────────────
  // Updates monthly budget. Requires a note (min 5 chars). Writes audit entry.
  router.put('/api/dealers/:dealerName/budget', requireAuth, async (req, res, next) => {
    try {
      const dealerName = decodeURIComponent(req.params.dealerName);
      const { monthlyBudget, note } = req.body || {};

      // Server-side validation (store also validates, but return 400 with helpful msg)
      if (!note || String(note).trim().length < 5) {
        return res.status(400).json({
          error: 'note is required and must be at least 5 characters',
        });
      }
      const budget = parseFloat(monthlyBudget);
      if (!Number.isFinite(budget) || budget <= 0) {
        return res.status(400).json({
          error: 'monthlyBudget must be a positive number',
        });
      }

      const changedBy = req.session.userEmail || 'unknown';

      try {
        await store.updateMonthlyBudget(dealerName, budget, String(note).trim(), changedBy);
      } catch (storeErr) {
        if (storeErr.message && storeErr.message.includes('not found')) {
          return res.status(404).json({ error: storeErr.message });
        }
        throw storeErr;
      }

      res.json({ updated: true });
    } catch (err) {
      next(err);
    }
  });

  // ── DELETE /api/dealers/:dealerName ───────────────────────────────────────────
  router.delete('/api/dealers/:dealerName', requireAuth, async (req, res, next) => {
    try {
      const dealerName = decodeURIComponent(req.params.dealerName);

      // Check existence before deleting
      await store.loadAll();
      const exists = store.allGoals().some(g => g.dealerName === dealerName);
      if (!exists) {
        return res.status(404).json({ error: `Dealer not found: ${dealerName}` });
      }

      await store.deleteGoal(dealerName);
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/dealers/:dealerName/history ──────────────────────────────────────
  router.get('/api/dealers/:dealerName/history', requireAuth, async (req, res, next) => {
    try {
      const dealerName = decodeURIComponent(req.params.dealerName);
      const history = await store.getBudgetHistory(dealerName);
      res.json({ history });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/dealers/import-from-sheet ───────────────────────────────────────
  // One-time migration: reads all goals from the Google Sheet and upserts into DB.
  // Idempotent — safe to run multiple times. Always reads from the Sheet regardless
  // of the USE_DB_GOALS flag (uses readGoalsFromSheet directly).
  router.post('/api/dealers/import-from-sheet', requireAuth, async (req, res, next) => {
    try {
      // Resolve config: prefer injected (tests / server.js), fall back to inline-require
      const cfg = config || (() => {
        const { validateEnv } = require('../utils/config');
        return validateEnv();
      })();

      // Config object doesn't namespace googleSheets — same pattern as other
      // sheet-consuming routes (auth.js, budget-adjustments.js) uses process.env
      // directly.
      const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
      if (!spreadsheetId) {
        return res.status(500).json({ error: 'GOOGLE_SHEETS_SPREADSHEET_ID not configured' });
      }

      // Get an access token using the authenticated session's refresh token
      const accessToken = await googleAds.refreshAccessToken(
        cfg.googleAds,
        req.session.tokens.refresh_token
      );
      const sheetsClient = createSheetsClient(accessToken);

      // Force sheet path — never hits DB regardless of USE_DB_GOALS flag
      const { readGoalsFromSheet } = require('../services/goal-reader');
      let sheetGoals;
      try {
        sheetGoals = await readGoalsFromSheet(sheetsClient, spreadsheetId);
      } catch (err) {
        console.error('[dealers] import-from-sheet sheet fetch failed:', err.message);
        return res.status(500).json({ error: `Sheet fetch failed: ${err.message}` });
      }

      // Snapshot current DB state for diff classification
      const dbGoals = await store.loadAll();
      const existing = new Map(dbGoals.map(g => [g.dealerName.toLowerCase(), g]));

      const created = [];
      const updated = [];
      const skipped = [];

      for (const sg of sheetGoals) {
        try {
          const key = sg.dealerName.toLowerCase();
          const existingGoal = existing.get(key);

          const goal = {
            dealerName:    sg.dealerName,
            monthlyBudget: sg.monthlyBudget,
            newBudget:     sg.newBudget     || null,
            usedBudget:    sg.usedBudget    || null,
            miscNotes:     sg.dealerNotes   || null,
            pacingMode:    sg.pacingMode    || 'one_click',
            pacingCurveId: sg.pacingCurveId || null,
            // Budget splits not in sheet's A:G range — leave null
            vlaBudget:     null,
            keywordBudget: null,
          };

          if (!existingGoal) {
            await store.upsertGoal(goal);
            created.push(sg.dealerName);
          } else if (didAnyFieldChange(existingGoal, goal)) {
            await store.upsertGoal(goal);
            updated.push(sg.dealerName);
          } else {
            skipped.push({ name: sg.dealerName, reason: 'no changes' });
          }
        } catch (err) {
          skipped.push({ name: sg.dealerName, reason: err.message });
        }
      }

      res.json({
        imported: created.length + updated.length,
        created,
        updated,
        skipped,
      });
    } catch (err) {
      console.error('[dealers] import-from-sheet failed:', err.message);
      next(err);
    }
  });

  return router;
}

module.exports = { createDealersRouter };
