/**
 * Verifies that the pacing-overview capture shape feeds the spend-history store
 * correctly (in-memory fallback, no DATABASE_URL).
 */

const store = require('../../src/services/dealer-spend-history-store');

beforeAll(() => { delete process.env.DATABASE_URL; });
beforeEach(() => { store._resetForTesting(); });

// Mirrors the mapping the pacing route performs on its `results` array.
function mapPacingResults(results) {
  return results.map(r => ({ dealerName: r.dealerName, totalSpend: r.mtdSpend, monthlyBudget: r.monthlyBudget }));
}

test('pacing results are captured one row per dealer for the current month', async () => {
  const now = new Date('2026-07-14T10:00:00Z');
  const results = [
    { dealerName: 'Thayer Chevrolet', mtdSpend: 1217.93, monthlyBudget: 2000 },
    { dealerName: 'Karl Flammer',     mtdSpend: 22350.61, monthlyBudget: 50000 },
  ];
  await store.recordManyForCurrentMonth(mapPacingResults(results), 'pacing-overview', now);

  const thayer = await store.getSpendHistory('Thayer Chevrolet');
  expect(thayer[0]).toMatchObject({ period: '2026-07-01', totalSpend: 1217.93, monthlyBudget: 2000, source: 'pacing-overview' });
  const karl = await store.getSpendHistory('Karl Flammer');
  expect(karl[0].totalSpend).toBe(22350.61);
});
