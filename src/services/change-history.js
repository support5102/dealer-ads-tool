/**
 * Change History — persistent log of all API changes made by the tool.
 *
 * Called by: routes/budget-adjustments.js, routes/audit.js, routes/changes.js
 *
 * Tracks every change applied to Google Ads: budget adjustments, keyword pauses,
 * negative keyword additions, recommendation dismissals, etc.
 *
 * Storage: PostgreSQL (Neon) when DATABASE_URL is set, in-memory fallback otherwise.
 * In-memory entries are newest-first with a max of 500 entries.
 */

const crypto = require('crypto');
const db = require('./database');

const MAX_ENTRIES = 500;
const memoryEntries = []; // fallback when no database

/**
 * Adds a change entry to the history log.
 *
 * @param {Object} entry
 * @param {string} entry.action - What was done
 * @param {string} [entry.userEmail] - Who made the change
 * @param {string} [entry.accountId] - Google Ads customer ID
 * @param {string} [entry.dealerName] - Dealer name
 * @param {Object|string} [entry.details] - Action-specific details
 * @param {string} entry.source - Where the change came from
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
    details: typeof entry.details === 'string' ? entry.details : (entry.details || {}),
    source: entry.source || 'unknown',
    success: entry.success !== false,
    error: entry.error || null,
  };

  // Try database first, fall back to memory
  const pool = db.getPool();
  if (pool) {
    const detailsJson = typeof record.details === 'string'
      ? JSON.stringify({ text: record.details })
      : JSON.stringify(record.details);

    pool.query(
      `INSERT INTO change_history (id, timestamp, user_email, action, account_id, dealer_name, details, source, success, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [record.id, record.timestamp, record.userEmail, record.action,
       record.accountId, record.dealerName, detailsJson,
       record.source, record.success, record.error]
    ).catch(err => {
      console.error('Failed to persist change history entry:', err.message);
      // Fall back to memory
      memoryEntries.unshift(record);
      if (memoryEntries.length > MAX_ENTRIES) memoryEntries.length = MAX_ENTRIES;
    });
  } else {
    memoryEntries.unshift(record);
    if (memoryEntries.length > MAX_ENTRIES) memoryEntries.length = MAX_ENTRIES;
  }

  return record;
}

/**
 * Retrieves change history, optionally filtered by account.
 *
 * @param {number} [limit=100] - Max entries to return
 * @param {string} [accountId] - Filter to specific account
 * @returns {Promise<Object[]>} Array of change entries (newest first)
 */
async function getHistory(limit = 100, accountId = null) {
  const pool = db.getPool();
  if (pool) {
    try {
      let query = 'SELECT * FROM change_history';
      const params = [];
      if (accountId) {
        const clean = accountId.replace(/-/g, '');
        query += ' WHERE REPLACE(account_id, \'-\', \'\') = $1';
        params.push(clean);
      }
      query += ' ORDER BY timestamp DESC LIMIT $' + (params.length + 1);
      params.push(limit);

      const result = await pool.query(query, params);
      return result.rows.map(row => ({
        id: row.id,
        timestamp: row.timestamp,
        userEmail: row.user_email,
        action: row.action,
        accountId: row.account_id,
        dealerName: row.dealer_name,
        details: row.details,
        source: row.source,
        success: row.success,
        error: row.error,
      }));
    } catch (err) {
      console.error('Failed to query change history:', err.message);
      // Fall back to memory
    }
  }

  // Memory fallback
  let result = memoryEntries;
  if (accountId) {
    const clean = accountId.replace(/-/g, '');
    result = memoryEntries.filter(e => {
      const entryId = (e.accountId || '').replace(/-/g, '');
      return entryId === clean;
    });
  }
  return result.slice(0, limit);
}

/**
 * Returns total number of entries.
 */
async function size() {
  const pool = db.getPool();
  if (pool) {
    try {
      const result = await pool.query('SELECT COUNT(*) FROM change_history');
      return parseInt(result.rows[0].count);
    } catch { /* fall through */ }
  }
  return memoryEntries.length;
}

/**
 * Clears all entries. Used for testing.
 */
async function clear() {
  const pool = db.getPool();
  if (pool) {
    try {
      await pool.query('DELETE FROM change_history');
    } catch { /* fall through */ }
  }
  memoryEntries.length = 0;
}

module.exports = {
  addEntry,
  getHistory,
  size,
  clear,
};
