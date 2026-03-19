/**
 * Account Iterator — batch-iterates all child accounts under an MCC.
 *
 * Called by: routes/audit.js (POST /api/audit/all)
 * Calls: services/google-ads.js (queryViaRest for child account discovery)
 *
 * Discovers all non-manager child accounts under an MCC, then runs a callback
 * against each account with rate limiting and error isolation. One account
 * failure does not abort the batch.
 */

const { queryViaRest } = require('./google-ads');

/**
 * Discovers non-manager child accounts under an MCC.
 *
 * @param {Object} config - googleAds config (clientId, clientSecret, developerToken)
 * @param {string} accessToken - Fresh OAuth access token
 * @param {string} mccId - MCC customer ID
 * @param {Function} [queryFn] - Injectable query function (for testing)
 * @returns {Promise<Object[]>} Array of { customerId, name, currency, isManager }
 */
async function discoverAccounts(config, accessToken, mccId, queryFn) {
  const doQuery = queryFn || queryViaRest;
  const cleanMcc = String(mccId).replace(/-/g, '');

  // Match the existing accounts.js discovery query exactly:
  // - customer_client.status = 'ENABLED' filters out suspended/cancelled
  // - No level filter so sub-MCC children at any depth are included
  const rows = await doQuery(
    accessToken,
    config.developerToken,
    cleanMcc,
    `SELECT customer_client.id, customer_client.descriptive_name,
            customer_client.currency_code, customer_client.manager
     FROM customer_client
     WHERE customer_client.status = 'ENABLED'`,
    cleanMcc
  );

  return rows
    .filter(r => {
      const cc = r.customerClient || r.customer_client || {};
      // Guard against malformed rows: must have a valid ID
      if (!cc.id) return false;
      // Filter out managers (MCCs) and the MCC itself
      return !cc.manager && String(cc.id) !== cleanMcc;
    })
    .map(r => {
      const cc = r.customerClient || r.customer_client || {};
      return {
        customerId: String(cc.id),
        name: cc.descriptiveName || cc.descriptive_name || '',
        currency: cc.currencyCode || cc.currency_code || 'USD',
        isManager: false,
      };
    });
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
    const restCtx = {
      accessToken,
      developerToken: config.developerToken,
      customerId: account.customerId.replace(/-/g, ''),
      loginCustomerId: String(mccId).replace(/-/g, ''),
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
