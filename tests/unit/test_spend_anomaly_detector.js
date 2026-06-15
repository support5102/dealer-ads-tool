/**
 * Unit tests for spend-anomaly-detector.
 *
 * Tier 2 (unit): pure logic + a scan wrapper exercised via _queryFn injection.
 */

const {
  detectSpendSpike,
  scanAccountForSpendSpike,
  formatSpikeAlert,
} = require('../../src/services/spend-anomaly-detector');

// Build a daily-spend series: baseline values followed by one candidate (last) day.
function series(baselineVals, candidate) {
  const arr = baselineVals.map((spend, i) => ({
    date: `2026-06-${String(i + 1).padStart(2, '0')}`,
    spend,
  }));
  arr.push({ date: '2026-06-30', spend: candidate });
  return arr;
}

describe('detectSpendSpike', () => {
  test('no spike for a normal day within the usual range', () => {
    const r = detectSpendSpike(series([100, 105, 98, 102, 100, 101, 99], 103));
    expect(r.isSpike).toBe(false);
    expect(r.reason).toBe('normal');
  });

  test('flags a clear spike above the z-score threshold', () => {
    const r = detectSpendSpike(series([100, 105, 98, 102, 100, 101, 99], 300));
    expect(r.isSpike).toBe(true);
    expect(r.reason).toBe('zscore_exceeded');
    expect(r.zScore).toBeGreaterThan(2.5);
    expect(r.spend).toBe(300);
  });

  test('returns insufficient_data when there are too few baseline days', () => {
    const r = detectSpendSpike([{ date: 'a', spend: 100 }, { date: 'b', spend: 500 }]);
    expect(r.isSpike).toBe(false);
    expect(r.reason).toBe('insufficient_data');
  });

  test('ignores spikes below the absolute dollar floor', () => {
    const r = detectSpendSpike(series([1, 1, 1, 1, 1, 1, 1], 10), { absoluteFloor: 20 });
    expect(r.isSpike).toBe(false);
    expect(r.reason).toBe('below_floor');
  });

  test('flat baseline: flags a large percentage jump', () => {
    const r = detectSpendSpike(series([100, 100, 100, 100, 100, 100], 160));
    expect(r.isSpike).toBe(true);
    expect(r.reason).toBe('flat_baseline_jump');
    expect(r.pctAboveMean).toBe(60);
  });

  test('flat baseline: does not flag a small percentage jump', () => {
    const r = detectSpendSpike(series([100, 100, 100, 100, 100, 100], 120), { pctFallback: 0.5 });
    expect(r.isSpike).toBe(false);
  });

  test('real spend over a zero-spend baseline is flagged', () => {
    const r = detectSpendSpike(series([0, 0, 0, 0, 0, 0], 75));
    expect(r.isSpike).toBe(true);
    expect(r.reason).toBe('spend_from_zero_baseline');
  });

  test('a value just under the threshold is not flagged (strictly greater)', () => {
    const r = detectSpendSpike(series([100, 105, 98, 102, 100, 101, 99], 103), { z: 2.5 });
    expect(r.isSpike).toBe(false);
  });

  test('exposes supporting statistics', () => {
    const r = detectSpendSpike(series([100, 105, 98, 102, 100, 101, 99], 300));
    expect(typeof r.baselineMean).toBe('number');
    expect(typeof r.baselineStddev).toBe('number');
    expect(r.baselineDays).toBe(7);
    expect(r.threshold).toBeGreaterThan(0);
  });
});

describe('scanAccountForSpendSpike', () => {
  function fakeCtx(rows) {
    return {
      accessToken: 't', developerToken: 'd', customerId: '1234567890',
      loginCustomerId: '9', _queryFn: async () => rows,
    };
  }

  test('fetches daily spend and returns a spike result tagged with accountId', async () => {
    const rows = [];
    for (const d of ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06']) {
      rows.push({ segments: { date: d }, metrics: { costMicros: 100000000 } }); // $100/day
    }
    rows.push({ segments: { date: '2026-06-07' }, metrics: { costMicros: 400000000 } }); // $400 spike
    const r = await scanAccountForSpendSpike(fakeCtx(rows));
    expect(r.accountId).toBe('1234567890');
    expect(r.isSpike).toBe(true);
    expect(r.spend).toBe(400);
  });
});

describe('formatSpikeAlert', () => {
  test('produces a readable one-line alert', () => {
    const r = detectSpendSpike(series([100, 100, 100, 100, 100, 100], 160));
    const msg = formatSpikeAlert(r, 'Honda of Springfield');
    expect(msg).toMatch(/Honda of Springfield/);
    expect(msg).toMatch(/spend spike/);
    expect(msg).toMatch(/\$160/);
  });
});
