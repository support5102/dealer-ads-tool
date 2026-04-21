/**
 * Tests the DB-backed path of goal-reader when USE_DB_GOALS=true.
 * Uses in-memory dealer-goals-store (no DATABASE_URL needed).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Env helpers — required vars must be present for validateEnv() to succeed
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_ENV = {
  GOOGLE_ADS_DEVELOPER_TOKEN: 'test-dev-token',
  GOOGLE_ADS_CLIENT_ID:       'test-client-id',
  GOOGLE_ADS_CLIENT_SECRET:   'test-client-secret',
  SESSION_SECRET:             'test-session-secret',
  ANTHROPIC_API_KEY:          'test-anthropic-key',
};

beforeAll(() => {
  // Ensure no DB URL (forces in-memory fallback in dealer-goals-store)
  delete process.env.DATABASE_URL;
  // Inject required vars so validateEnv() doesn't throw
  Object.assign(process.env, REQUIRED_ENV);
});

afterAll(() => {
  // Clean up injected vars
  for (const key of Object.keys(REQUIRED_ENV)) {
    delete process.env[key];
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache-busting helper — must clear config + goal-reader between flag toggles
// ─────────────────────────────────────────────────────────────────────────────

function bustGoalReaderCache() {
  delete require.cache[require.resolve('../../src/utils/config')];
  delete require.cache[require.resolve('../../src/services/goal-reader')];
}

// ─────────────────────────────────────────────────────────────────────────────
// Store reference — seeded via upsertGoal, reset between tests
// ─────────────────────────────────────────────────────────────────────────────

const store = require('../../src/services/dealer-goals-store');

beforeEach(() => {
  store._resetForTesting();
});

// ─────────────────────────────────────────────────────────────────────────────
// readGoals — DB path
// ─────────────────────────────────────────────────────────────────────────────

describe('goal-reader — readGoals() with USE_DB_GOALS=true', () => {

  test('flag on, store populated: returns both dealers with correct DealerGoal shape', async () => {
    await store.upsertGoal({
      dealerName: 'Honda of Spring Hill',
      monthlyBudget: 5000,
      newBudget: 3000,
      usedBudget: 2000,
      miscNotes: 'Focus on SUVs',
      pacingMode: 'auto_apply',
      pacingCurveId: 'linear',
    });
    await store.upsertGoal({
      dealerName: 'Toyota Bradenton',
      monthlyBudget: 8000,
    });

    process.env.USE_DB_GOALS = 'true';
    bustGoalReaderCache();
    const { readGoals } = require('../../src/services/goal-reader');

    // Both sheet args null — proves DB path is taken (sheet path would throw on null spreadsheetId)
    const goals = await readGoals(null, null);

    expect(goals).toHaveLength(2);

    // Results are ordered by dealer_name (store returns loadAll order = insertion for in-memory)
    const honda = goals.find(g => g.dealerName === 'Honda of Spring Hill');
    const toyota = goals.find(g => g.dealerName === 'Toyota Bradenton');

    expect(honda).not.toBeUndefined();
    expect(honda.dealerName).toBe('Honda of Spring Hill');
    expect(honda.monthlyBudget).toBe(5000);
    expect(honda.newBudget).toBe(3000);
    expect(honda.usedBudget).toBe(2000);
    expect(honda.dealerNotes).toBe('Focus on SUVs');
    expect(honda.pacingMode).toBe('auto_apply');
    expect(honda.pacingCurveId).toBe('linear');
    expect(honda.baselineInventory).toBeNull();
    expect(honda.freshdeskTag).toBeNull();

    expect(toyota).not.toBeUndefined();
    expect(toyota.monthlyBudget).toBe(8000);
  });

  test('flag on, store empty: returns empty array', async () => {
    process.env.USE_DB_GOALS = 'true';
    bustGoalReaderCache();
    const { readGoals } = require('../../src/services/goal-reader');

    const goals = await readGoals(null, null);
    expect(goals).toEqual([]);
  });

  test('flag on: misc_notes flows through as dealerNotes; baselineInventory and freshdeskTag are always null', async () => {
    await store.upsertGoal({
      dealerName: 'Acura Naples',
      monthlyBudget: 4000,
      miscNotes: 'Luxury segment — conservative bids',
      pacingMode: 'advisory',
      pacingCurveId: 'even_spend',
    });

    process.env.USE_DB_GOALS = 'true';
    bustGoalReaderCache();
    const { readGoals } = require('../../src/services/goal-reader');

    const goals = await readGoals(null, null);
    expect(goals).toHaveLength(1);

    const g = goals[0];
    expect(g.dealerNotes).toBe('Luxury segment — conservative bids');
    expect(g.pacingMode).toBe('advisory');
    expect(g.pacingCurveId).toBe('even_spend');
    expect(g.baselineInventory).toBeNull();
    expect(g.freshdeskTag).toBeNull();
  });

  test('flag off: falls through to Sheets path and calls the sheets client', async () => {
    await store.upsertGoal({ dealerName: 'Should Not Appear', monthlyBudget: 1000 });

    process.env.USE_DB_GOALS = 'false';
    bustGoalReaderCache();
    const { readGoals } = require('../../src/services/goal-reader');

    // Build a fake sheets client that returns two known rows
    const fakeRows = [
      ['Sheets Dealer A', '6000', '3500', '2500', 'Notes A', 'one_click', null],
      ['Sheets Dealer B', '9000', null,   null,   null,      'advisory',  'curve_x'],
    ];
    const fakeSheetsClient = {
      spreadsheets: {
        values: {
          get: jest.fn().mockResolvedValue({ data: { values: fakeRows } }),
        },
      },
    };

    const goals = await readGoals(fakeSheetsClient, 'fake-spreadsheet-id');

    // Sheets client must have been called (proves sheet path was taken, not DB)
    expect(fakeSheetsClient.spreadsheets.values.get).toHaveBeenCalledTimes(1);
    expect(goals).toHaveLength(2);
    expect(goals[0].dealerName).toBe('Sheets Dealer A');
    expect(goals[1].dealerName).toBe('Sheets Dealer B');

    // DB-seeded dealer must NOT appear
    expect(goals.find(g => g.dealerName === 'Should Not Appear')).toBeUndefined();
  });

  test('null miscNotes defaults to null dealerNotes (not "null" string)', async () => {
    await store.upsertGoal({
      dealerName: 'Kia Clearwater',
      monthlyBudget: 3500,
      // no miscNotes passed → stored as null
    });

    process.env.USE_DB_GOALS = 'true';
    bustGoalReaderCache();
    const { readGoals } = require('../../src/services/goal-reader');

    const goals = await readGoals(null, null);
    expect(goals[0].dealerNotes).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readBudgetSplits — DB path
// ─────────────────────────────────────────────────────────────────────────────

describe('goal-reader — readBudgetSplits() with USE_DB_GOALS=true', () => {

  test('dealer with vla_budget + keyword_budget appears in the map', async () => {
    await store.upsertGoal({
      dealerName: 'Alan Jay Ford',
      monthlyBudget: 10000,
      vlaBudget: 3000,
      keywordBudget: 4000,
    });

    process.env.USE_DB_GOALS = 'true';
    bustGoalReaderCache();
    const { readBudgetSplits } = require('../../src/services/goal-reader');

    const splits = await readBudgetSplits(null, null);

    expect(splits).toBeInstanceOf(Map);
    expect(splits.size).toBe(1);
    expect(splits.has('alan jay ford')).toBe(true);

    const s = splits.get('alan jay ford');
    expect(s.ppcBudget).toBe(10000);
    expect(s.vlaBudget).toBe(3000);
    expect(s.keywordBudget).toBe(4000);
  });

  test('dealer without vla_budget and keyword_budget is excluded from the map', async () => {
    await store.upsertGoal({
      dealerName: 'No Splits Dealer',
      monthlyBudget: 5000,
      // vlaBudget and keywordBudget both null (defaults)
    });
    await store.upsertGoal({
      dealerName: 'Has Splits Dealer',
      monthlyBudget: 7000,
      vlaBudget: 2000,
      keywordBudget: 3000,
    });

    process.env.USE_DB_GOALS = 'true';
    bustGoalReaderCache();
    const { readBudgetSplits } = require('../../src/services/goal-reader');

    const splits = await readBudgetSplits(null, null);

    expect(splits.has('no splits dealer')).toBe(false);
    expect(splits.has('has splits dealer')).toBe(true);
    expect(splits.size).toBe(1);
  });

  test('all budget values are coerced to numbers (not null)', async () => {
    await store.upsertGoal({
      dealerName: 'Alan Jay Chevrolet',
      monthlyBudget: 12000,
      vlaBudget: 4500,
      keywordBudget: null,   // only vla set → still included (vla != null)
    });

    process.env.USE_DB_GOALS = 'true';
    bustGoalReaderCache();
    const { readBudgetSplits } = require('../../src/services/goal-reader');

    const splits = await readBudgetSplits(null, null);
    const s = splits.get('alan jay chevrolet');

    expect(typeof s.ppcBudget).toBe('number');
    expect(typeof s.vlaBudget).toBe('number');
    expect(typeof s.keywordBudget).toBe('number');

    expect(s.vlaBudget).toBe(4500);
    expect(s.keywordBudget).toBe(0);  // null → coerced to 0
    expect(s.ppcBudget).toBe(12000);
  });

  test('flag off: readBudgetSplits falls through to Sheets path and calls sheets client', async () => {
    process.env.USE_DB_GOALS = 'false';
    bustGoalReaderCache();
    const { readBudgetSplits } = require('../../src/services/goal-reader');

    const fakeRows = [
      ['Alan Jay Ford', '1', '500', '10000', '3000', '4000'],
    ];
    const fakeSheetsClient = {
      spreadsheets: {
        values: {
          get: jest.fn().mockResolvedValue({ data: { values: fakeRows } }),
        },
      },
    };

    const splits = await readBudgetSplits(fakeSheetsClient, 'fake-spreadsheet-id', 'Splits');

    expect(fakeSheetsClient.spreadsheets.values.get).toHaveBeenCalledTimes(1);
    expect(splits).toBeInstanceOf(Map);
    expect(splits.has('alan jay ford')).toBe(true);
  });
});
