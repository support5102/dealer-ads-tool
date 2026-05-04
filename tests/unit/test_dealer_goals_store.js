/**
 * Tests for dealer-goals-store.js — exercises in-memory fallback (no DATABASE_URL).
 *
 * All tests run without a Postgres connection. DATABASE_URL must not be set.
 */

const store = require('../../src/services/dealer-goals-store');

// Ensure no DB URL leaks in from environment
beforeAll(() => {
  delete process.env.DATABASE_URL;
});

// Reset in-memory state before each test
beforeEach(() => {
  store._resetForTesting();
});

// ─────────────────────────────────────────────────────────────────────────────
// Basic CRUD
// ─────────────────────────────────────────────────────────────────────────────

describe('upsertGoal() — create', () => {
  test('creates a new dealer and is retrievable via goalFor after loadAll', async () => {
    await store.upsertGoal({ dealerName: 'Honda of Spring Hill', monthlyBudget: 5000 });
    await store.loadAll();

    const goal = store.goalFor('Honda of Spring Hill');
    expect(goal).not.toBeNull();
    expect(goal.dealerName).toBe('Honda of Spring Hill');
    expect(goal.monthlyBudget).toBe(5000);
  });

  test('created goal has correct defaults for optional fields', async () => {
    await store.upsertGoal({ dealerName: 'Test Dealer', monthlyBudget: 1000 });
    await store.loadAll();

    const goal = store.goalFor('Test Dealer');
    expect(goal.newBudget).toBeNull();
    expect(goal.usedBudget).toBeNull();
    expect(goal.miscNotes).toBeNull();
    expect(goal.pacingMode).toBe('one_click');
    expect(goal.pacingCurveId).toBeNull();
    expect(goal.vlaBudget).toBeNull();
    expect(goal.keywordBudget).toBeNull();
  });
});

describe('upsertGoal() — update', () => {
  test('updates non-budget fields on existing dealer', async () => {
    await store.upsertGoal({ dealerName: 'Honda of Spring Hill', monthlyBudget: 5000 });
    await store.upsertGoal({
      dealerName: 'Honda of Spring Hill',
      monthlyBudget: 5000,
      pacingMode: 'aggressive',
      pacingCurveId: 'linear',
      miscNotes: 'Updated notes',
      newBudget: 3000,
      usedBudget: 2000,
    });
    await store.loadAll();

    const goal = store.goalFor('Honda of Spring Hill');
    expect(goal.pacingMode).toBe('aggressive');
    expect(goal.pacingCurveId).toBe('linear');
    expect(goal.miscNotes).toBe('Updated notes');
    expect(goal.newBudget).toBe(3000);
    expect(goal.usedBudget).toBe(2000);
  });

  test('update on existing dealer does NOT write an additional audit entry', async () => {
    await store.upsertGoal({ dealerName: 'Honda of Spring Hill', monthlyBudget: 5000 });
    await store.upsertGoal({ dealerName: 'Honda of Spring Hill', monthlyBudget: 5000, pacingMode: 'aggressive' });

    const history = await store.getBudgetHistory('Honda of Spring Hill');
    // Only the initial "Dealer added" entry from creation
    expect(history).toHaveLength(1);
    expect(history[0].note).toBe('Dealer added');
  });
});

describe('goalFor()', () => {
  test('returns null for unknown dealer', async () => {
    await store.loadAll(); // warm cache
    expect(store.goalFor('Unknown Dealer')).toBeNull();
  });

  test('returns null and triggers reload when cache is stale', () => {
    // Cache starts null after _resetForTesting
    const result = store.goalFor('Anyone');
    expect(result).toBeNull();
  });
});

describe('allGoals()', () => {
  test('returns empty array when no goals exist', async () => {
    await store.loadAll();
    expect(store.allGoals()).toEqual([]);
  });

  test('returns all created dealers', async () => {
    await store.upsertGoal({ dealerName: 'Dealer A', monthlyBudget: 1000 });
    await store.upsertGoal({ dealerName: 'Dealer B', monthlyBudget: 2000 });
    await store.loadAll();

    const goals = store.allGoals();
    expect(goals).toHaveLength(2);
    expect(goals.map(g => g.dealerName).sort()).toEqual(['Dealer A', 'Dealer B']);
  });
});

