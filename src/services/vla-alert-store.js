/**
 * VLA Alert Store — state machine for VLA monitoring tickets.
 *
 * Called by: services/vla-monitor-runner.js
 * Calls:     services/database.js (Postgres)
 *
 * One row per (dealer, alert_kind). Lifecycle:
 *
 *   detected, no row exists           → INSERT row (status='open'), caller creates ticket
 *   detected, existing open row,
 *     signature unchanged             → bump consecutive_days, reset cleared_days,
 *                                       caller SKIPS ticket creation
 *   detected, existing open row,
 *     signature changed               → update row + signature, caller updates ticket body
 *   not detected, existing open row   → increment cleared_days; if ≥2,
 *                                       mark resolved, caller closes ticket
 *   not detected, no row              → no-op
 *
 * Why a state machine (not the change_alert_dedup natural-key dedup): VLA
 * issues are CONTINUOUS conditions, not discrete events. Without lifecycle
 * handling, the same disapproval re-tickets every morning → alert fatigue.
 */

const database = require('./database');

const RESOLVE_AFTER_CLEARED_DAYS = 2;

/**
 * Loads all currently-open alerts for a dealer.
 *
 * @param {string} dealerName
 * @returns {Promise<Map<string, Object>>} alert_kind → row
 */
async function loadOpenAlerts(dealerName) {
  const pool = database.getPool();
  if (!pool) return new Map();
  const res = await pool.query(
    `SELECT * FROM vla_alert_state WHERE dealer_name = $1 AND status = 'open'`,
    [dealerName]
  );
  const map = new Map();
  for (const row of res.rows) {
    map.set(row.alert_kind, row);
  }
  return map;
}

/**
 * Reconciles detected alerts against the stored state for one dealer.
 * Returns a list of actions the runner should take.
 *
 * @param {string} dealerName
 * @param {Object[]} detectedAlerts - From vla-monitor.detectAlerts()
 * @returns {Promise<Object[]>} Actions: [{ op: 'create'|'update'|'skip'|'close', alert, existing }]
 */
async function reconcile(dealerName, detectedAlerts) {
  const existing = await loadOpenAlerts(dealerName);
  const detectedByKind = new Map(detectedAlerts.map(a => [a.alert_kind, a]));
  const actions = [];

  // For each detected alert, figure out the action.
  for (const alert of detectedAlerts) {
    const prior = existing.get(alert.alert_kind);
    if (!prior) {
      actions.push({ op: 'create', alert });
    } else if (prior.signature === alert.signature) {
      actions.push({ op: 'skip', alert, existing: prior });
    } else {
      actions.push({ op: 'update', alert, existing: prior });
    }
  }

  // For each previously-open alert NOT in today's detection, increment cleared_days.
  // If cleared_days reaches the resolve threshold, mark resolved + close ticket.
  for (const [kind, prior] of existing.entries()) {
    if (detectedByKind.has(kind)) continue;
    const newCleared = (prior.cleared_days || 0) + 1;
    if (newCleared >= RESOLVE_AFTER_CLEARED_DAYS) {
      actions.push({ op: 'close', alert: null, existing: prior });
    } else {
      actions.push({ op: 'mark_clearing', alert: null, existing: prior, newCleared });
    }
  }

  return actions;
}

/**
 * Persists the result of a reconcile action (after the runner has done any
 * Freshdesk side-effect — so we can stash the ticket id).
 *
 * @param {string} dealerName
 * @param {Object} action - From reconcile()
 * @param {string|null} ticketId - Freshdesk ticket id (for create/update)
 */
async function applyAction(dealerName, action, ticketId) {
  const pool = database.getPool();
  if (!pool) return;

  if (action.op === 'create') {
    const a = action.alert;
    await pool.query(
      `INSERT INTO vla_alert_state
         (dealer_name, alert_kind, signature, severity, status,
          consecutive_days, cleared_days, freshdesk_ticket_id, payload,
          first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, 'open', 1, 0, $5, $6, NOW(), NOW())
       ON CONFLICT (dealer_name, alert_kind) DO UPDATE SET
         signature = EXCLUDED.signature,
         severity = EXCLUDED.severity,
         status = 'open',
         consecutive_days = vla_alert_state.consecutive_days + 1,
         cleared_days = 0,
         freshdesk_ticket_id = COALESCE(EXCLUDED.freshdesk_ticket_id, vla_alert_state.freshdesk_ticket_id),
         payload = EXCLUDED.payload,
         last_seen_at = NOW()`,
      [dealerName, a.alert_kind, a.signature, a.severity, ticketId || null, JSON.stringify(a.payload || {})]
    );
  } else if (action.op === 'update') {
    const a = action.alert;
    await pool.query(
      `UPDATE vla_alert_state
       SET signature = $3,
           severity = $4,
           consecutive_days = consecutive_days + 1,
           cleared_days = 0,
           payload = $5,
           last_seen_at = NOW()
       WHERE dealer_name = $1 AND alert_kind = $2`,
      [dealerName, a.alert_kind, a.signature, a.severity, JSON.stringify(a.payload || {})]
    );
  } else if (action.op === 'skip') {
    await pool.query(
      `UPDATE vla_alert_state
       SET consecutive_days = consecutive_days + 1,
           cleared_days = 0,
           last_seen_at = NOW()
       WHERE dealer_name = $1 AND alert_kind = $2`,
      [dealerName, action.alert.alert_kind]
    );
  } else if (action.op === 'mark_clearing') {
    await pool.query(
      `UPDATE vla_alert_state
       SET cleared_days = $3,
           last_seen_at = NOW()
       WHERE dealer_name = $1 AND alert_kind = $2`,
      [dealerName, action.existing.alert_kind, action.newCleared]
    );
  } else if (action.op === 'close') {
    await pool.query(
      `UPDATE vla_alert_state
       SET status = 'resolved',
           resolved_at = NOW()
       WHERE dealer_name = $1 AND alert_kind = $2`,
      [dealerName, action.existing.alert_kind]
    );
  }
}

/**
 * Returns every open alert across all dealers — backs the dashboard read.
 */
async function listAllOpen() {
  const pool = database.getPool();
  if (!pool) return [];
  const res = await pool.query(
    `SELECT dealer_name, alert_kind, severity, consecutive_days, cleared_days,
            freshdesk_ticket_id, payload, first_seen_at, last_seen_at
     FROM vla_alert_state
     WHERE status = 'open'
     ORDER BY severity DESC, last_seen_at DESC`
  );
  return res.rows;
}

module.exports = {
  loadOpenAlerts,
  reconcile,
  applyAction,
  listAllOpen,
  RESOLVE_AFTER_CLEARED_DAYS,
};
