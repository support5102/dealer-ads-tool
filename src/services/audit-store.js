/**
 * Audit Store — in-memory storage for audit results per account.
 *
 * Called by: routes/audit.js, services/audit-engine.js
 *
 * Stores the latest audit results per account with configurable history depth.
 * Railway has ephemeral filesystem, so all storage is in-memory.
 * Results survive for the lifetime of the server process.
 */

const DEFAULT_HISTORY_DEPTH = 7;

// accountId → [{ timestamp, ...auditResult }] (newest first)
const store = new Map();

/**
 * Saves an audit result for an account.
 * Trims history to the configured depth.
 *
 * @param {string} accountId - Google Ads customer ID
 * @param {Object} auditResult - Audit result from audit-engine
 * @param {number} [maxHistory] - Maximum history entries to retain
 */
function save(accountId, auditResult, maxHistory = DEFAULT_HISTORY_DEPTH) {
  if (!accountId) throw new Error('accountId is required');
  if (!auditResult) throw new Error('auditResult is required');

  const entry = {
    ...auditResult,
    timestamp: auditResult.timestamp || new Date().toISOString(),
  };

  if (!store.has(accountId)) {
    store.set(accountId, []);
  }

  const history = store.get(accountId);
  history.unshift(entry); // newest first

  // Trim to maxHistory
  if (history.length > maxHistory) {
    history.length = maxHistory;
  }
}

/**
 * Gets the latest audit result for an account.
 *
 * @param {string} accountId - Google Ads customer ID
 * @returns {Object|null} Latest audit result or null
 */
function getLatest(accountId) {
  const history = store.get(accountId);
  return history && history.length > 0 ? history[0] : null;
}

/**
 * Gets audit history for an account.
 *
 * @param {string} accountId - Google Ads customer ID
 * @param {number} [limit] - Maximum entries to return
 * @returns {Object[]} Array of audit results (newest first)
 */
function getHistory(accountId, limit = DEFAULT_HISTORY_DEPTH) {
  const history = store.get(accountId);
  if (!history) return [];
  return history.slice(0, limit);
}

/**
 * Gets the latest audit result for all accounts.
 *
 * @returns {Object[]} Array of { accountId, ...latestResult }
 */
function getAllLatest() {
  const results = [];
  for (const [accountId, history] of store) {
    if (history.length > 0) {
      results.push({ accountId, ...history[0] });
    }
  }
  return results;
}

/**
 * Returns the number of accounts with stored audit results.
 *
 * @returns {number}
 */
function size() {
  return store.size;
}

/**
 * Clears all stored audit results. Used for testing.
 */
function clear() {
  store.clear();
}

module.exports = {
  save,
  getLatest,
  getHistory,
  getAllLatest,
  size,
  clear,
};
