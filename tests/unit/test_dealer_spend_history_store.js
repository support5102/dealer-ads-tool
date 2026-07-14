/**
 * Tests for dealer-spend-history-store.js — in-memory fallback (no DATABASE_URL).
 */

const store = require('../../src/services/dealer-spend-history-store');

beforeAll(() => { delete process.env.DATABASE_URL; });
beforeEach(() => { store._resetForTesting(); });

describe('monthPeriod()', () => {
  test('returns first-of-month YYYY-MM-01 in UTC', () => {
    expect(store.monthPeriod(new Date('2026-07-14T12:00:00Z'))).toBe('2026-07-01');
    expect(store.monthPeriod(new Date('2026-01-31T23:59:00Z'))).toBe('2026-01-01');
  });
});

describe('recordSpend() + getSpendHistory()', () => {
  test('records a single month for a dealer', async () => {
    await store.recordSpend({ dealerName: 'Thayer Chevrolet', period: '2026-07-01', totalSpend: 1217.93, monthlyBudget: 2000, source: 'pacing-overview' });
    const hist = await store.getSpendHistory('Thayer Chevrolet');
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ dealerName: 'Thayer Chevrolet', period: '2026-07-01', totalSpend: 1217.93, monthlyBudget: 2000, source: 'pacing-overview' });
    expect(hist[0].updatedAt).toBeTruthy();
  });

  test('same (dealer, period) upsert overwrites, does not duplicate', async () => {
    await store.recordSpend({ dealerName: 'Karl Flammer', period: '2026-07-01', totalSpend: 100 });
    await store.recordSpend({ dealerName: 'Karl Flammer', period: '2026-07-01', totalSpend: 22350.61, monthlyBudget: 50000 });
    const hist = await store.getSpendHistory('Karl Flammer');
    expect(hist).toHaveLength(1);
    expect(hist[0].totalSpend).toBe(22350.61);
    expect(hist[0].monthlyBudget).toBe(50000);
  });

  test('distinct periods accumulate separate rows, newest first', async () => {
    await store.recordSpend({ dealerName: 'Cogswell Motors', period: '2026-05-01', totalSpend: 15000 });
    await store.recordSpend({ dealerName: 'Cogswell Motors', period: '2026-07-01', totalSpend: 7808.32 });
    await store.recordSpend({ dealerName: 'Cogswell Motors', period: '2026-06-01', totalSpend: 16000 });
    const hist = await store.getSpendHistory('Cogswell Motors');
    expect(hist.map(h => h.period)).toEqual(['2026-07-01', '2026-06-01', '2026-05-01']);
  });

  test('normalizes YYYY-MM and full dates to first-of-month', async () => {
    await store.recordSpend({ dealerName: 'X', period: '2026-07', totalSpend: 1 });
    await store.recordSpend({ dealerName: 'X', period: '2026-07-31', totalSpend: 2 });
    const hist = await store.getSpendHistory('X');
    expect(hist).toHaveLength(1);
    expect(hist[0].period).toBe('2026-07-01');
    expect(hist[0].totalSpend).toBe(2);
  });

  test('coerces numeric strings to numbers, missing budget is null', async () => {
    await store.recordSpend({ dealerName: 'Y', period: '2026-07-01', totalSpend: '123.45' });
    const hist = await store.getSpendHistory('Y');
    expect(hist[0].totalSpend).toBe(123.45);
    expect(hist[0].monthlyBudget).toBeNull();
  });

  test('unknown dealer returns empty array', async () => {
    expect(await store.getSpendHistory('Nobody')).toEqual([]);
  });
});

describe('recordManyForCurrentMonth()', () => {
  test('records one row per dealer for the current month, accepting mtdSpend or totalSpend', async () => {
    const now = new Date('2026-07-14T10:00:00Z');
    await store.recordManyForCurrentMonth([
      { dealerName: 'A', mtdSpend: 100, monthlyBudget: 500 },
      { dealerName: 'B', totalSpend: 200 },
    ], 'pacing-overview', now);
    expect((await store.getSpendHistory('A'))[0]).toMatchObject({ period: '2026-07-01', totalSpend: 100, monthlyBudget: 500, source: 'pacing-overview' });
    expect((await store.getSpendHistory('B'))[0]).toMatchObject({ period: '2026-07-01', totalSpend: 200 });
  });

  test('a bad row does not abort the batch', async () => {
    const now = new Date('2026-07-14T10:00:00Z');
    await store.recordManyForCurrentMonth([
      { dealerName: null, mtdSpend: 1 },       // bad — no dealer name
      { dealerName: 'Good', mtdSpend: 50 },
    ], 'pacing-overview', now);
    expect((await store.getSpendHistory('Good'))[0].totalSpend).toBe(50);
  });
});
