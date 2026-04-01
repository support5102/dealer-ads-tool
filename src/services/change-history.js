/**
 * Change History — in-memory log of all API changes made by the tool.
 *
 * Called by: routes/budget-adjustments.js, routes/audit.js, routes/changes.js
 *
 * Tracks every change applied to Google Ads: budget adjustments, keyword pauses,
 * negative keyword additions, recommendation dismissals, etc.
 * Entries are stored newest-first with a max of 500 entries.
 *
 * Railway has ephemeral filesystem, so this is in-memory only — history
 * resets on server restart. For persistent logs, Railway captures stdout
 * via the logAudit() function in utils/audit-log.js.
 */

const crypto = require('crypto');

const MAX_ENTRIES = 500;
const entries = [];

/**
 * Adds a change entry to the history log.
 *
 * @param {Object} entry
 * @param {string} entry.action - What was done: 'budget_change', 'pause_keyword',
 *   'add_negative', 'dismiss_recommendation', 'pause_campaign', 'enable_campaign',
 *   'update_keyword_bid', 'exclude_radius', 'add_radius', 'add_keyword'
 * @param {string} [entry.userEmail] - Who made the change
 * @param {string} [entry.accountId] - Google Ads customer ID
 * @param {string} [entry.dealerName] - Dealer name
 * @param {Object} [entry.details] - Action-specific details
 * @param {string} [entry.details.campaignName] - Campaign affected
 * @param {string} [entry.details.target] - What was changed (keyword text, budget name, etc.)
 * @param {*} [entry.details.previousValue] - Value before change
 * @param {*} [entry.details.newValue] - Value after change
 * @param {string} [entry.details.reason] - Why the change was made
 * @param {string} entry.source - Where the change came from: 'auto_adjuster', 'audit_fixer', 'task_manager'
 * @param {boolean} entry.success - Whether the change succeeded
 * @param {string} [entry.error] - Error message if failed
 */
function addEntry(entry) {
  const record = {
    id: `ch-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    timestamp: new Date().toISOString(),
    userEmail: entry.userEmail || 'unknown',
    action: entry.action || 'unknown',
    accountId: entry.accountId || null,
    dealerName: entry.dealerName || null,
    details: entry.details || {},
    source: entry.source || 'unknown',
    success: entry.success !== false,
    error: entry.error || null,
  };

  entries.unshift(record); // newest first

  // Trim to max entries
  if (entries.length > MAX_ENTRIES) {
    entries.length = MAX_ENTRIES;
  }

  return record;
}

/**
 * Retrieves change history, optionally filtered by account.
 *
 * @param {number} [limit=100] - Max entries to return
 * @param {string} [accountId] - Filter to specific account
 * @returns {Object[]} Array of change entries (newest first)
 */
function getHistory(limit = 100, accountId = null) {
  let result = entries;
  if (accountId) {
    const clean = accountId.replace(/-/g, '');
    result = entries.filter(e => {
      const entryId = (e.accountId || '').replace(/-/g, '');
      return entryId === clean;
    });
  }
  return result.slice(0, limit);
}

/**
 * Returns total number of entries.
 */
function size() {
  return entries.length;
}

/**
 * Clears all entries. Used for testing.
 */
function clear() {
  entries.length = 0;
}

module.exports = {
  addEntry,
  getHistory,
  size,
  clear,
};
