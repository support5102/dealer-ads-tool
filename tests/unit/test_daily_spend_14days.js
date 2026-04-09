/**
 * Unit tests for getDailySpendLast14Days.
 *
 * Tier 2 (unit): uses _queryFn injection with fake data, no real API calls.
 */

const { getDailySpendLast14Days } = require('../../src/services/google-ads');

function fakeCtx(rows) {
  return {
    accessToken: 'fake-token',
    developerToken: 'fake-dev',
    customerId: '1234567890',
    loginCustomerId: '9999999999',
    _queryFn: async () => rows,
  };
}

describe('getDailySpendLast14Days', () => {
  test('aggregates per-campaign rows into per-day totals', async () => {
    const rows = [
      { segments: { date: '2026-03-20' }, metrics: { costMicros: '5000000' } },
      { segments: { date: '2026-03-20' }, metrics: { costMicros: '3000000' } },
      { segments: { date: '2026-03-21' }, metrics: { costMicros: '7000000' } },
    ];
    const result = await getDailySpendLast14Days(fakeCtx(rows));
    expect(result).toEqual([
      { date: '2026-03-20', spend: 8 },
      { date: '2026-03-21', spend: 7 },
    ]);
  });

  test('returns sorted by date ascending', async () => {
    const rows = [
      { segments: { date: '2026-03-22' }, metrics: { costMicros: '2000000' } },
      { segments: { date: '2026-03-14' }, metrics: { costMicros: '4000000' } },
      { segments: { date: '2026-03-18' }, metrics: { costMicros: '6000000' } },
    ];
    const result = await getDailySpendLast14Days(fakeCtx(rows));
    expect(result[0].date).toBe('2026-03-14');
    expect(result[1].date).toBe('2026-03-18');
    expect(result[2].date).toBe('2026-03-22');
  });

  test('returns empty array when no data', async () => {
    const result = await getDailySpendLast14Days(fakeCtx([]));
    expect(result).toEqual([]);
  });

  test('handles missing costMicros gracefully', async () => {
    const rows = [
      { segments: { date: '2026-03-20' }, metrics: {} },
      { segments: { date: '2026-03-20' }, metrics: { costMicros: '1000000' } },
    ];
    const result = await getDailySpendLast14Days(fakeCtx(rows));
    expect(result).toEqual([{ date: '2026-03-20', spend: 1 }]);
  });

  test('builds correct date range in query', async () => {
    let capturedQuery = '';
    const ctx = {
      accessToken: 'fake-token',
      developerToken: 'fake-dev',
      customerId: '1234567890',
      loginCustomerId: '9999999999',
      _queryFn: async (_at, _dt, _cid, query) => {
        capturedQuery = query;
        return [];
      },
    };
    await getDailySpendLast14Days(ctx);
    expect(capturedQuery).toMatch(/BETWEEN '\d{4}-\d{2}-\d{2}' AND '\d{4}-\d{2}-\d{2}'/);
    expect(capturedQuery).toContain('campaign.status != \'REMOVED\'');
  });
});
