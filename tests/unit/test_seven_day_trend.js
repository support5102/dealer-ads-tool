/**
 * Unit tests for calculateSevenDayTrend.
 *
 * Tier 2 (unit): pure function, no external deps.
 */

const { calculateSevenDayTrend } = require('../../src/services/pacing-calculator');

describe('calculateSevenDayTrend', () => {
  test('returns flat with zero values for null/empty input', () => {
    expect(calculateSevenDayTrend(null)).toEqual({
      sevenDayAvg: 0, sevenDayTrend: 'flat', sevenDayTrendPercent: 0,
    });
    expect(calculateSevenDayTrend([])).toEqual({
      sevenDayAvg: 0, sevenDayTrend: 'flat', sevenDayTrendPercent: 0,
    });
  });

  test('returns flat when fewer than 2 days of data', () => {
    const result = calculateSevenDayTrend([{ date: '2026-03-26', spend: 100 }]);
    expect(result.sevenDayTrend).toBe('flat');
    expect(result.sevenDayTrendPercent).toBe(0);
  });

  test('detects upward trend when last 7 > prior 7 by more than 3%', () => {
    const data = [
      // prior 7: avg $100/day
      { date: '2026-03-13', spend: 100 },
      { date: '2026-03-14', spend: 100 },
      { date: '2026-03-15', spend: 100 },
      { date: '2026-03-16', spend: 100 },
      { date: '2026-03-17', spend: 100 },
      { date: '2026-03-18', spend: 100 },
      { date: '2026-03-19', spend: 100 },
      // last 7: avg $120/day
      { date: '2026-03-20', spend: 120 },
      { date: '2026-03-21', spend: 120 },
      { date: '2026-03-22', spend: 120 },
      { date: '2026-03-23', spend: 120 },
      { date: '2026-03-24', spend: 120 },
      { date: '2026-03-25', spend: 120 },
      { date: '2026-03-26', spend: 120 },
    ];
    const result = calculateSevenDayTrend(data);
    expect(result.sevenDayTrend).toBe('up');
    expect(result.sevenDayTrendPercent).toBe(20);
    expect(result.sevenDayAvg).toBe(120);
  });

  test('detects downward trend when last 7 < prior 7 by more than 3%', () => {
    const data = [
      // prior 7: avg $200/day
      ...Array.from({ length: 7 }, (_, i) => ({ date: `2026-03-${13 + i}`, spend: 200 })),
      // last 7: avg $150/day
      ...Array.from({ length: 7 }, (_, i) => ({ date: `2026-03-${20 + i}`, spend: 150 })),
    ];
    const result = calculateSevenDayTrend(data);
    expect(result.sevenDayTrend).toBe('down');
    expect(result.sevenDayTrendPercent).toBe(-25);
    expect(result.sevenDayAvg).toBe(150);
  });

  test('returns flat when change is within +-3%', () => {
    const data = [
      ...Array.from({ length: 7 }, (_, i) => ({ date: `2026-03-${13 + i}`, spend: 100 })),
      ...Array.from({ length: 7 }, (_, i) => ({ date: `2026-03-${20 + i}`, spend: 102 })),
    ];
    const result = calculateSevenDayTrend(data);
    expect(result.sevenDayTrend).toBe('flat');
    expect(result.sevenDayTrendPercent).toBe(2);
  });

  test('handles prior7 zero spend with positive last7 (up, 100%)', () => {
    const data = [
      ...Array.from({ length: 7 }, (_, i) => ({ date: `2026-03-${13 + i}`, spend: 0 })),
      ...Array.from({ length: 7 }, (_, i) => ({ date: `2026-03-${20 + i}`, spend: 50 })),
    ];
    const result = calculateSevenDayTrend(data);
    expect(result.sevenDayTrend).toBe('up');
    expect(result.sevenDayTrendPercent).toBe(100);
  });

  test('handles both periods zero spend (flat, 0%)', () => {
    const data = [
      ...Array.from({ length: 14 }, (_, i) => ({ date: `2026-03-${13 + i}`, spend: 0 })),
    ];
    const result = calculateSevenDayTrend(data);
    expect(result.sevenDayTrend).toBe('flat');
    expect(result.sevenDayTrendPercent).toBe(0);
  });

  test('works with fewer than 14 days (early in month)', () => {
    // 5 days total: 2 prior, 3 last
    const data = [
      { date: '2026-03-01', spend: 80 },
      { date: '2026-03-02', spend: 80 },
      { date: '2026-03-03', spend: 100 },
      { date: '2026-03-04', spend: 100 },
      { date: '2026-03-05', spend: 100 },
    ];
    const result = calculateSevenDayTrend(data);
    // last 5 days → last7 = last 5 (all), prior7 = none → wait, let me re-check
    // recent = all 5, last7 = slice(-7) = all 5, prior7 = slice(0, 0) = []
    // Actually: recent.length=5, last7=slice(-7)=all 5, prior7=slice(0, 5-5)=[]
    // prior7 is empty, prior7Avg = 0, last7Avg = 92
    // → trendPercent = 100, trend = "up"
    expect(result.sevenDayTrend).toBe('up');
    expect(result.sevenDayAvg).toBe(92);
  });

  test('uses only most recent 14 entries even if more provided', () => {
    // 16 entries — first 2 should be ignored
    const data = [
      { date: '2026-03-10', spend: 999 },
      { date: '2026-03-11', spend: 999 },
      ...Array.from({ length: 7 }, (_, i) => ({ date: `2026-03-${12 + i}`, spend: 100 })),
      ...Array.from({ length: 7 }, (_, i) => ({ date: `2026-03-${19 + i}`, spend: 100 })),
    ];
    const result = calculateSevenDayTrend(data);
    expect(result.sevenDayAvg).toBe(100);
    expect(result.sevenDayTrend).toBe('flat');
    expect(result.sevenDayTrendPercent).toBe(0);
  });
});
