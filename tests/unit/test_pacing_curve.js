/**
 * Unit tests for pacing-curve — pure curve evaluation math.
 * Tier 2 (unit): no external deps.
 */

const {
  evaluateCurve,
  cumulativeTarget,
  PACING_CURVES,
} = require('../../src/services/pacing-curve');

describe('evaluateCurve - linear', () => {
  test('returns 1.0 for every day of the month', () => {
    for (let d = 1; d <= 30; d++) {
      expect(evaluateCurve('linear', d, 30)).toBe(1.0);
    }
  });
});

describe('evaluateCurve - alanJay9505', () => {
  test('returns 0.95 for days 1-14', () => {
    for (let d = 1; d <= 14; d++) {
      expect(evaluateCurve('alanJay9505', d, 30)).toBe(0.95);
    }
  });

  test('returns 1.05 for days 15+', () => {
    for (let d = 15; d <= 30; d++) {
      expect(evaluateCurve('alanJay9505', d, 30)).toBe(1.05);
    }
  });

  test('works for short month (February)', () => {
    expect(evaluateCurve('alanJay9505', 14, 28)).toBe(0.95);
    expect(evaluateCurve('alanJay9505', 15, 28)).toBe(1.05);
    expect(evaluateCurve('alanJay9505', 28, 28)).toBe(1.05);
  });
});

describe('evaluateCurve - unknown curve', () => {
  test('throws on unknown curve id', () => {
    expect(() => evaluateCurve('nonexistent', 1, 30)).toThrow(/unknown curve/i);
  });
});

describe('cumulativeTarget - linear', () => {
  test('returns 0 for day 0', () => {
    expect(cumulativeTarget('linear', 0, 30)).toBe(0);
  });

  test('returns 50% of budget at day 15 of a 30-day month', () => {
    expect(cumulativeTarget('linear', 15, 30)).toBeCloseTo(0.5, 5);
  });

  test('returns 100% of budget at day 30 of a 30-day month', () => {
    expect(cumulativeTarget('linear', 30, 30)).toBeCloseTo(1.0, 5);
  });
});

describe('cumulativeTarget - alanJay9505', () => {
  test('returns cumulative normalized to 1.0 at end of month', () => {
    expect(cumulativeTarget('alanJay9505', 30, 30)).toBeCloseTo(1.0, 5);
  });

  test('returns less than linear at day 14 (underpaced on purpose)', () => {
    const alanJay = cumulativeTarget('alanJay9505', 14, 30);
    const linear = cumulativeTarget('linear', 14, 30);
    expect(alanJay).toBeLessThan(linear);
  });

  test('alanJay9505 stays at-or-below linear through the month, converging at EOM', () => {
    for (let d = 1; d < 30; d++) {
      const alanJay = cumulativeTarget('alanJay9505', d, 30);
      const linear = cumulativeTarget('linear', d, 30);
      expect(alanJay).toBeLessThanOrEqual(linear + 1e-9);
    }
    expect(cumulativeTarget('alanJay9505', 30, 30)).toBeCloseTo(1.0, 5);
  });

  test('alanJay9505 gap to linear narrows in the second half of the month', () => {
    const gapAtDay14 = cumulativeTarget('linear', 14, 30) - cumulativeTarget('alanJay9505', 14, 30);
    const gapAtDay25 = cumulativeTarget('linear', 25, 30) - cumulativeTarget('alanJay9505', 25, 30);
    expect(gapAtDay25).toBeLessThan(gapAtDay14);
  });
});

describe('PACING_CURVES registry', () => {
  test('exports linear and alanJay9505', () => {
    expect(PACING_CURVES.linear).toBeDefined();
    expect(PACING_CURVES.alanJay9505).toBeDefined();
  });
});
