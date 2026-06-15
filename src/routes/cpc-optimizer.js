/**
 * CPC Optimizer Routes — MCC-wide CPC opportunity scan.
 *
 * Mounted by: src/server.js at /
 * Calls:      services/cpc-optimizer-scan.js, services/google-ads.js
 *
 * Routes:
 *   GET /api/cpc-optimizer/scan  — Returns flagged campaigns across all dealers.
 *                                  Default behaviour: refresh token, walk the
 *                                  MCC, hit each dealer's campaign metrics
 *                                  query in parallel.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const googleAds = require('../services/google-ads');
const { scanCpcOptimizer } = require('../services/cpc-optimizer-scan');

function createCpcOptimizerRouter(config) {
  const router = express.Router();

  router.get('/api/cpc-optimizer/scan', requireAuth, async (req, res, next) => {
    try {
      const refreshToken = req.session.tokens && req.session.tokens.refresh_token;
      if (!refreshToken) return res.status(401).json({ error: 'Not authenticated with Google Ads' });

      const accessToken = await googleAds.refreshAccessToken(config.googleAds, refreshToken);
      req.session.tokens.access_token = accessToken;

      const mccId = req.session.mccId || config.googleAds.mccId;
      if (!mccId) return res.status(400).json({ error: 'No MCC ID configured' });

      // Reuse the dealer list cached by /api/accounts. If absent, ask the user
      // to hit the dashboard first — re-discovering the MCC tree here would
      // double the work on every scan.
      const accounts = req.session.accounts;
      if (!Array.isArray(accounts) || accounts.length === 0) {
        return res.status(409).json({
          error: 'No dealer accounts cached. Load the dashboard first so /api/accounts populates the session.',
        });
      }

      const result = await scanCpcOptimizer({
        accessToken,
        developerToken: config.googleAds.developerToken,
        mccId,
        accounts,
      });

      res.json(result);
    } catch (err) {
      console.error('[cpc-optimizer/scan] error:', err.message);
      next(err);
    }
  });

  return router;
}

module.exports = { createCpcOptimizerRouter };
