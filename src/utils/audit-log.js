/**
 * Audit Logger — structured JSON logging to stdout for change tracking.
 *
 * Called by: routes/changes.js (after applying changes)
 * Calls: nothing (writes to stdout via console.log)
 *
 * Railway captures stdout, so structured JSON logs are searchable
 * in the Railway dashboard without needing a database or file system.
 */

/**
 * Logs a structured audit event to stdout as JSON.
 *
 * @param {Object} entry - Audit log entry
 * @param {string} entry.action - What happened (e.g., 'apply_changes', 'parse_task')
 * @param {string} [entry.email] - User email from session (or 'unknown')
 * @param {string} [entry.customerId] - Google Ads customer ID
 * @param {boolean} [entry.dryRun] - Whether this was a dry run
 * @param {number} [entry.applied] - Number of changes applied
 * @param {number} [entry.failed] - Number of changes that failed
 * @param {Object[]} [entry.changes] - Summary of changes attempted
 * @param {string} [entry.error] - Error message if the action failed
 */
function logAudit(entry) {
  const record = {
    ...entry,
    _audit: true,
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(record));
}

module.exports = { logAudit };
