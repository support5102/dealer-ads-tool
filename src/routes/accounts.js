/**
 * Account Routes — lists MCC sub-accounts and loads account structure.
 *
 * Called by: src/server.js (mounted at /api/*)
 * Calls: services/google-ads.js (MCC discovery, structure queries)
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

  // List all accessible accounts (MCC + children)
  router.get('/api/accounts', requireAuth, async (req, res, next) => {
    try {
      const refreshToken = req.session.tokens.refresh_token;
      const accessToken  = await googleAds.refreshAccessToken(config.googleAds, refreshToken);
      req.session.tokens.access_token = accessToken;

      // Step 1: Get accessible customer IDs
      const resourceNames = await googleAds.listAccessibleCustomers(config.googleAds, refreshToken);

      // Step 2: Query each account for info (find MCC)
      const infoResults = await Promise.allSettled(
        resourceNames.map(async rn => {
          const id = rn.replace('customers/', '');
          const rows = await googleAds.queryViaRest(
            accessToken, config.googleAds.developerToken, id,
            'SELECT customer.id, customer.descriptive_name, customer.manager FROM customer LIMIT 1',
            id
          );
          const c = rows[0]?.customer;
          return { id, name: c?.descriptiveName || null, isManager: c?.manager || false };
        })
      );

      // Find MCC
      let mccId = req.session.mccId;
      infoResults.forEach(r => {
        if (r.status === 'fulfilled' && r.value?.isManager) {
          mccId = r.value.id;
          req.session.mccId = mccId;
        }
      });

      // Step 3: Get client accounts via MCC
      let accounts = [];
      if (mccId) {
        try {
          const rows = await googleAds.queryViaRest(
            accessToken, config.googleAds.developerToken, mccId,
            'SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.level FROM customer_client WHERE customer_client.level = 1',
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
        } catch (e) {
          console.error('customer_client query failed:', e.response?.data?.error?.message || e.message);
        }
      }

      // Fallback: use direct account info
      if (accounts.length === 0) {
        infoResults.forEach((r, i) => {
          if (r.status === 'fulfilled' && r.value) {
            accounts.push({
              id:        r.value.id,
              name:      r.value.name || 'Account ' + r.value.id,
              currency:  '',
              isManager: r.value.isManager,
              mccId:     mccId || null,
            });
          } else if (resourceNames[i]) {
            const id = resourceNames[i].replace('customers/', '');
            accounts.push({ id, name: 'Account ' + id, currency: '', isManager: false, mccId: null });
          }
        });
      }

      accounts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      res.json({ accounts });

    } catch (err) {
      console.error('Accounts error:', err.response?.data?.error || err.message);
      next(err);
    }
  });

  // Load account structure (campaigns, ad groups, keywords, locations)
  router.get('/api/account/:customerId/structure', requireAuth, async (req, res, next) => {
    const { customerId } = req.params;
    const mccId = req.session.mccId;

    try {
      const client = googleAds.createClient(
        config.googleAds,
        req.session.tokens.refresh_token,
        customerId,
        mccId
      );

      const structure = await googleAds.getAccountStructure(client);
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
