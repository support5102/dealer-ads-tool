/**
 * Unit tests for calculateProjection.
 *
 * Tier 2 (unit): pure function, no external deps.
 */

const { calculateProjection } = require('../../src/services/pacing-calculator');

// Helper: generate daily spend data
function dailyData(startDate, days, spendPerDay) {
  const result = [];
  const start = new Date(startDate);
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    result.push({ date: d.toISOString().slice(0, 10), spend: spendPerDay });
  }
  return result;
}

describe('calculateProjection', () => {
  // March 2026: 31 days. Day 20, 11 days remaining.

  test('no budget change: projects from full-month average', () => {
    const result = calculateProjection({
      monthlyBudget: 15000,
      mtdSpend: 10000,          // $10k through day 20
      dailySpend: dailyData('2026-03-13', 14, 500),
      changeDate: null,
      year: 2026, month: 3, currentDay: 20,
    });
    // dailyAvg = 10000/20 = 500, projected = 10000 + 500*11 = 15500
    expect(result.projectedSpend).toBe(15500);
    expect(result.projectedStatus).toBe('on_track'); // 3.3% over
    expect(result.postChangeDailyAvg).toBeNull();
    expect(result.changeDate).toBeNull();
  });

  test('with budget change: uses post-change rate for projection', () => {
    // Change on day 15 (March 15). Daily data: 14 days from March 13-26.
    // Post-change days: March 15-26 = 12 days at $600/day
    const daily = [
      ...dailyData('2026-03-13', 2, 400),  // pre-change: $400/day
      ...dailyData('2026-03-15', 12, 600), // post-change: $600/day
    ];
    const result = calculateProjection({
      monthlyBudget: 15000,
      mtdSpend: 8000,           // $8k through day 20
      dailySpend: daily,
      changeDate: '2026-03-15',
      year: 2026, month: 3, currentDay: 20,
    });
    // postChangeDailyAvg = (12 * 600) / 12 = 600
    // projected = 8000 + 600 * 11 = 14600
    expect(result.postChangeDailyAvg).toBe(600);
    expect(result.projectedSpend).toBe(14600);
    expect(result.projectedStatus).toBe('on_track'); // -2.7%
    expect(result.changeDate).toBe('2026-03-15');
  });

  test('will_over status when projection exceeds budget by 15%+', () => {
    const daily = dailyData('2026-03-15', 12, 800);
    const result = calculateProjection({
      monthlyBudget: 10000,
      mtdSpend: 9000,
      dailySpend: daily,
      changeDate: '2026-03-15',
      year: 2026, month: 3, currentDay: 20,
    });
    // projected = 9000 + 800*11 = 17800, variance = +78% → will_over
    expect(result.projectedStatus).toBe('will_over');
  });

  test('will_under status when projection is 15%+ below budget', () => {
    const daily = dailyData('2026-03-15', 12, 100);
    const result = calculateProjection({
      monthlyBudget: 15000,
      mtdSpend: 2000,
      dailySpend: daily,
      changeDate: '2026-03-15',
      year: 2026, month: 3, currentDay: 20,
    });
    // projected = 2000 + 100*11 = 3100, variance = -79.3% → will_under
    expect(result.projectedStatus).toBe('will_under');
  });

  test('on_track when projection is within +-5% of budget', () => {
    const daily = dailyData('2026-03-15', 6, 500);
    const result = calculateProjection({
      monthlyBudget: 15500,
      mtdSpend: 10000,
      dailySpend: daily,
      changeDate: '2026-03-15',
      year: 2026, month: 3, currentDay: 20,
    });
    // projected = 10000 + 500*11 = 15500, variance = 0% → on_track
    expect(result.projectedStatus).toBe('on_track');
  });

  test('change too recent with no post-change data falls back to full-month', () => {
    // Change date is tomorrow's date — no daily data for it yet
    const daily = dailyData('2026-03-13', 7, 500);
    const result = calculateProjection({
      monthlyBudget: 15000,
      mtdSpend: 10000,
      dailySpend: daily,
      changeDate: '2026-03-27', // after all daily data
      year: 2026, month: 3, currentDay: 20,
    });
    // Falls back: dailyAvg = 10000/20 = 500, projected = 10000 + 500*11 = 15500
    expect(result.postChangeDailyAvg).toBeNull();
    expect(result.projectedSpend).toBe(15500);
  });

  test('$0 spend post-change projects $0 remaining', () => {
    const daily = dailyData('2026-03-15', 6, 0);
    const result = calculateProjection({
      monthlyBudget: 15000,
      mtdSpend: 5000,
      dailySpend: daily,
      changeDate: '2026-03-15',
      year: 2026, month: 3, currentDay: 20,
    });
    // projected = 5000 + 0*11 = 5000
    expect(result.projectedSpend).toBe(5000);
    expect(result.postChangeDailyAvg).toBe(0);
    expect(result.projectedStatus).toBe('will_under');
  });

  test('empty dailySpend falls back to full-month average', () => {
    const result = calculateProjection({
      monthlyBudget: 15000,
      mtdSpend: 10000,
      dailySpend: [],
      changeDate: '2026-03-15',
      year: 2026, month: 3, currentDay: 20,
    });
    expect(result.postChangeDailyAvg).toBeNull();
    expect(result.projectedSpend).toBe(15500);
  });

  test('last day of month with 0 days remaining', () => {
    const daily = dailyData('2026-03-15', 14, 500);
    const result = calculateProjection({
      monthlyBudget: 15000,
      mtdSpend: 14000,
      dailySpend: daily,
      changeDate: '2026-03-15',
      year: 2026, month: 3, currentDay: 31,
    });
    // 0 days remaining → projected = mtdSpend = 14000
    expect(result.projectedSpend).toBe(14000);
    expect(result.projectedStatus).toBe('under'); // -6.7%
  });
});
