/**
 * Changes Routes — handles task parsing via Claude and change application.
 *
 * Called by: src/server.js (mounted at /api/*)
 * Calls: services/claude-parser.js, services/change-executor.js, services/google-ads.js
 *
 * Routes:
 *   POST /api/parse-task         → Send task to Claude, get structured change plan
 *   POST /api/apply-changes      → Execute changes against Google Ads API
 *   POST /api/export-changes-csv → Export change plan as Google Ads Editor CSV
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const claudeParser = require('../services/claude-parser');
const { applyChange } = require('../services/change-executor');
const { changesToRows, toCSV } = require('../services/csv-exporter');
const googleAds = require('../services/google-ads');
const { logAudit } = require('../utils/audit-log');

/**
 * Creates changes routes with the given config.
 *
 * @param {Object} config - App configuration from config.js
 * @returns {express.Router} Configured changes router
 */
function createChangesRouter(config) {
  const router = express.Router();

  // Parse a Freshdesk task into structured changes via Claude
  router.post('/api/parse-task', requireAuth, async (req, res, next) => {
    const { task, accountStructure, customerId, accountName } = req.body;
    if (!task || (typeof task === 'string' && !task.trim())) {
      return res.status(400).json({ error: 'No task provided' });
    }

    try {
      const plan = await claudeParser.parseTask(
        config.claude, task, accountStructure, accountName
      );

      logAudit({
        action:     'parse_task',
        email:      req.session.userEmail || 'unknown',
        customerId: customerId || null,
        accountName: accountName || null,
        changeCount: plan.changes?.length || 0,
      });

      res.json(plan);
    } catch (err) {
      logAudit({
        action:     'parse_task',
        email:      req.session.userEmail || 'unknown',
        customerId: customerId || null,
        error:      err.message,
      });
      console.error('Claude error:', err.response?.data || err.message);
      next(err);
    }
  });

  // Apply changes to Google Ads
  router.post('/api/apply-changes', requireAuth, async (req, res, next) => {
    const { changes, customerId, dryRun = true } = req.body;
    if (!Array.isArray(changes) || !customerId) {
      return res.status(400).json({ error: 'Missing changes or customerId' });
    }

    // Only explicit false triggers live run — safety default
    const isDryRun = dryRun !== false;

    try {
      const client = googleAds.createClient(
        config.googleAds,
        req.session.tokens.refresh_token,
        String(customerId),
        req.session.mccId
      );

      const results = [];
      const errors  = [];

      for (const change of changes) {
        try {
          const result = await applyChange(client, change, isDryRun);
          results.push({ change, result, success: true });
        } catch (err) {
          const msg = err.message || 'Unknown error';
          console.error(`Change failed [${change.type}] ${change.campaignName || ''}:`, msg);
          errors.push({ change, error: msg });
          results.push({ change, result: msg, success: false });
        }
      }

      const applied = results.filter(r => r.success).length;

      logAudit({
        action:     'apply_changes',
        email:      req.session.userEmail || 'unknown',
        customerId: String(customerId),
        dryRun:     isDryRun,
        applied,
        failed: errors.length,
        changes: changes.map(c => ({ type: c.type, campaign: c.campaignName })),
      });

      res.json({
        dryRun: isDryRun,
        applied,
        failed: errors.length,
        results,
        errors,
      });

    } catch (err) {
      logAudit({
        action:     'apply_changes',
        email:      req.session.userEmail || 'unknown',
        customerId: String(customerId),
        error:      err.message,
      });
      console.error('Apply error:', err.message);
      next(err);
    }
  });

  // Export change plan as Google Ads Editor CSV
  router.post('/api/export-changes-csv', requireAuth, (req, res) => {
    const { changes, accountName } = req.body;
    if (!Array.isArray(changes) || changes.length === 0) {
      return res.status(400).json({ error: 'Missing or empty changes array' });
    }

    const { rows, skipped } = changesToRows(changes);
    const csv = toCSV(rows);

    const safeName = (accountName || 'changes')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 50);
    const filename = `${safeName}_GoogleAds_Changes.csv`;

    res.json({
      csv,
      filename,
      rowCount: rows.length,
      skipped,
    });
  });

  return router;
}

module.exports = { createChangesRouter };
