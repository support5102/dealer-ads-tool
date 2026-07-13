/**
 * DB-path test for deleteGoal(): a dealer with a pending budget revert must be
 * deletable. pending_budget_reverts.applied_change_id holds an FK into
 * dealer_budget_changes, so deleteGoal must clear the revert rows BEFORE the
 * history rows or Postgres raises 23503 (seen in prod 2026-07-13: "won't let
 * me delete dealers" for Thayer CDJR / Car2Sell East Windsor).
 *
 * Uses a fake pg pool that enforces the same FK the real schema has.
 */

jest.mock('../../src/services/database');

// ── Fake Postgres with the production FK behavior ────────────────────────────
function makeFakeDb() {
  const state = {
    goals: [{ dealer_name: 'Dealer A' }],
    changes: [{ id: 1, dealer_name: 'Dealer A', linked_revert_id: null }],
    reverts: [{ id: 9, dealer_name: 'Dealer A', applied_change_id: 1 }],
    queries: [],
  };

  async function query(sql, params = []) {
    state.queries.push(sql.trim().split(/\s+/).slice(0, 4).join(' '));
    const dealer = params[0];

    if (/DELETE\s+FROM\s+pending_budget_reverts/i.test(sql)) {
      state.reverts = state.reverts.filter((r) => r.dealer_name !== dealer);
      return { rowCount: 1 };
    }
    if (/UPDATE\s+dealer_budget_changes\s+SET\s+linked_revert_id/i.test(sql)) {
      for (const c of state.changes) if (c.dealer_name === dealer) c.linked_revert_id = null;
      return { rowCount: 1 };
    }
    if (/DELETE\s+FROM\s+dealer_budget_changes/i.test(sql)) {
      const doomedIds = state.changes.filter((c) => c.dealer_name === dealer).map((c) => c.id);
      if (state.reverts.some((r) => doomedIds.includes(r.applied_change_id))) {
        const err = new Error(
          'update or delete on table "dealer_budget_changes" violates foreign key ' +
          'constraint "pending_budget_reverts_applied_change_id_fkey" on table "pending_budget_reverts"');
        err.code = '23503';
        throw err;
      }
      state.changes = state.changes.filter((c) => c.dealer_name !== dealer);
      return { rowCount: doomedIds.length };
    }
    if (/DELETE\s+FROM\s+dealer_goals/i.test(sql)) {
      state.goals = state.goals.filter((g) => g.dealer_name !== dealer);
      return { rowCount: 1 };
    }
    // BEGIN / COMMIT / ROLLBACK / anything else
    return { rowCount: 0 };
  }

  const client = { query, release: jest.fn() };
  const pool = { query, connect: jest.fn().mockResolvedValue(client) };
  return { state, pool, client };
}

describe('deleteGoal() — DB path with pending revert (FK 23503 regression)', () => {
  let store, fake;

  beforeEach(() => {
    jest.resetModules();
    fake = makeFakeDb();
    // Re-require AFTER resetModules so the mock instance is the one the store sees.
    const db = require('../../src/services/database');
    db.getPool.mockReturnValue(fake.pool);
    store = require('../../src/services/dealer-goals-store');
  });

  test('deletes a dealer that has a pending budget revert', async () => {
    await expect(store.deleteGoal('Dealer A')).resolves.not.toThrow();
    expect(fake.state.goals).toHaveLength(0);
    expect(fake.state.changes).toHaveLength(0);
    expect(fake.state.reverts).toHaveLength(0);
  });

  test('rolls back on unexpected mid-delete failure', async () => {
    // Make the goals delete blow up after reverts/changes were deleted.
    const origQuery = fake.client.query;
    fake.client.query = async (sql, params) => {
      if (/DELETE\s+FROM\s+dealer_goals/i.test(sql)) throw new Error('boom');
      return origQuery(sql, params);
    };
    fake.pool.query = fake.client.query;
    fake.pool.connect = jest.fn().mockResolvedValue(fake.client);
    await expect(store.deleteGoal('Dealer A')).rejects.toThrow('boom');
    // ROLLBACK must have been issued after the failure
    expect(fake.state.queries.some((q) => /^ROLLBACK/i.test(q))).toBe(true);
  });
});
