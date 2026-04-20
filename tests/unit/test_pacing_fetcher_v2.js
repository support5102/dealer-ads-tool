/**
 * Unit tests for pacing-fetcher v2 additions — pacingSinceLastChange, daysSinceLastChange.
 * Tier 2 (unit): uses injected fakes, no real Google Ads.
 */

const { computeSinceLastChange } = require('../../src/services/pacing-fetcher');

describe('computeSinceLastChange', () => {
  test('returns null fields when no change recorded', () => {
    const r = computeSinceLastChange({
      dailySpend: [{ date: '2026-04-10', spend: 100 }],
      changeDate: null,
      monthlyBudget: 3000,
      curveId: 'linear',
      today: new Date('2026-04-15T12:00:00Z'),
    });
    expect(r.daysSinceLastChange).toBeNull();
    expect(r.pacingSinceLastChange).toBeNull();
  });

  test('returns zero days when change is today', () => {
    const r = computeSinceLastChange({
      dailySpend: [{ date: '2026-04-14', spend: 100 }, { date: '2026-04-15', spend: 100 }],
      changeDate: '2026-04-15',
      monthlyBudget: 3000,
      curveId: 'linear',
      today: new Date('2026-04-15T12:00:00Z'),
    });
    expect(r.daysSinceLastChange).toBe(0);
  });

  test('returns positive days for past change', () => {
    const r = computeSinceLastChange({
      dailySpend: Array.from({ length: 10 }, (_, i) => ({
        date: `2026-04-${String(i + 6).padStart(2, '0')}`,
        spend: 100,
      })),
      changeDate: '2026-04-10',
      monthlyBudget: 3000,
      curveId: 'linear',
      today: new Date('2026-04-15T12:00:00Z'),
    });
    expect(r.daysSinceLastChange).toBe(5);
  });

  test('pacing % = 100 when spend matches curve target exactly', () => {
    // Change on day 10. Today = day 15. Linear curve, budget 3000 / 30 days = $100/day.
    // postChange window excludes change day AND today, so 4 days × $100 = $400 actual
    // vs curve expected of $3000 × (14/30 − 10/30) = $400 → 100%.
    const dailySpend = [
      { date: '2026-04-10', spend: 100 },
      { date: '2026-04-11', spend: 100 },
      { date: '2026-04-12', spend: 100 },
      { date: '2026-04-13', spend: 100 },
      { date: '2026-04-14', spend: 100 },
    ];
    const r = computeSinceLastChange({
      dailySpend,
      changeDate: '2026-04-10',
      monthlyBudget: 3000,
      curveId: 'linear',
      today: new Date('2026-04-15T12:00:00Z'),
    });
    expect(r.pacingSinceLastChange).toBeCloseTo(100, 0);
  });

  test('pacing % > 100 when overspending after change', () => {
    // 4 counted days at $140 = $560 actual vs $400 expected = 140%.
    const dailySpend = [
      { date: '2026-04-10', spend: 140 },
      { date: '2026-04-11', spend: 140 },
      { date: '2026-04-12', spend: 140 },
      { date: '2026-04-13', spend: 140 },
      { date: '2026-04-14', spend: 140 },
    ];
    const r = computeSinceLastChange({
      dailySpend,
      changeDate: '2026-04-10',
      monthlyBudget: 3000,
      curveId: 'linear',
      today: new Date('2026-04-15T12:00:00Z'),
    });
    expect(r.pacingSinceLastChange).toBeCloseTo(140, 0);
  });

  test('pacing % < 100 when underspending after change', () => {
    const dailySpend = [
      { date: '2026-04-10', spend: 60 },
      { date: '2026-04-11', spend: 60 },
      { date: '2026-04-12', spend: 60 },
      { date: '2026-04-13', spend: 60 },
      { date: '2026-04-14', spend: 60 },
    ];
    const r = computeSinceLastChange({
      dailySpend,
      changeDate: '2026-04-10',
      monthlyBudget: 3000,
      curveId: 'linear',
      today: new Date('2026-04-15T12:00:00Z'),
    });
    expect(r.pacingSinceLastChange).toBeCloseTo(60, 0);
  });
});
