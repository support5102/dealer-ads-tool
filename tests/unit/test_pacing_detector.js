/**
 * Unit tests for pacing-detector.js
 */

const {
  detectInterventions,
  analyzeAccount,
  URGENCY,
} = require('../../src/services/pacing-detector');

// Helper: create an account with overrides
function makeAccount(overrides = {}) {
  return {
    customerId: '111-111-1111',
    dealerName: 'Test Dealer',
    monthlyBudget: 15000,
    mtdSpend: 10000,
    pacePercent: 100,       // on pace
    status: 'on_pace',
    dailyAdjustment: 0,
    sevenDayAvg: 500,
    sevenDayTrend: 'flat',
    sevenDayTrendPercent: 0,
    projectedSpend: 15000,
    projectedStatus: 'on_track',
    postChangeDailyAvg: null,
    changeDate: null,
    ...overrides,
  };
}

describe('analyzeAccount', () => {
  const thresholds = {
    paceVariance: 8,
    projectedMiss: 10,
    trendAcceleration: 15,
    minimumDaysElapsed: 5,
    minimumDailySpend: 5,
  };

  test('returns null for on-pace account', () => {
    expect(analyzeAccount(makeAccount(), thresholds)).toBeNull();
  });

  test('returns null for account with 0 budget', () => {
    expect(analyzeAccount(makeAccount({ monthlyBudget: 0 }), thresholds)).toBeNull();
  });

  test('flags critical over-pacing (>15%)', () => {
    const result = analyzeAccount(makeAccount({
      pacePercent: 118,   // +18% over
      projectedSpend: 18000,
    }), thresholds);
    expect(result).not.toBeNull();
    expect(result.urgency).toBe(URGENCY.CRITICAL);
    expect(result.direction).toBe('over');
  });

  test('flags critical under-pacing (>15%)', () => {
    const result = analyzeAccount(makeAccount({
      pacePercent: 82,    // -18% under
      projectedSpend: 11000,
    }), thresholds);
    expect(result).not.toBeNull();
    expect(result.urgency).toBe(URGENCY.CRITICAL);
    expect(result.direction).toBe('under');
  });

  test('flags high urgency for 10-15% variance', () => {
    const result = analyzeAccount(makeAccount({
      pacePercent: 112,   // +12% over
      projectedSpend: 16500,
    }), thresholds);
    expect(result.urgency).toBe(URGENCY.HIGH);
  });

  test('flags medium urgency for 8-10% variance', () => {
    const result = analyzeAccount(makeAccount({
      pacePercent: 109,   // +9% over
      projectedSpend: 15500,
    }), thresholds);
    expect(result.urgency).toBe(URGENCY.MEDIUM);
  });

  test('does not flag 7% variance (below threshold)', () => {
    const result = analyzeAccount(makeAccount({
      pacePercent: 107,
      projectedSpend: 15500,
    }), thresholds);
    expect(result).toBeNull();
  });

  test('flags based on projected miss even if pace is okay', () => {
    const result = analyzeAccount(makeAccount({
      pacePercent: 105,           // 5% over (below 8% threshold)
      projectedSpend: 17000,      // 13.3% over budget → projected miss triggers
    }), thresholds);
    expect(result).not.toBeNull();
    expect(result.urgency).toBe(URGENCY.MEDIUM); // 13.3% miss is between 10-15%
  });

  test('worsening trend bumps medium to high', () => {
    const result = analyzeAccount(makeAccount({
      pacePercent: 109,           // 9% over → medium
      projectedSpend: 15800,
      sevenDayTrend: 'up',        // spending increasing while over-pacing
      sevenDayTrendPercent: 20,   // >15% threshold
    }), thresholds);
    expect(result.urgency).toBe(URGENCY.HIGH);
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('trend worsening'),
    ]));
  });

  test('worsening trend does NOT bump if already high/critical', () => {
    const result = analyzeAccount(makeAccount({
      pacePercent: 112,           // 12% over → already high
      projectedSpend: 17000,
      sevenDayTrend: 'up',
      sevenDayTrendPercent: 25,
    }), thresholds);
    expect(result.urgency).toBe(URGENCY.HIGH); // stays high, not bumped to critical
  });

  test('includes correct direction', () => {
    const over = analyzeAccount(makeAccount({ pacePercent: 112, projectedSpend: 17000 }), thresholds);
    const under = analyzeAccount(makeAccount({ pacePercent: 88, projectedSpend: 12000 }), thresholds);
    expect(over.direction).toBe('over');
    expect(under.direction).toBe('under');
  });

  test('skips near-zero spend accounts', () => {
    const result = analyzeAccount(makeAccount({
      sevenDayAvg: 2,              // below $5/day minimum
      monthlyBudget: 100,          // expected daily ~$3.3, also below minimum
      pacePercent: 130,
      projectedSpend: 150,
    }), thresholds);
    expect(result).toBeNull();
  });

  test('does NOT skip if budget implies meaningful spend', () => {
    const result = analyzeAccount(makeAccount({
      sevenDayAvg: 2,              // low actual spend
      monthlyBudget: 15000,        // expected ~$500/day → meaningful
      pacePercent: 80,             // way under
      projectedSpend: 10000,
    }), thresholds);
    expect(result).not.toBeNull(); // flagged because budget is significant
  });
});

describe('detectInterventions', () => {
  test('returns empty array for null/empty input', () => {
    expect(detectInterventions(null)).toEqual([]);
    expect(detectInterventions([])).toEqual([]);
  });

  test('filters to only flagged accounts', () => {
    const accounts = [
      makeAccount({ customerId: 'A', pacePercent: 100, projectedSpend: 15000 }),  // ok
      makeAccount({ customerId: 'B', pacePercent: 118, projectedSpend: 18000 }),  // critical
      makeAccount({ customerId: 'C', pacePercent: 105, projectedSpend: 15500 }),  // ok
    ];
    const result = detectInterventions(accounts);
    expect(result).toHaveLength(1);
    expect(result[0].customerId).toBe('B');
  });

  test('sorts by urgency then by variance', () => {
    const accounts = [
      makeAccount({ customerId: 'A', pacePercent: 109, projectedSpend: 16000 }),  // medium, +9%
      makeAccount({ customerId: 'B', pacePercent: 120, projectedSpend: 19000 }),  // critical, +20%
      makeAccount({ customerId: 'C', pacePercent: 112, projectedSpend: 17000 }),  // high, +12%
      makeAccount({ customerId: 'D', pacePercent: 80, projectedSpend: 11000 }),   // critical, -20%
    ];
    const result = detectInterventions(accounts);
    expect(result).toHaveLength(4);
    // Critical first (B and D), sorted by abs variance
    expect(result[0].customerId).toBe('B'); // +20%
    expect(result[1].customerId).toBe('D'); // -20%
    // Then high
    expect(result[2].customerId).toBe('C'); // +12%
    // Then medium
    expect(result[3].customerId).toBe('A'); // +9%
  });

  test('allows threshold overrides', () => {
    const accounts = [
      makeAccount({ pacePercent: 106, projectedSpend: 15500 }),
    ];
    // Default threshold (8%) → not flagged
    expect(detectInterventions(accounts)).toHaveLength(0);
    // Custom threshold (5%) → flagged
    expect(detectInterventions(accounts, { paceVariance: 5 })).toHaveLength(1);
  });
});
