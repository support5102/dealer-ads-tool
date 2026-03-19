/**
 * Audit Routes — account health auditor API.
 *
 * Called by: src/server.js (mounted at /api/*)
 * Calls: services/audit-engine.js, services/audit-store.js, services/google-ads.js
 *
 * Routes:
 *   POST /api/audit/run?customerId=X     → Run audit on one account, store result
 *   GET  /api/audit/results?customerId=X → Get latest audit result for one account
 *   GET  /api/audit/results/all          → Get latest audit results for all accounts
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { runAudit } = require('../services/audit-engine');
const auditStore = require('../services/audit-store');
const googleAds = require('../services/google-ads');

/**
 * Creates audit routes.
 *
 * @param {Object} config - App configuration from config.js
 * @returns {express.Router} Configured audit router
 */
function createAuditRouter(config) {
  const router = express.Router();

  /**
   * POST /api/audit/run?customerId=X
   * Runs a full health audit on the specified Google Ads account.
   */
  router.post('/api/audit/run', requireAuth, async (req, res, next) => {
    const { customerId } = req.query;

    if (!customerId) {
      return res.status(400).json({ error: 'Missing customerId query parameter.' });
    }

    const cleanId = customerId.replace(/-/g, '');
    if (!/^\d{7,10}$/.test(cleanId)) {
      return res.status(400).json({ error: 'Invalid customerId format. Expected 7-10 digit Google Ads ID.' });
    }

    try {
      const mccId = req.session.mccId || config.googleAds.mccId;
      const accessToken = await googleAds.refreshAccessToken(
        config.googleAds,
        req.session.tokens.refresh_token
      );
      req.session.tokens.access_token = accessToken;

      const restCtx = {
        accessToken,
        developerToken: config.googleAds.developerToken,
        customerId: cleanId,
        loginCustomerId: mccId,
      };

      const result = await runAudit(restCtx, req.body || {});

      // Store the result
      auditStore.save(restCtx.customerId, result);

      res.json(result);
    } catch (err) {
      console.error('Audit run error:', err.message);
      next(err);
    }
  });

  /**
   * GET /api/audit/results?customerId=X
   * Returns the latest stored audit result for one account.
   */
  router.get('/api/audit/results', requireAuth, async (req, res) => {
    const { customerId } = req.query;

    if (!customerId) {
      return res.status(400).json({ error: 'Missing customerId query parameter.' });
    }

    const cleanId = customerId.replace(/-/g, '');
    const result = auditStore.getLatest(cleanId);

    if (!result) {
      return res.status(404).json({
        error: `No audit results found for account ${customerId}. Run an audit first.`,
        customerId: cleanId,
      });
    }

    res.json({ customerId: cleanId, ...result });
  });

  /**
   * GET /api/audit/results/all
   * Returns the latest audit result for all previously audited accounts.
   */
  router.get('/api/audit/results/all', requireAuth, async (req, res) => {
    const results = auditStore.getAllLatest();
    res.json({ accounts: results, total: results.length });
  });

  return router;
}

module.exports = { createAuditRouter };
