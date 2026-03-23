/**
 * Account Routes — lists MCC sub-accounts and loads account structure.
 *
 * Called by: src/server.js (mounted at /api/*)
 * Calls: services/google-ads.js (MCC child queries, structure queries)
 *
 * Routes:
 *   GET /api/accounts                    → List all accessible dealer accounts
 *   GET /api/account/:customerId/structure → Load campaign/ad group/keyword tree
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const googleAds = require('../services/google-ads');

/**
 * Creates account routes with the given config.
 *
 * @param {Object} config - App configuration from config.js
 * @returns {express.Router} Configured accounts router
 */
function createAccountsRouter(config) {
  const router = express.Router();

  // List all accessible accounts via MCC
  router.get('/api/accounts', requireAuth, async (req, res, next) => {
    try {
      const refreshToken = req.session.tokens.refresh_token;
      const accessToken  = await googleAds.refreshAccessToken(config.googleAds, refreshToken);
      req.session.tokens.access_token = accessToken;

      // Use MCC ID from config (env var) or session
      const mccId = config.googleAds.mccId || req.session.mccId;
      if (!mccId) {
        return res.status(400).json({
          error: 'No MCC ID configured. Set GOOGLE_ADS_MCC_ID in your environment.',
        });
      }
      req.session.mccId = mccId;

      // Query all descendant accounts from MCC (any depth) — filter out managers below
      let accounts = [];
      const rows = await googleAds.queryViaRest(
        accessToken, config.googleAds.developerToken, mccId,
        'SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.level FROM customer_client WHERE customer_client.status = \'ENABLED\'',
        mccId
      );

      rows.forEach(row => {
        const c = row.customerClient;
        if (c && !c.manager) {
          accounts.push({
            id:        String(c.id),
            name:      c.descriptiveName || 'Account ' + c.id,
            currency:  c.currencyCode || '',
            isManager: false,
            mccId,
          });
        }
      });

      accounts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      // Cache in session for cross-account lookups (e.g. spend redirects in pacing)
      req.session.accounts = accounts;
      res.json({ accounts });

    } catch (err) {
      console.error('Accounts error:', err.response?.data?.error || err.message);
      if (err.response?.data) {
        console.error('Full API response:', JSON.stringify(err.response.data, null, 2));
      }
      next(err);
    }
  });

  // Load account structure (campaigns, ad groups, keywords, locations)
  router.get('/api/account/:customerId/structure', requireAuth, async (req, res, next) => {
    const { customerId } = req.params;
    const mccId = req.session.mccId || config.googleAds.mccId;

    try {
      const accessToken = await googleAds.refreshAccessToken(config.googleAds, req.session.tokens.refresh_token);
      req.session.tokens.access_token = accessToken;

      const restCtx = {
        accessToken,
        developerToken: config.googleAds.developerToken,
        customerId: customerId.replace(/-/g, ''),
        loginCustomerId: mccId,
      };

      const structure = await googleAds.getAccountStructure(restCtx);
      res.json({ customerId, ...structure });

    } catch (err) {
      const errMsg = err?.errors?.[0]?.message || err?.message || String(err);
      console.error('Structure error:', errMsg);
      next(err);
    }
  });

  return router;
}

module.exports = { createAccountsRouter };
