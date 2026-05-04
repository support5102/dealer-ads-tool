/**
 * Budget Revert Runner — daily scheduled job.
 *
 * Selects pending_budget_reverts rows where revert_due_date <= today, groups by
 * dealer, and files one Freshdesk reminder ticket per dealer summarising all due
 * bumps. Marks the rows status='notified' with the ticket id.
 *
 * Feature-flagged via BUDGET_REVERT_REMINDERS_ENABLED. Idempotent — already-notified
 * rows are excluded by the SELECT.
 */

const freshdeskModule = require('./freshdesk');
const databaseModule = require('./database');

/**
 * Runs the revert-reminder pass.
 *
 * @param {Object}  args
 * @param {Date}    args.today
 * @param {Object}  [args.db]               - injectable db (for tests); defaults to database.getPool()
 * @param {Object}  [args.freshdeskClient]  - injectable client (for tests); defaults to freshdesk.getDefaultClient()
 * @returns {Promise<{ ticketsFiled: number, dealersProcessed: number, errors: number, disabled?: boolean, fdNotConfigured?: boolean }>}
 */
async function runBudgetRevertReminders({ today, db, freshdeskClient }) {
  const summary = { ticketsFiled: 0, dealersProcessed: 0, errors: 0 };

  let flagEnabled = false;
  try {
    const { validateEnv } = require('../utils/config');
    flagEnabled = validateEnv().budgetRevertRemindersEnabled;
  } catch (_) { /* misconfigured env: treat as disabled */ }
  if (!flagEnabled) {
    return { ...summary, disabled: true };
  }

  const useDb = db || databaseModule.getPool();
  if (!useDb) {
    console.warn('[budget-revert-runner] no DB available; skipping');
    return { ...summary, fdNotConfigured: true };
  }

  const fd = freshdeskClient ?? freshdeskModule.getDefaultClient();
  if (!fd) {
    return { ...summary, fdNotConfigured: true };
  }

  const dueRes = await useDb.query(
    `SELECT id, dealer_name, bump_amount, baseline_monthly_budget, bumped_monthly_budget,` +
    ` applied_at, applied_by, applied_change_id, revert_due_date FROM pending_budget_reverts` +
    ` WHERE status = 'pending' AND revert_due_date <= $1`,
    [today]
  );

  const byDealer = new Map();
  for (const row of dueRes.rows) {
    if (!byDealer.has(row.dealer_name)) byDealer.set(row.dealer_name, []);
    byDealer.get(row.dealer_name).push(row);
  }

  for (const [dealerName, rows] of byDealer.entries()) {
    summary.dealersProcessed += 1;
    try {
      const totalBump = rows.reduce((s, r) => s + Number(r.bump_amount), 0);
      const baseline = Number(rows[0].baseline_monthly_budget);
      const ticket = await fd.createTicket({
        subject: `[Revert reminder] ${dealerName}: drop monthly budget by $${totalBump.toFixed(2)} → $${baseline.toFixed(2)}`,
        description: buildTicketBody(dealerName, rows, baseline, totalBump),
        priority: 2,
        tags: ['auto-detect', 'budget-revert'],
      });

      const ids = rows.map(r => r.id);
      await useDb.query(
        `UPDATE pending_budget_reverts
            SET status='notified', ticket_id=$1, ticket_filed_at=NOW()
          WHERE id = ANY($2::int[])`,
        [String(ticket.id), ids]
      );
      summary.ticketsFiled += 1;
    } catch (err) {
      summary.errors += 1;
      console.warn(`[budget-revert-runner] dealer "${dealerName}" failed:`, err.message);
    }
  }

  return summary;
}

function buildTicketBody(dealerName, rows, baseline, totalBump) {
  const lines = [];
  lines.push(`<p>${dealerName} has ${rows.length} rest-of-month bump${rows.length === 1 ? '' : 's'} due to revert.</p>`);
  lines.push('<ul>');
  for (const r of rows) {
    const amt = Number(r.bump_amount).toFixed(2);
    const applied = r.applied_at ? new Date(r.applied_at).toISOString().slice(0, 10) : 'unknown';
    lines.push(`<li>+$${amt} applied ${applied} (change id #${r.applied_change_id ?? '-'})</li>`);
  }
  lines.push('</ul>');
  lines.push(`<p><strong>Cumulative revert needed: $${totalBump.toFixed(2)}</strong> → return to baseline $${baseline.toFixed(2)}.</p>`);
  lines.push('<p>To revert: open the dealer in pacing overview, click the pencil-edit icon, and use the <em>Set total</em> tab to drop the monthly budget back to the baseline.</p>');
  return lines.join('\n');
}

module.exports = { runBudgetRevertReminders };
