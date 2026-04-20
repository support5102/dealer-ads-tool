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

const CUSTOMER_CLIENT_QUERY = `SELECT customer_client.id, customer_client.descriptive_name,
  customer_client.currency_code, customer_client.manager, customer_client.level
  FROM customer_client WHERE customer_client.status = 'ENABLED'`;

/**
 * Recursively discovers all non-manager accounts under an MCC hierarchy.
 * Handles nested MCCs (e.g. PPC Account MCC → Savvy Ford MCC → dealer accounts).
 *
 * @param {string} accessToken
 * @param {string} developerToken
 * @param {string} mccId - Current MCC to query
 * @param {string} rootMccId - Top-level MCC for login-customer-id header
 * @param {Set} visited - Prevents infinite loops on circular links
 * @returns {Promise<Object[]>} Flat array of { id, name, currency, isManager, mccId }
 */
async function discoverAllAccounts(accessToken, developerToken, mccId, rootMccId, visited = new Set()) {
  const cleanMcc = String(mccId).replace(/-/g, '');
  if (visited.has(cleanMcc)) return [];
  visited.add(cleanMcc);

  let rows;
  try {
    rows = await googleAds.queryViaRest(
      accessToken, developerToken, cleanMcc,
      CUSTOMER_CLIENT_QUERY,
      rootMccId
    );
  } catch (err) {
    console.error(`[discoverAllAccounts] Failed to query MCC ${cleanMcc}:`, err.message);
    return [];
  }

  const accounts = [];
  const subMccs = [];

  for (const row of rows) {
    const c = row.customerClient;
    if (!c || !c.id) continue;
    const id = String(c.id);

    // Skip the MCC itself
    if (id === cleanMcc) continue;

    if (c.manager) {
      // Sub-MCC — queue for recursive discovery
      subMccs.push(id);
    } else {
      accounts.push({
        id,
        name: c.descriptiveName || 'Account ' + id,
        currency: c.currencyCode || '',
        isManager: false,
        mccId: cleanMcc, // Track which MCC directly manages this account
      });
    }
  }

  // Recursively discover accounts under each sub-MCC
  for (const subMcc of subMccs) {
    const subAccounts = await discoverAllAccounts(
      accessToken, developerToken, subMcc, rootMccId, visited
    );
    accounts.push(...subAccounts);
  }

  return accounts;
}

/**
 * Creates account routes with the given config.
 *
 * @param {Object} config - App configuration from config.js
 * @returns {express.Router} Configured accounts router
 */
function createAccountsRouter(config) {
  const router = express.Router();

  // List all accessible accounts via MCC (including nested sub-MCCs)
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

      // Recursively discover all accounts under MCC hierarchy
      const accounts = await discoverAllAccounts(
        accessToken, config.googleAds.developerToken, mccId, mccId
      );

      // Deduplicate by account ID (an account could appear under multiple MCCs)
      const seen = new Map();
      for (const acct of accounts) {
        if (!seen.has(acct.id)) {
          seen.set(acct.id, acct);
        }
      }

      const unique = Array.from(seen.values());
      unique.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      console.log(`[accounts] Discovered ${unique.length} accounts (from ${accounts.length} total incl. dupes)`);
      req.session.accounts = unique;
      res.json({ accounts: unique });

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

module.exports = { createAccountsRouter, discoverAllAccounts };
