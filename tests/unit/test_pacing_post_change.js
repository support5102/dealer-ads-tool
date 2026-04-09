/**
 * Unit tests for post-change daily average and spend overrides.
 *
 * Tier 2 (unit): uses _queryFn injection with fake data, no real API calls.
 *
 * Tests: getLastBudgetChange, getDailySpendBreakdown, applySpendOverrides,
 *        findRedirectsTo, computePostChangeAvg
 */

const {
  getLastBudgetChange,
  getDailySpendBreakdown,
} = require('../../src/services/google-ads');

const {
  applySpendOverrides,
  findRedirectsTo,
  computePostChangeAvg,
} = require('../../src/routes/pacing');

function fakeCtx(rows) {
  return {
    accessToken: 'fake-token',
    developerToken: 'fake-dev',
    customerId: '1234567890',
    loginCustomerId: '9999999999',
    _queryFn: async () => rows,
  };
}

// ===========================================================================
// getLastBudgetChange
// ===========================================================================

describe('getLastBudgetChange', () => {
  test('returns changeDate when a budget change exists', async () => {
    const rows = [{ changeEvent: { changeDateTime: '2026-03-15 14:30:00' } }];
    const result = await getLastBudgetChange(fakeCtx(rows));
    expect(result).toEqual({ changeDate: '2026-03-15' });
  });

  test('returns null when no budget changes this month', async () => {
    const result = await getLastBudgetChange(fakeCtx([]));
    expect(result).toEqual({ changeDate: null });
  });

  test('returns null on query failure (non-fatal)', async () => {
    const ctx = {
      ...fakeCtx([]),
      _queryFn: async () => { throw new Error('API error'); },
    };
    const result = await getLastBudgetChange(ctx);
    expect(result).toEqual({ changeDate: null });
  });
});

// ===========================================================================
// getDailySpendBreakdown
// ===========================================================================

describe('getDailySpendBreakdown', () => {
  test('returns per-day per-campaign spend', async () => {
    const rows = [
      { segments: { date: '2026-03-01' }, campaign: { id: '100', name: 'Brand' }, metrics: { costMicros: 5000000 } },
      { segments: { date: '2026-03-01' }, campaign: { id: '200', name: 'VLA' }, metrics: { costMicros: 3000000 } },
      { segments: { date: '2026-03-02' }, campaign: { id: '100', name: 'Brand' }, metrics: { costMicros: 4500000 } },
    ];
    const result = await getDailySpendBreakdown(fakeCtx(rows));

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ date: '2026-03-01', campaignId: '100', campaignName: 'Brand', spend: 5.00 });
    expect(result[1]).toEqual({ date: '2026-03-01', campaignId: '200', campaignName: 'VLA', spend: 3.00 });
    expect(result[2]).toEqual({ date: '2026-03-02', campaignId: '100', campaignName: 'Brand', spend: 4.50 });
  });

  test('handles missing costMicros as zero', async () => {
    const rows = [
      { segments: { date: '2026-03-01' }, campaign: { id: '1', name: 'X' }, metrics: {} },
    ];
    const result = await getDailySpendBreakdown(fakeCtx(rows));
    expect(result[0].spend).toBe(0);
  });
});

// ===========================================================================
// applySpendOverrides
// ===========================================================================

describe('applySpendOverrides', () => {
  const spend = [
    { campaignId: '100', campaignName: 'Brand Campaign', spend: 50 },
    { campaignId: '200', campaignName: 'Pmax- Used VLA - Allstar Car Sales', spend: 30 },
    { campaignId: '300', campaignName: 'General Search', spend: 20 },
  ];

  test('adds redirected spend to target account', () => {
    const redirected = [{ campaignId: '200', campaignName: 'Pmax- Used VLA - Allstar Car Sales', spend: 30 }];
    const result = applySpendOverrides([], 'allstar car sales', redirected);
    expect(result).toHaveLength(1);
    expect(result[0].spend).toBe(30);
  });

  test('passes through unchanged for accounts without overrides', () => {
    const result = applySpendOverrides(spend, 'some other dealer', []);
    expect(result).toHaveLength(3);
  });
});

// ===========================================================================
// findRedirectsTo
// ===========================================================================

describe('findRedirectsTo', () => {
  test('returns empty when no overrides configured', () => {
    expect(findRedirectsTo('allstar car sales')).toHaveLength(0);
  });

  test('returns empty for accounts with no redirects', () => {
    expect(findRedirectsTo('some other dealer')).toHaveLength(0);
  });
});

// ===========================================================================
// computePostChangeAvg
// ===========================================================================

describe('computePostChangeAvg', () => {
  const dailyBreakdown = [
    { date: '2026-03-10', campaignId: '100', campaignName: 'Brand', spend: 40 },
    { date: '2026-03-10', campaignId: '200', campaignName: 'VLA', spend: 20 },
    { date: '2026-03-15', campaignId: '100', campaignName: 'Brand', spend: 50 },
    { date: '2026-03-15', campaignId: '200', campaignName: 'VLA', spend: 25 },
    { date: '2026-03-16', campaignId: '100', campaignName: 'Brand', spend: 55 },
    { date: '2026-03-16', campaignId: '200', campaignName: 'VLA', spend: 30 },
  ];

  test('computes average from change date onward', () => {
    const result = computePostChangeAvg(dailyBreakdown, '2026-03-15');
    // Day 15: 50+25=75, Day 16: 55+30=85 → avg = (75+85)/2 = 80
    expect(result.changeDate).toBe('2026-03-15');
    expect(result.daysTracked).toBe(2);
    expect(result.dailyAvg).toBe(80);
  });

  test('excludes specified campaigns from average', () => {
    const result = computePostChangeAvg(dailyBreakdown, '2026-03-15', ['VLA']);
    // Day 15: 50, Day 16: 55 → avg = 52.50
    expect(result.daysTracked).toBe(2);
    expect(result.dailyAvg).toBe(52.50);
  });

  test('returns zero when no data after change date', () => {
    const result = computePostChangeAvg(dailyBreakdown, '2026-03-20');
    expect(result.daysTracked).toBe(0);
    expect(result.dailyAvg).toBe(0);
  });

  test('includes the change date itself', () => {
    const result = computePostChangeAvg(dailyBreakdown, '2026-03-16');
    // Day 16 only: 55+30=85
    expect(result.daysTracked).toBe(1);
    expect(result.dailyAvg).toBe(85);
  });
});
