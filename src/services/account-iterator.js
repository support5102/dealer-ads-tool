/**
 * Account Iterator — batch-iterates all child accounts under an MCC.
 *
 * Called by: routes/audit.js (POST /api/audit/all)
 * Calls: services/google-ads.js (queryViaRest for child account discovery)
 *
 * Discovers all non-manager child accounts under an MCC (recursively through
 * sub-MCCs), then runs a callback against each account with rate limiting
 * and error isolation. One account failure does not abort the batch.
 */

const { queryViaRest } = require('./google-ads');

/**
 * Discovers non-manager child accounts under an MCC, recursively through sub-MCCs.
 *
 * @param {Object} config - googleAds config (clientId, clientSecret, developerToken)
 * @param {string} accessToken - Fresh OAuth access token
 * @param {string} mccId - MCC customer ID
 * @param {Function} [queryFn] - Injectable query function (for testing)
 * @param {string} [rootMccId] - Top-level MCC for login-customer-id header
 * @param {Set} [visited] - Prevents infinite loops on circular links
 * @returns {Promise<Object[]>} Array of { customerId, name, currency, isManager, managingMccId }
 */
async function discoverAccounts(config, accessToken, mccId, queryFn, rootMccId, visited) {
  const doQuery = queryFn || queryViaRest;
  const cleanMcc = String(mccId).replace(/-/g, '');
  const root = rootMccId ? String(rootMccId).replace(/-/g, '') : cleanMcc;
  const seen = visited || new Set();

  if (seen.has(cleanMcc)) return [];
  seen.add(cleanMcc);

  let rows;
  try {
    rows = await doQuery(
      accessToken,
      config.developerToken,
      cleanMcc,
      `SELECT customer_client.id, customer_client.descriptive_name,
              customer_client.currency_code, customer_client.manager
       FROM customer_client
       WHERE customer_client.status = 'ENABLED'`,
      root
    );
  } catch (err) {
    console.error(`[discoverAccounts] Failed to query MCC ${cleanMcc}:`, err.message);
    return [];
  }

  const accounts = [];
  const subMccs = [];

  for (const r of rows) {
    const cc = r.customerClient || r.customer_client || {};
    if (!cc.id) continue;
    const id = String(cc.id);
    if (id === cleanMcc) continue;

    if (cc.manager) {
      subMccs.push(id);
    } else {
      accounts.push({
        customerId: id,
        name: cc.descriptiveName || cc.descriptive_name || '',
        currency: cc.currencyCode || cc.currency_code || 'USD',
        isManager: false,
        managingMccId: cleanMcc,
      });
    }
  }

  // Recursively discover accounts under each sub-MCC
  for (const subMcc of subMccs) {
    const subAccounts = await discoverAccounts(config, accessToken, subMcc, queryFn, root, seen);
    accounts.push(...subAccounts);
  }

  // Deduplicate by customerId
  const unique = new Map();
  for (const acct of accounts) {
    if (!unique.has(acct.customerId)) {
      unique.set(acct.customerId, acct);
    }
  }

  return Array.from(unique.values());
}

/**
 * Iterates over all child accounts under an MCC, running a callback for each.
 * Handles error isolation per account and rate limiting.
 *
 * @param {Object} params - Iteration parameters
 * @param {Object} params.config - googleAds config
 * @param {string} params.accessToken - Fresh OAuth access token
 * @param {string} params.mccId - MCC customer ID
 * @param {Function} params.callback - async (restCtx, accountInfo) => result
 * @param {Object} [params.options] - { delayMs: 500, onProgress: fn, queryFn }
 * @returns {Promise<Object>} { results: [{accountId, accountName, result, error}], total, succeeded, failed }
 */
async function iterateAccounts(params) {
  const { config, accessToken, mccId, callback, options = {} } = params;
  const { delayMs = 500, onProgress, queryFn } = options;

  const accounts = await discoverAccounts(config, accessToken, mccId, queryFn);
  const results = [];

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    // Use the managing MCC as login customer ID for correct access
    const loginMcc = account.managingMccId || String(mccId).replace(/-/g, '');
    const restCtx = {
      accessToken,
      developerToken: config.developerToken,
      customerId: account.customerId.replace(/-/g, ''),
      loginCustomerId: loginMcc,
    };
    if (queryFn) restCtx._queryFn = queryFn;

    let result = null;
    let error = null;
    try {
      const raw = await callback(restCtx, account);
      result = raw !== undefined ? raw : null; // Ensure JSON-safe (no undefined)
    } catch (err) {
      error = err.message || String(err);
    }

    const entry = {
      accountId: account.customerId,
      accountName: account.name,
      result,
      error,
    };
    results.push(entry);

    if (onProgress) {
      try { onProgress({ current: i + 1, total: accounts.length, entry }); }
      catch (_) { /* onProgress errors must not abort iteration */ }
    }

    // Rate limiting between accounts (skip delay after last account)
    if (delayMs > 0 && i < accounts.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return {
    results,
    total: accounts.length,
    succeeded: results.filter(r => !r.error).length,
    failed: results.filter(r => r.error).length,
  };
}

module.exports = {
  discoverAccounts,
  iterateAccounts,
};
