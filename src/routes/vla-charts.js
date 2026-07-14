/**
 * VLA Charts routes — per-dealer daily VLA metrics for the charts page.
 *
 * Mounted by src/server.js.
 *
 * Routes:
 *   GET /api/vla-charts/all → { dealers: [{ dealerName, customerId, campaigns: [...] }], failed, totalAccounts }
 *
 * Each dealer's `campaigns` is [{ campaignId, name, days: [{ date, clicks,
 * impressions, cost }] }] for the last 30 days — one entry per VLA campaign, so
 * the UI can draw a separate colored line per campaign. Only dealers that
 * actually have VLA campaigns are returned. Accounts are fetched in batches,
 * mirroring GET /api/pacing/all.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const googleAds = require('../services/google-ads');

function createVlaChartsRouter(config) {
  const router = express.Router();

  router.get('/api/vla-charts/all', requireAuth, async (req, res, next) => {
    const BATCH_SIZE = 6;
    const TIMEOUT_MS = 90_000;
    const start = Date.now();

    try {
      const mccId = req.session.mccId || config.googleAds.mccId;
      const loginCustomerId = String(mccId).replace(/-/g, '');
      const accessToken = await googleAds.refreshAccessToken(
        config.googleAds,
        req.session.tokens.refresh_token
      );
      req.session.tokens.access_token = accessToken;

      const accounts = req.session.accounts || [];
      if (accounts.length === 0) {
        return res.status(400).json({ error: 'No accounts loaded. Open the Pacing page and click Refresh first.' });
      }

      const dealers = [];
      const failed = [];

      for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
        if (Date.now() - start > TIMEOUT_MS) {
          for (let j = i; j < accounts.length; j++) {
            failed.push({ dealerName: accounts[j].name, error: 'Request timeout' });
          }
          break;
        }

        const batch = accounts.slice(i, i + BATCH_SIZE);
        const settled = await Promise.allSettled(batch.map(async (acct) => {
          const restCtx = {
            accessToken,
            developerToken: config.googleAds.developerToken,
            customerId: String(acct.id).replace(/-/g, ''),
            loginCustomerId,
          };
          const campaigns = await googleAds.getVlaDailyMetrics(restCtx);
          return { dealerName: acct.name, customerId: acct.id, campaigns };
        }));

        for (let k = 0; k < settled.length; k++) {
          const r = settled[k];
          if (r.status === 'fulfilled') {
            // Only include dealers that actually run VLA campaigns.
            if (r.value.campaigns.length > 0) dealers.push(r.value);
          } else {
            failed.push({ dealerName: batch[k].name, error: r.reason?.message || 'Unknown error' });
          }
        }

        if (i + BATCH_SIZE < accounts.length) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      dealers.sort((a, b) => a.dealerName.localeCompare(b.dealerName));
      res.json({ dealers, failed, totalAccounts: accounts.length });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createVlaChartsRouter };