describe('deleteGoal()', () => {
  test('removes the dealer from the store', async () => {
    await store.upsertGoal({ dealerName: 'Dealer A', monthlyBudget: 1000 });
    await store.deleteGoal('Dealer A');
    await store.loadAll();

    expect(store.goalFor('Dealer A')).toBeNull();
    expect(store.allGoals()).toHaveLength(0);
  });

  test('cascades — removes budget history for that dealer', async () => {
    await store.upsertGoal({ dealerName: 'Dealer A', monthlyBudget: 1000 });
    await store.updateMonthlyBudget('Dealer A', 2000, 'Increase budget', 'admin');
    await store.deleteGoal('Dealer A');

    const history = await store.getBudgetHistory('Dealer A');
    expect(history).toHaveLength(0);
  });

  test('does not affect other dealers budget history', async () => {
    await store.upsertGoal({ dealerName: 'Dealer A', monthlyBudget: 1000 });
    await store.upsertGoal({ dealerName: 'Dealer B', monthlyBudget: 2000 });
    await store.updateMonthlyBudget('Dealer B', 3000, 'Increase B', 'admin');
    await store.deleteGoal('Dealer A');

    const historyB = await store.getBudgetHistory('Dealer B');
    // Dealer added + one budget change
    expect(historyB).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Budget-change validation (CRITICAL)
// ─────────────────────────────────────────────────────────────────────────────

describe('updateMonthlyBudget() — validation', () => {
  beforeEach(async () => {
    await store.upsertGoal({ dealerName: 'Test Dealer', monthlyBudget: 5000 });
  });

  test('succeeds with valid note (5+ chars) and positive budget', async () => {
    await expect(
      store.updateMonthlyBudget('Test Dealer', 6000, 'Valid', 'admin')
    ).resolves.toBeUndefined();
  });

  test('succeeds with exactly 5-character note', async () => {
    await expect(
      store.updateMonthlyBudget('Test Dealer', 6000, 'exact', 'admin')
    ).resolves.toBeUndefined();
  });

  test('throws when note is null', async () => {
    await expect(
      store.updateMonthlyBudget('Test Dealer', 6000, null, 'admin')
    ).rejects.toThrow('Note must be at least 5 characters');
  });

  test('throws when note is undefined', async () => {
    await expect(
      store.updateMonthlyBudget('Test Dealer', 6000, undefined, 'admin')
    ).rejects.toThrow('Note must be at least 5 characters');
  });

  test('throws when note is empty string', async () => {
    await expect(
      store.updateMonthlyBudget('Test Dealer', 6000, '', 'admin')
    ).rejects.toThrow('Note must be at least 5 characters');
  });

  test('throws when note is 4 characters (too short)', async () => {
    await expect(
      store.updateMonthlyBudget('Test Dealer', 6000, 'abcd', 'admin')
    ).rejects.toThrow('Note must be at least 5 characters');
  });

  test('throws when budget is zero', async () => {
    await expect(
      store.updateMonthlyBudget('Test Dealer', 0, 'Valid note here', 'admin')
    ).rejects.toThrow('Monthly budget must be a positive number');
  });

  test('throws when budget is negative', async () => {
    await expect(
      store.updateMonthlyBudget('Test Dealer', -100, 'Valid note here', 'admin')
    ).rejects.toThrow('Monthly budget must be a positive number');
  });

  test('throws when budget is a string', async () => {
    await expect(
      store.updateMonthlyBudget('Test Dealer', '5000', 'Valid note here', 'admin')
    ).rejects.toThrow('Monthly budget must be a positive number');
  });

  test('throws when dealer does not exist', async () => {
    await expect(
      store.updateMonthlyBudget('Nonexistent Dealer', 6000, 'Valid note here', 'admin')
    ).rejects.toThrow('Dealer not found: Nonexistent Dealer');
  });

  test('writes changed_by from param', async () => {
    await store.updateMonthlyBudget('Test Dealer', 7000, 'Budget increase', 'brian@savvy');

    const history = await store.getBudgetHistory('Test Dealer');
    const budgetChange = history.find(h => h.note === 'Budget increase');
    expect(budgetChange).toBeDefined();
    expect(budgetChange.changedBy).toBe('brian@savvy');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Budget history
// ─────────────────────────────────────────────────────────────────────────────

describe('getBudgetHistory()', () => {
  test('returns empty array for unknown dealer', async () => {
    const history = await store.getBudgetHistory('Nobody');
    expect(history).toEqual([]);
  });

  test('returns 3 entries in reverse chronological order after 3 changes', async () => {
    await store.upsertGoal({ dealerName: 'Dealer A', monthlyBudget: 1000 });
    await store.updateMonthlyBudget('Dealer A', 2000, 'First increase', 'admin');
    await store.updateMonthlyBudget('Dealer A', 3000, 'Second bump', 'admin');
    await store.updateMonthlyBudget('Dealer A', 4000, 'Third raise', 'admin');

    const history = await store.getBudgetHistory('Dealer A');
    // Dealer added + 3 budget changes = 4 total
    expect(history).toHaveLength(4);

    // Reverse chronological: newest first
    expect(history[0].newBudget).toBe(4000);
    expect(history[1].newBudget).toBe(3000);
    expect(history[2].newBudget).toBe(2000);
    expect(history[3].note).toBe('Dealer added');
  });

  test('each entry has old_budget, new_budget, note, changed_at, changed_by', async () => {
    await store.upsertGoal({ dealerName: 'Dealer A', monthlyBudget: 1000 });
    await store.updateMonthlyBudget('Dealer A', 2000, 'Budget raise', 'admin');

    const history = await store.getBudgetHistory('Dealer A');
    const change = history.find(h => h.note === 'Budget raise');
    expect(change).toBeDefined();
    expect(change).toHaveProperty('oldBudget', 1000);
    expect(change).toHaveProperty('newBudget', 2000);
    expect(change).toHaveProperty('note', 'Budget raise');
    expect(change).toHaveProperty('changedAt');
    expect(change).toHaveProperty('changedBy', 'admin');
  });

  test('old budget on first change is the initial monthly budget', async () => {
    await store.upsertGoal({ dealerName: 'Dealer A', monthlyBudget: 5000 });
    await store.updateMonthlyBudget('Dealer A', 7500, 'Raise it', 'admin');

    const history = await store.getBudgetHistory('Dealer A');
    const change = history.find(h => h.note === 'Raise it');
    expect(change.oldBudget).toBe(5000);
    expect(change.newBudget).toBe(7500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit on dealer creation
// ─────────────────────────────────────────────────────────────────────────────

describe('upsertGoal() — audit entry on creation', () => {
  test('writes "Dealer added" audit entry for new dealer', async () => {
    await store.upsertGoal({ dealerName: 'New Dealer', monthlyBudget: 3000 });

    const history = await store.getBudgetHistory('New Dealer');
    expect(history).toHaveLength(1);
    expect(history[0].note).toBe('Dealer added');
    expect(history[0].oldBudget).toBeNull();
    expect(history[0].newBudget).toBe(3000);
  });

  test('second upsert (update) on same dealer does NOT write another audit entry', async () => {
    await store.upsertGoal({ dealerName: 'Existing Dealer', monthlyBudget: 3000 });
    await store.upsertGoal({ dealerName: 'Existing Dealer', monthlyBudget: 3000, pacingMode: 'aggressive' });

    const history = await store.getBudgetHistory('Existing Dealer');
    expect(history).toHaveLength(1);
    expect(history[0].note).toBe('Dealer added');
  });

  test('audit entry from upsert captures the initial monthly budget', async () => {
    await store.upsertGoal({ dealerName: 'Brand New', monthlyBudget: 12000 });

    const history = await store.getBudgetHistory('Brand New');
    expect(history[0].newBudget).toBe(12000);
    expect(history[0].oldBudget).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache invalidation
// ─────────────────────────────────────────────────────────────────────────────

describe('cache invalidation', () => {
  test('goalFor reflects new budget on next loadAll after updateMonthlyBudget', async () => {
    await store.upsertGoal({ dealerName: 'Cache Test', monthlyBudget: 5000 });
    await store.loadAll(); // warm cache

    expect(store.goalFor('Cache Test').monthlyBudget).toBe(5000);

    await store.updateMonthlyBudget('Cache Test', 8000, 'Price change', 'admin');
    await store.loadAll(); // reload after write

    expect(store.goalFor('Cache Test').monthlyBudget).toBe(8000);
  });

  test('allGoals is empty immediately after write (cache invalidated) until next loadAll', async () => {
    await store.upsertGoal({ dealerName: 'Cache Test', monthlyBudget: 5000 });
    await store.loadAll();

    expect(store.allGoals()).toHaveLength(1);

    await store.updateMonthlyBudget('Cache Test', 9000, 'New amount', 'admin');
    // Cache is now null — allGoals returns [] and triggers background reload
    expect(store.allGoals()).toHaveLength(0);

    await store.loadAll(); // explicit reload
    expect(store.allGoals()).toHaveLength(1);
    expect(store.allGoals()[0].monthlyBudget).toBe(9000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyBudgetAdjust() — in-memory path
// ─────────────────────────────────────────────────────────────────────────────

const MAY_15 = new Date(Date.UTC(2026, 4, 15, 12, 0, 0));

describe('applyBudgetAdjust() — month scope', () => {
  beforeEach(async () => {
    await store.upsertGoal({ dealerName: 'Test Dealer', monthlyBudget: 3000 });
  });

  test('+$30 month: writes monthly_budget=3030 + daily_budget synced + audit row, no pending revert', async () => {
    const result = await store.applyBudgetAdjust({
      dealerName: 'Test Dealer',
      scope: 'month',
      amount: 30,
      note: 'Permanent monthly bump',
      changedBy: 'tester@example.com',
      today: MAY_15,
    });

    expect(result.newMonthlyBudget).toBe(3030);
    expect(result.pendingRevertId).toBeNull();

    await store.loadAll();
    const goal = store.goalFor('Test Dealer');
    expect(goal.monthlyBudget).toBe(3030);
    expect(goal.dailyBudget).toBeCloseTo(3030 / 31, 2);

    const history = await store.getBudgetHistory('Test Dealer');
    expect(history[0].newBudget).toBe(3030);
    expect(history[0].changeScope).toBe('month');
    expect(history[0].changeAmount).toBe(30);
  });
});

describe('applyBudgetAdjust() — day scope', () => {
  beforeEach(async () => {
    await store.upsertGoal({ dealerName: 'Test Dealer', monthlyBudget: 3000 });
  });

  test('+$30 day forward (prorated): correct monthly + daily on May 15', async () => {
    const result = await store.applyBudgetAdjust({
      dealerName: 'Test Dealer',
      scope: 'day', daySubScope: 'forward', amount: 30,
      note: 'Push hard the rest of this month',
      today: MAY_15,
    });
    expect(result.newMonthlyBudget).toBe(3510);

    await store.loadAll();
    const goal = store.goalFor('Test Dealer');
    expect(goal.monthlyBudget).toBe(3510);
    expect(goal.dailyBudget).toBeCloseTo(3000 / 31 + 30, 1);
  });
});

describe('applyBudgetAdjust() — rest_of_month scope', () => {
  beforeEach(async () => {
    await store.upsertGoal({ dealerName: 'Test Dealer', monthlyBudget: 3000 });
  });

  test('+$30 rest-of-month: writes monthly=3030, daily UNCHANGED, creates pending revert row', async () => {
    const result = await store.applyBudgetAdjust({
      dealerName: 'Test Dealer',
      scope: 'rest_of_month', amount: 30,
      note: 'Just for May',
      today: MAY_15,
    });

    expect(result.newMonthlyBudget).toBe(3030);
    expect(result.pendingRevertId).not.toBeNull();

    await store.loadAll();
    const goal = store.goalFor('Test Dealer');
    expect(goal.monthlyBudget).toBe(3030);
    expect(goal.dailyBudget == null).toBe(true);

    const pending = await store.getPendingRevert('Test Dealer');
    expect(pending).not.toBeNull();
    expect(pending.bumpAmount).toBe(30);
    expect(pending.baselineMonthlyBudget).toBe(3000);
    expect(pending.bumpedMonthlyBudget).toBe(3030);
    expect(pending.status).toBe('pending');
    expect(pending.revertDueDate.toISOString().slice(0, 10)).toBe('2026-06-01');
  });
});

describe('applyBudgetAdjust() — pending-revert cancellation (E2/E3)', () => {
  beforeEach(async () => {
    await store.upsertGoal({ dealerName: 'Test Dealer', monthlyBudget: 3000 });
    await store.applyBudgetAdjust({
      dealerName: 'Test Dealer',
      scope: 'rest_of_month', amount: 30,
      note: 'First bump',
      today: MAY_15,
    });
  });

  test('subsequent month-scope adjust cancels the pending revert', async () => {
    await store.applyBudgetAdjust({
      dealerName: 'Test Dealer',
      scope: 'month', amount: 100,
      note: 'Make it permanent and bigger',
      today: MAY_15,
    });
    const pending = await store.getPendingRevert('Test Dealer');
    expect(pending).toBeNull();
  });

  test('subsequent set-total cancels the pending revert', async () => {
    await store.updateMonthlyBudget('Test Dealer', 5000, 'Reset to flat target', 'tester@example.com');
    const pending = await store.getPendingRevert('Test Dealer');
    expect(pending).toBeNull();
  });
});

describe('applyBudgetAdjust() — validation', () => {
  beforeEach(async () => {
    await store.upsertGoal({ dealerName: 'Test Dealer', monthlyBudget: 3000 });
  });

  test('note shorter than 5 chars throws', async () => {
    await expect(store.applyBudgetAdjust({
      dealerName: 'Test Dealer', scope: 'month', amount: 30, note: 'x', today: MAY_15,
    })).rejects.toThrow(/at least 5 characters/);
  });

  test('unknown dealer throws', async () => {
    await expect(store.applyBudgetAdjust({
      dealerName: 'Nonexistent', scope: 'month', amount: 30, note: 'valid note', today: MAY_15,
    })).rejects.toThrow(/not found/);
  });
});

describe('updateMonthlyBudget() — extended behaviour', () => {
  beforeEach(async () => {
    await store.upsertGoal({ dealerName: 'Test Dealer', monthlyBudget: 3000 });
  });

  test('writes daily_budget = new_monthly / D', async () => {
    await store.updateMonthlyBudget('Test Dealer', 4200, 'flat target', 'tester', { today: MAY_15 });

    await store.loadAll();
    const goal = store.goalFor('Test Dealer');
    expect(goal.monthlyBudget).toBe(4200);
    expect(goal.dailyBudget).toBeCloseTo(4200 / 31, 2);
  });
});
