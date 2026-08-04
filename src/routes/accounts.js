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

// How long a session may serve its cached account list before re-discovering.
const ACCOUNTS_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Discovers all non-manager accounts under an MCC hierarchy in a SINGLE query.
 *
 * A `customer_client` query from the root MCC already returns every descendant at
 * ALL levels (verified: level-1 accounts and level-2 accounts under sub-MCCs both
 * come back in the one result). The previous implementation recursed into each
 * sub-MCC and re-queried it — one extra sequential round-trip per sub-MCC, all
 * re-fetching rows the root query already returned. This collapses discovery to a
 * single round-trip, which is the dominant cost of loading the pacing/accounts UI.
 *
 * @param {string} accessToken
 * @param {string} developerToken
 * @param {string} mccId - MCC to enumerate (the root MCC)
 * @param {string} [rootMccId=mccId] - login-customer-id header value
 * @returns {Promise<Object[]>} Flat array of { id, name, currency, isManager, mccId }
 */
async function discoverAllAccounts(accessToken, developerToken, mccId, rootMccId = mccId) {
  const cleanMcc = String(mccId).replace(/-/g, '');
  const loginMcc = String(rootMccId || mccId).replace(/-/g, '');

  let rows;
  try {
    rows = await googleAds.queryViaRest(
      accessToken, developerToken, cleanMcc, CUSTOMER_CLIENT_QUERY, loginMcc
    );
  } catch (err) {
    console.error(`[discoverAllAccounts] Failed to query MCC ${cleanMcc}:`, err.message);
    return [];
  }

  // queryViaRest normally returns an array; guard against an unexpected null/shape
  // so one odd response can't 500 the entire listing.
  if (!Array.isArray(rows)) return [];

  const accounts = [];
  for (const row of rows) {
    const c = row.customerClient;
    if (!c || !c.id) continue;
    const id = String(c.id);
    if (id === cleanMcc) continue;   // skip the MCC itself
    if (c.manager) continue;         // skip sub-MCCs — their child accounts are already in this result
    accounts.push({
      id,
      name: c.descriptiveName || 'Account ' + id,
      currency: c.currencyCode || '',
      isManager: false,
      mccId: cleanMcc,
    });
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
      // Cache: the MCC hierarchy rarely changes, so serve the already-discovered
      // list for this session instead of re-hitting the Ads API on every tab load.
      // `?refresh=1` forces a fresh discovery.
      if (!req.query.refresh
          && Array.isArray(req.session.accounts) && req.session.accounts.length
          && req.session.accountsAt && (Date.now() - req.session.accountsAt) < ACCOUNTS_TTL_MS) {
        return res.json({ accounts: req.session.accounts, cached: true });
      }

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

      console.log(`[accounts] Discovered ${unique.length} accounts (single query)`);
      req.session.accounts = unique;
      req.session.accountsAt = Date.now();
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
