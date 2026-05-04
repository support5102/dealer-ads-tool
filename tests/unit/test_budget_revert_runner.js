/**
 * Unit tests for budget-revert-runner.js.
 *
 * Strategy: inject a fake db (with a pending_budget_reverts in-memory array) and
 * a fake freshdesk client. No real DB or HTTP.
 */

jest.mock('../../src/utils/config');
const config = require('../../src/utils/config');

function makeFakeDb(rows) {
  const queries = [];
  return {
    rows,
    queries,
    query: jest.fn(async (sql, params = []) => {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/SELECT.*FROM pending_budget_reverts/i.test(sql)) {
        const today = params[0];
        return { rows: rows.filter(r => r.status === 'pending' && r.revert_due_date <= today) };
      }
      if (/UPDATE pending_budget_reverts/i.test(sql)) {
        const ticketId = params[0];
        const ids = params[1];
        for (const r of rows) {
          if (ids.includes(r.id)) {
            r.status = 'notified';
            r.ticket_id = ticketId;
            r.ticket_filed_at = new Date();
          }
        }
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

function makeFakeFdClient() {
  const tickets = [];
  return {
    tickets,
    createTicket: jest.fn(async (params) => {
      const id = `TKT-${tickets.length + 1}`;
      tickets.push({ id, params });
      return { id, url: `https://example/tickets/${id}` };
    }),
  };
}

beforeEach(() => {
  jest.resetModules();
  config.validateEnv = jest.fn(() => ({ budgetRevertRemindersEnabled: true }));
});

describe('runBudgetRevertReminders', () => {
  test('flag off → exits without DB or freshdesk calls', async () => {
    config.validateEnv = jest.fn(() => ({ budgetRevertRemindersEnabled: false }));
    const runner = require('../../src/services/budget-revert-runner');
    const db = makeFakeDb([]);
    const fd = makeFakeFdClient();
    const out = await runner.runBudgetRevertReminders({
      today: new Date('2026-06-01T08:00:00Z'),
      db, freshdeskClient: fd,
    });
    expect(out.disabled).toBe(true);
    expect(db.query).not.toHaveBeenCalled();
    expect(fd.createTicket).not.toHaveBeenCalled();
  });

  test('one dealer with one due row → one ticket, row flips to notified', async () => {
    const runner = require('../../src/services/budget-revert-runner');
    const today = new Date('2026-06-01T08:00:00Z');
    const db = makeFakeDb([
      { id: 1, dealer_name: 'Dealer A', status: 'pending', revert_due_date: today,
        bump_amount: 30, baseline_monthly_budget: 3000, bumped_monthly_budget: 3030,
        applied_at: new Date('2026-05-15'), applied_by: 'user', applied_change_id: 99 },
    ]);
    const fd = makeFakeFdClient();
    const out = await runner.runBudgetRevertReminders({ today, db, freshdeskClient: fd });
    expect(fd.createTicket).toHaveBeenCalledTimes(1);
    expect(fd.createTicket.mock.calls[0][0].subject).toMatch(/Dealer A/);
    expect(out.ticketsFiled).toBe(1);
    expect(db.rows[0].status).toBe('notified');
    expect(db.rows[0].ticket_id).toBe('TKT-1');
  });

  test('two pending rows for same dealer → ONE ticket, both rows marked notified with same ticket id', async () => {
    const runner = require('../../src/services/budget-revert-runner');
    const today = new Date('2026-06-01T08:00:00Z');
    const db = makeFakeDb([
      { id: 1, dealer_name: 'Dealer A', status: 'pending', revert_due_date: today,
        bump_amount: 30, baseline_monthly_budget: 3000, bumped_monthly_budget: 3030 },
      { id: 2, dealer_name: 'Dealer A', status: 'pending', revert_due_date: today,
        bump_amount: 50, baseline_monthly_budget: 3030, bumped_monthly_budget: 3080 },
    ]);
    const fd = makeFakeFdClient();
    await runner.runBudgetRevertReminders({ today, db, freshdeskClient: fd });
    expect(fd.createTicket).toHaveBeenCalledTimes(1);
    const subj = fd.createTicket.mock.calls[0][0].subject;
    expect(subj).toMatch(/80/);
    expect(db.rows[0].status).toBe('notified');
    expect(db.rows[1].status).toBe('notified');
    expect(db.rows[0].ticket_id).toBe('TKT-1');
    expect(db.rows[1].ticket_id).toBe('TKT-1');
  });

  test('rows with status=notified are skipped (idempotent)', async () => {
    const runner = require('../../src/services/budget-revert-runner');
    const today = new Date('2026-06-01T08:00:00Z');
    const db = makeFakeDb([
      { id: 1, dealer_name: 'Dealer A', status: 'notified', revert_due_date: today,
        bump_amount: 30, baseline_monthly_budget: 3000, bumped_monthly_budget: 3030,
        ticket_id: 'TKT-OLD' },
    ]);
    const fd = makeFakeFdClient();
    const out = await runner.runBudgetRevertReminders({ today, db, freshdeskClient: fd });
    expect(fd.createTicket).not.toHaveBeenCalled();
    expect(out.ticketsFiled).toBe(0);
  });

  test('no freshdesk client → exits cleanly without errors', async () => {
    const runner = require('../../src/services/budget-revert-runner');
    const today = new Date('2026-06-01T08:00:00Z');
    const db = makeFakeDb([]);
    const out = await runner.runBudgetRevertReminders({ today, db, freshdeskClient: null });
    expect(out.fdNotConfigured).toBe(true);
  });
});
