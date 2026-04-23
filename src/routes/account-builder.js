/**
 * Account Builder v2 Routes — paste-URL-driven account generator.
 *
 * Mounted by: src/server.js
 * Calls: src/services/account-builder-v2.js, src/utils/csv-utils.js
 *
 * Routes:
 *   POST /api/account-builder/plan   → { url, notes } → plan summary + warnings
 *   POST /api/account-builder/csv    → { url, notes } → text/csv Ads Editor file
 *
 * No Google Ads OAuth needed (CSV output only, no API mutations). Uses
 * requireAuth so only logged-in operators can trigger Claude web_search
 * (which costs API tokens).
 */

'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { buildAccountPlan } = require('../services/account-builder-v2');
const { COLS } = require('../utils/ads-editor-columns');

/**
 * Serializes rows[] into Ads Editor CSV text.
 * Uses the canonical column order from ads-editor-columns.
 *
 * @param {Array<object>} rows
 * @returns {string}
 */
function rowsToCsv(rows) {
  const cols = COLS;
  const lines = [cols.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(cols.map(c => escapeCell(row[c] ?? '')).join(','));
  }
  return lines.join('\r\n');
}

function escapeCell(v) {
  const s = String(v ?? '');
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function sanitizeFilename(name) {
  return String(name || 'dealer')
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'dealer';
}

/**
 * Creates the Account Builder v2 router.
 *
 * @param {object} config - App config (for claude api key)
 * @returns {express.Router}
 */
function createAccountBuilderRouter(config) {
  const router = express.Router();

  router.post('/api/account-builder/plan', requireAuth, async (req, res, next) => {
    try {
      const { url, notes } = req.body || {};
      if (!url || typeof url !== 'string' || !url.trim()) {
        return res.status(400).json({ error: 'url is required' });
      }

      const result = await buildAccountPlan(
        { url: url.trim(), notes: notes || '' },
        config.claude
      );

      // Don't ship the full rows[] in plan response — heavy.
      res.json({
        plan:     result.plan,
        profile:  result.profile,
        groups:   result.groups,
        warnings: result.warnings,
      });
    } catch (err) {
      // Operator-facing errors get 400; system errors get 500
      const status = /could not resolve make|url is required/i.test(err.message) ? 400 : 500;
      if (status === 500) {
        console.error('[account-builder] plan failed:', err.message);
      }
      res.status(status).json({ error: err.message });
    }
  });

  router.post('/api/account-builder/csv', requireAuth, async (req, res, next) => {
    try {
      const { url, notes } = req.body || {};
      if (!url || typeof url !== 'string' || !url.trim()) {
        return res.status(400).json({ error: 'url is required' });
      }

      const result = await buildAccountPlan(
        { url: url.trim(), notes: notes || '' },
        config.claude
      );

      const csv = rowsToCsv(result.rows);
      const filename = sanitizeFilename(result.profile.dealerName) + '_ads_editor.csv';

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (err) {
      const status = /could not resolve make|url is required/i.test(err.message) ? 400 : 500;
      if (status === 500) {
        console.error('[account-builder] csv failed:', err.message);
      }
      res.status(status).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createAccountBuilderRouter, _internal: { rowsToCsv, sanitizeFilename } };
