/**
 * Changes Routes — handles task parsing via Claude and change application.
 *
 * Called by: src/server.js (mounted at /api/*)
 * Calls: services/claude-parser.js, services/change-executor.js, services/google-ads.js
 *
 * Routes:
 *   POST /api/parse-task     → Send task to Claude, get structured change plan
 *   POST /api/apply-changes  → Execute changes against Google Ads API
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const claudeParser = require('../services/claude-parser');
const { applyChange } = require('../services/change-executor');
const googleAds = require('../services/google-ads');

const router = express.Router();

/**
 * Creates changes routes with the given config.
 *
 * @param {Object} config - App configuration from config.js
 * @returns {express.Router} Configured changes router
 */
function createChangesRouter(config) {

  // Parse a Freshdesk task into structured changes via Claude
  router.post('/api/parse-task', requireAuth, async (req, res, next) => {
    const { task, accountStructure, customerId, accountName } = req.body;
    if (!task) return res.status(400).json({ error: 'No task provided' });

    try {
      const plan = await claudeParser.parseTask(
        config.claude, task, accountStructure, accountName
      );
      res.json(plan);
    } catch (err) {
      console.error('Claude error:', err.response?.data || err.message);
      next(err);
    }
  });

  // Apply changes to Google Ads
  router.post('/api/apply-changes', requireAuth, async (req, res, next) => {
    const { changes, customerId, dryRun = true } = req.body;
    if (!changes || !customerId) {
      return res.status(400).json({ error: 'Missing changes or customerId' });
    }

    try {
      const client = googleAds.createClient(
        config.googleAds,
        req.session.tokens.refresh_token,
        customerId,
        req.session.mccId
      );

      const results = [];
      const errors  = [];

      for (const change of changes) {
        try {
          const result = await applyChange(client, change, dryRun);
          results.push({ change, result, success: true });
        } catch (err) {
          const msg = err.message || 'Unknown error';
          errors.push({ change, error: msg });
          results.push({ change, result: msg, success: false });
        }
      }

      res.json({
        dryRun,
        applied: results.filter(r => r.success).length,
        failed:  errors.length,
        results,
        errors,
      });

    } catch (err) {
      console.error('Apply error:', err.message);
      next(err);
    }
  });

  return router;
}

module.exports = { createChangesRouter };
