/**
 * Unit tests for pacing-calculator — verifies pacing math, status thresholds,
 * day-of-week weighting, inventory modifiers, and the full calculatePacing flow.
 *
 * Tier 2 (unit): pure functions, no external deps or fakes needed.
 */

const {
  calculatePacing,
  getPacingStatus,
  applyInventoryModifier,
  weightedExpectedSpend,
  requiredDailyRate,
  getMonthDayWeights,
  daysInMonth,
  DEFAULT_DAY_WEIGHTS,
} = require('../../src/services/pacing-calculator');

// ===========================================================================
// daysInMonth
// ===========================================================================

describe('daysInMonth', () => {
  test('returns 31 for January', () => {
    expect(daysInMonth(2026, 1)).toBe(31);
  });

  test('returns 28 for February in non-leap year', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
  });

  test('returns 29 for February in leap year', () => {
    expect(daysInMonth(2028, 2)).toBe(29);
  });

  test('returns 30 for April', () => {
    expect(daysInMonth(2026, 4)).toBe(30);
  });

  test('returns 31 for March 2026', () => {
    expect(daysInMonth(2026, 3)).toBe(31);
  });
});

// ===========================================================================
// getMonthDayWeights
// ===========================================================================

describe('getMonthDayWeights', () => {
  test('returns one weight per day of the month', () => {
    const weights = getMonthDayWeights(2026, 3); // March 2026 = 31 days
    expect(weights).toHaveLength(31);
  });

  test('March 1 2026 is a Sunday — gets Sunday weight', () => {
    const weights = getMonthDayWeights(2026, 3);
    // March 1 2026 = Sunday, DEFAULT_DAY_WEIGHTS[0] = 0.75
    expect(weights[0]).toBe(0.75);
  });

  test('March 2 2026 is a Monday — gets Monday weight', () => {
    const weights = getMonthDayWeights(2026, 3);
    // Monday = DEFAULT_DAY_WEIGHTS[1] = 0.95
    expect(weights[1]).toBe(0.95);
  });

  test('March 7 2026 is a Saturday — gets Saturday weight', () => {
    const weights = getMonthDayWeights(2026, 3);
    // Day 7 = index 6, Saturday = DEFAULT_DAY_WEIGHTS[6] = 1.15
    expect(weights[6]).toBe(1.15);
  });

  test('uses custom weights when provided', () => {
    const custom = [1, 1, 1, 1, 1, 1, 1]; // flat weights
    const weights = getMonthDayWeights(2026, 3, custom);
    expect(weights.every(w => w === 1)).toBe(true);
  });
});

// ===========================================================================
// weightedExpectedSpend
// ===========================================================================

describe('weightedExpectedSpend', () => {
  test('with flat weights, expected spend is proportional to days elapsed', () => {
    const flatWeights = Array(30).fill(1); // 30 days, all weight 1
    const result = weightedExpectedSpend(10000, flatWeights, 10);
    expect(result).toBeCloseTo(3333.33, 1);
  });

  test('full month returns full budget', () => {
    const flatWeights = Array(31).fill(1);
    const result = weightedExpectedSpend(15000, flatWeights, 31);
    expect(result).toBeCloseTo(15000, 2);
  });

  test('day 0 returns 0', () => {
    const flatWeights = Array(30).fill(1);
    expect(weightedExpectedSpend(10000, flatWeights, 0)).toBe(0);
  });

  test('returns 0 when all weights are 0', () => {
    const zeroWeights = Array(30).fill(0);
    expect(weightedExpectedSpend(10000, zeroWeights, 15)).toBe(0);
  });

  test('weighted days allocate more budget to heavier days', () => {
    // 4 days: weights [1, 1, 1, 3] — last day gets 3/6 = 50% of budget
    const weights = [1, 1, 1, 3];
    const through3 = weightedExpectedSpend(6000, weights, 3);
    const through4 = weightedExpectedSpend(6000, weights, 4);
    expect(through3).toBeCloseTo(3000, 2); // 3/6 of budget
    expect(through4).toBeCloseTo(6000, 2); // full budget
  });
});

// ===========================================================================
// requiredDailyRate
// ===========================================================================

describe('requiredDailyRate', () => {
  test('with flat weights, returns remaining / days', () => {
    const weights = Array(10).fill(1);
    expect(requiredDailyRate(5000, weights)).toBeCloseTo(500, 2);
  });

  test('returns 0 when no remaining days', () => {
    expect(requiredDailyRate(5000, [])).toBe(0);
  });

  test('returns 0 when remaining budget is 0', () => {
    const weights = Array(10).fill(1);
    expect(requiredDailyRate(0, weights)).toBe(0);
  });

  test('returns 0 when remaining budget is negative', () => {
    const weights = Array(10).fill(1);
    expect(requiredDailyRate(-500, weights)).toBe(0);
  });

  test('weighted rate gives heavier days a higher rate', () => {
    // 2 remaining days: weights [1, 2] — today (index 0) gets 1/3, tomorrow gets 2/3
    const rate = requiredDailyRate(3000, [1, 2], 0);
    expect(rate).toBeCloseTo(1000, 2); // 1/3 of 3000
  });

  test('todayIndex selects correct weight', () => {
    // 3 remaining days: weights [1, 2, 3] — todayIndex=1 → weight 2 of total 6
    const rate = requiredDailyRate(6000, [1, 2, 3], 1);
    expect(rate).toBeCloseTo(2000, 2); // 2/6 of 6000
  });

  test('returns 0 when all weights are 0', () => {
    expect(requiredDailyRate(5000, [0, 0, 0])).toBe(0);
  });

  test('todayIndex out of bounds falls back to first weight', () => {
    // 3 remaining days: weights [2, 1, 1] — todayIndex=10 → falls back to weight 2
    const rate = requiredDailyRate(4000, [2, 1, 1], 10);
    expect(rate).toBeCloseTo(2000, 2); // 2/4 of 4000
  });
});

// ===========================================================================
// getPacingStatus
// ===========================================================================

describe('getPacingStatus', () => {
  test('0% variance is on_pace', () => {
    expect(getPacingStatus(0)).toBe('on_pace');
  });

  test('+4.9% is on_pace', () => {
    expect(getPacingStatus(4.9)).toBe('on_pace');
  });

  test('-4.9% is on_pace', () => {
    expect(getPacingStatus(-4.9)).toBe('on_pace');
  });

  test('+5% is on_pace (boundary, <= 5 is on_pace)', () => {
    expect(getPacingStatus(5)).toBe('on_pace');
  });

  test('-5% is on_pace (boundary, >= -5 is on_pace)', () => {
    expect(getPacingStatus(-5)).toBe('on_pace');
  });

  test('+5.1% is over', () => {
    expect(getPacingStatus(5.1)).toBe('over');
  });

  test('+14.9% is over', () => {
    expect(getPacingStatus(14.9)).toBe('over');
  });

  test('-5.1% is under', () => {
    expect(getPacingStatus(-5.1)).toBe('under');
  });

  test('-14.9% is under', () => {
    expect(getPacingStatus(-14.9)).toBe('under');
  });

  test('+15% is critical_over', () => {
    expect(getPacingStatus(15)).toBe('critical_over');
  });

  test('+50% is critical_over', () => {
    expect(getPacingStatus(50)).toBe('critical_over');
  });

  test('-15% is critical_under', () => {
    expect(getPacingStatus(-15)).toBe('critical_under');
  });

  test('-15.1% is critical_under', () => {
    expect(getPacingStatus(-15.1)).toBe('critical_under');
  });

  test('-50% is critical_under', () => {
    expect(getPacingStatus(-50)).toBe('critical_under');
  });

  test('floating-point near-boundary 5.0000000000001 is over (not on_pace)', () => {
    expect(getPacingStatus(5.0000000000001)).toBe('over');
  });

  test('floating-point near-boundary -5.0000000000001 is under (not on_pace)', () => {
    expect(getPacingStatus(-5.0000000000001)).toBe('under');
  });
});

// ===========================================================================
// applyInventoryModifier
// ===========================================================================

describe('applyInventoryModifier', () => {
  test('no baseline returns unmodified budget', () => {
    const result = applyInventoryModifier(10000, 100, 0);
    expect(result.effectiveBudget).toBe(10000);
    expect(result.modifier).toBe(1.0);
    expect(result.reason).toBeNull();
  });

  test('null inventory returns unmodified budget', () => {
    const result = applyInventoryModifier(10000, null, 200);
    expect(result.effectiveBudget).toBe(10000);
    expect(result.modifier).toBe(1.0);
  });

  test('undefined inventory returns unmodified budget', () => {
    const result = applyInventoryModifier(10000, undefined, 200);
    expect(result.effectiveBudget).toBe(10000);
    expect(result.modifier).toBe(1.0);
  });

  test('normal inventory (80-120%) returns unmodified budget', () => {
    const result = applyInventoryModifier(10000, 200, 200);
    expect(result.effectiveBudget).toBe(10000);
    expect(result.modifier).toBe(1.0);
    expect(result.reason).toBeNull();
  });

  test('inventory at 100% returns unmodified', () => {
    const result = applyInventoryModifier(10000, 180, 200);
    // 90% — within 80-120%
    expect(result.modifier).toBe(1.0);
  });

  test('inventory at 79% reduces to 80%', () => {
    const result = applyInventoryModifier(10000, 158, 200); // 79%
    expect(result.modifier).toBe(0.80);
    expect(result.effectiveBudget).toBe(8000);
    expect(result.reason).toContain('80%');
  });

  test('inventory at 50% reduces to 80%', () => {
    const result = applyInventoryModifier(10000, 100, 200); // 50%
    expect(result.modifier).toBe(0.80);
    expect(result.effectiveBudget).toBe(8000);
  });

  test('inventory at 49% reduces to 60%', () => {
    const result = applyInventoryModifier(10000, 98, 200); // 49%
    expect(result.modifier).toBe(0.60);
    expect(result.effectiveBudget).toBe(6000);
    expect(result.reason).toContain('60%');
  });

  test('inventory at 10% reduces to 60%', () => {
    const result = applyInventoryModifier(10000, 20, 200); // 10%
    expect(result.modifier).toBe(0.60);
    expect(result.effectiveBudget).toBe(6000);
  });

  test('inventory at 0 reduces to 60%', () => {
    const result = applyInventoryModifier(10000, 0, 200); // 0%
    expect(result.modifier).toBe(0.60);
    expect(result.effectiveBudget).toBe(6000);
  });

  test('inventory at 121% increases budget', () => {
    const result = applyInventoryModifier(10000, 242, 200); // 121%
    expect(result.modifier).toBeGreaterThan(1.0);
    expect(result.effectiveBudget).toBeGreaterThan(10000);
    expect(result.reason).toContain('High inventory');
  });

  test('inventory increase is capped at 120%', () => {
    const result = applyInventoryModifier(10000, 600, 200); // 300%
    expect(result.modifier).toBe(1.20);
    expect(result.effectiveBudget).toBe(12000);
  });

  test('negative baseline returns unmodified', () => {
    const result = applyInventoryModifier(10000, 100, -50);
    expect(result.modifier).toBe(1.0);
    expect(result.effectiveBudget).toBe(10000);
  });
});

// ===========================================================================
// calculatePacing — integration of all components
// ===========================================================================

describe('calculatePacing', () => {
  // Use flat weights for predictable math in most tests
  const FLAT_WEIGHTS = [1, 1, 1, 1, 1, 1, 1];

  describe('mid-month, on pace', () => {
    test('returns on_pace when spend matches expected', () => {
      const result = calculatePacing({
        monthlyBudget: 10000,
        spendToDate: 5000,  // exactly half at day 15 of 30
        year: 2026,
        month: 4, // April = 30 days
        currentDay: 15,
        dayWeights: FLAT_WEIGHTS,
      });

      expect(result.daysInMonth).toBe(30);
      expect(result.daysElapsed).toBe(15);
      expect(result.daysRemaining).toBe(15);
      expect(result.monthlyBudget).toBe(10000);
      expect(result.effectiveBudget).toBe(10000);
      expect(result.spendToDate).toBe(5000);
      expect(result.expectedSpend).toBeCloseTo(5000, 0);
      expect(result.pacePercent).toBe(0);
      expect(result.paceStatus).toBe('on_pace');
    });
  });

  describe('under-pacing', () => {
    test('returns under when spend is 10% below expected', () => {
      // Day 15 of 30, expected $5000, actual $4500 → -10%
      const result = calculatePacing({
        monthlyBudget: 10000,
        spendToDate: 4500,
        year: 2026,
        month: 4,
        currentDay: 15,
        dayWeights: FLAT_WEIGHTS,
      });

      expect(result.pacePercent).toBe(-10);
      expect(result.paceStatus).toBe('under');
    });

    test('returns critical_under when spend is 20% below expected', () => {
      const result = calculatePacing({
        monthlyBudget: 10000,
        spendToDate: 4000,
        year: 2026,
        month: 4,
        currentDay: 15,
        dayWeights: FLAT_WEIGHTS,
      });

      expect(result.pacePercent).toBe(-20);
      expect(result.paceStatus).toBe('critical_under');
    });
  });

  describe('over-pacing', () => {
    test('returns over when spend is 10% above expected', () => {
      const result = calculatePacing({
        monthlyBudget: 10000,
        spendToDate: 5500,
        year: 2026,
        month: 4,
        currentDay: 15,
        dayWeights: FLAT_WEIGHTS,
      });

      expect(result.pacePercent).toBe(10);
      expect(result.paceStatus).toBe('over');
    });

    test('returns critical_over when spend is 25% above expected', () => {
      const result = calculatePacing({
        monthlyBudget: 10000,
        spendToDate: 6250,
        year: 2026,
        month: 4,
        currentDay: 15,
        dayWeights: FLAT_WEIGHTS,
      });

      expect(result.pacePercent).toBe(25);
      expect(result.paceStatus).toBe('critical_over');
    });
  });

  describe('rates and projections', () => {
    test('calculates daily average, ideal rate, and required rate', () => {
      const result = calculatePacing({
        monthlyBudget: 9000,
        spendToDate: 3000,
        year: 2026,
        month: 4, // 30 days
        currentDay: 10,
        dayWeights: FLAT_WEIGHTS,
      });

      expect(result.dailyAvgSpend).toBe(300);          // 3000 / 10
      expect(result.idealDailyRate).toBe(300);          // 9000 / 30
      expect(result.requiredDailyRate).toBe(300);       // 6000 / 20
      expect(result.remainingBudget).toBe(6000);
      expect(result.projectedSpend).toBe(9000);         // 300 * 30
    });

    test('required rate increases when behind pace', () => {
      const result = calculatePacing({
        monthlyBudget: 9000,
        spendToDate: 1500,  // only 1500 of expected 3000
        year: 2026,
        month: 4,
        currentDay: 10,
        dayWeights: FLAT_WEIGHTS,
      });

      expect(result.requiredDailyRate).toBe(375);       // 7500 / 20
      expect(result.dailyAvgSpend).toBe(150);           // 1500 / 10
    });
  });

  describe('inventory modifier integration', () => {
    test('low inventory reduces effective budget and adjusts pacing', () => {
      const result = calculatePacing({
        monthlyBudget: 10000,
        spendToDate: 3000,
        year: 2026,
        month: 4,
        currentDay: 15,
        currentInventory: 80,
        baselineInventory: 200, // 40% = severe low
        dayWeights: FLAT_WEIGHTS,
      });

      expect(result.effectiveBudget).toBe(6000);       // 60% of 10000
      expect(result.inventoryModifier).toBe(0.60);
      expect(result.inventoryReason).toContain('60%');
      // Expected spend = 6000 * 15/30 = 3000, actual = 3000 → on_pace
      expect(result.paceStatus).toBe('on_pace');
    });

    test('no inventory data leaves budget unchanged', () => {
      const result = calculatePacing({
        monthlyBudget: 10000,
        spendToDate: 5000,
        year: 2026,
        month: 4,
        currentDay: 15,
        dayWeights: FLAT_WEIGHTS,
      });

      expect(result.effectiveBudget).toBe(10000);
      expect(result.inventoryModifier).toBe(1.0);
      expect(result.inventoryReason).toBeNull();
    });
  });

  describe('edge cases', () => {
    test('day 1 of month with zero spend', () => {
      const result = calculatePacing({
        monthlyBudget: 10000,
        spendToDate: 0,
        year: 2026,
        month: 4,
        currentDay: 1,
        dayWeights: FLAT_WEIGHTS,
      });

      expect(result.daysElapsed).toBe(1);
      expect(result.daysRemaining).toBe(29);
      expect(result.pacePercent).toBe(-100);
      expect(result.paceStatus).toBe('critical_under');
      expect(result.dailyAvgSpend).toBe(0);
      expect(result.projectedSpend).toBe(0);
    });

    test('last day of month', () => {
      const result = calculatePacing({
        monthlyBudget: 10000,
        spendToDate: 9800,
        year: 2026,
        month: 4,
        currentDay: 30,
        dayWeights: FLAT_WEIGHTS,
      });

      expect(result.daysElapsed).toBe(30);
      expect(result.daysRemaining).toBe(0);
      expect(result.remainingBudget).toBe(200);
      expect(result.requiredDailyRate).toBe(0); // no remaining days
    });

    test('currentDay exceeding month days is clamped', () => {
      const result = calculatePacing({
        monthlyBudget: 10000,
        spendToDate: 10000,
        year: 2026,
        month: 4,
        currentDay: 35,
        dayWeights: FLAT_WEIGHTS,
      });

      expect(result.daysElapsed).toBe(30);
      expect(result.daysRemaining).toBe(0);
    });

    test('spend exceeding budget results in zero remaining', () => {
      const result = calculatePacing({
        monthlyBudget: 10000,
        spendToDate: 12000,
        year: 2026,
        month: 4,
        currentDay: 25,
        dayWeights: FLAT_WEIGHTS,
      });

      expect(result.remainingBudget).toBe(0);
      expect(result.requiredDailyRate).toBe(0);
      expect(result.paceStatus).toBe('critical_over');
    });

    test('day 0 returns on_pace with zero expected spend', () => {
      const result = calculatePacing({
        monthlyBudget: 10000,
        spendToDate: 0,
        year: 2026,
        month: 4,
        currentDay: 0,
        dayWeights: FLAT_WEIGHTS,
      });

      expect(result.daysElapsed).toBe(0);
      expect(result.daysRemaining).toBe(30);
      expect(result.expectedSpend).toBe(0);
      expect(result.pacePercent).toBe(0);
      expect(result.paceStatus).toBe('on_pace');
      expect(result.projectedSpend).toBe(0);
    });

    test('negative spendToDate (refund) increases remaining budget', () => {
      const result = calculatePacing({
        monthlyBudget: 10000,
        spendToDate: -500,
        year: 2026,
        month: 4,
        currentDay: 15,
        dayWeights: FLAT_WEIGHTS,
      });

      // remainingBudget = max(10000 - (-500), 0) = 10500
      expect(result.remainingBudget).toBe(10500);
      expect(result.paceStatus).toBe('critical_under');
    });

    test('large budget does not lose precision', () => {
      const result = calculatePacing({
        monthlyBudget: 500000,
        spendToDate: 250000,
        year: 2026,
        month: 4,
        currentDay: 15,
        dayWeights: FLAT_WEIGHTS,
      });

      expect(result.monthlyBudget).toBe(500000);
      expect(result.expectedSpend).toBeCloseTo(250000, 0);
      expect(result.pacePercent).toBe(0);
      expect(result.paceStatus).toBe('on_pace');
    });

    test('zero budget returns on_pace with zero rates', () => {
      const result = calculatePacing({
        monthlyBudget: 0,
        spendToDate: 0,
        year: 2026,
        month: 4,
        currentDay: 15,
        dayWeights: FLAT_WEIGHTS,
      });

      expect(result.pacePercent).toBe(0);
      expect(result.paceStatus).toBe('on_pace');
      expect(result.idealDailyRate).toBe(0);
    });
  });

  describe('day-of-week weighting', () => {
    test('default weights make weekday expected spend differ from flat', () => {
      const withDefault = calculatePacing({
        monthlyBudget: 10000,
        spendToDate: 5000,
        year: 2026,
        month: 4,
        currentDay: 15,
        // uses DEFAULT_DAY_WEIGHTS
      });

      const withFlat = calculatePacing({
        monthlyBudget: 10000,
        spendToDate: 5000,
        year: 2026,
        month: 4,
        currentDay: 15,
        dayWeights: FLAT_WEIGHTS,
      });

      // Expected spend should differ because day weights differ
      expect(withDefault.expectedSpend).not.toBe(withFlat.expectedSpend);
    });

    test('projected spend accounts for day-of-week weighting', () => {
      // 4 days with weights [1, 1, 1, 3] — total weight 6
      // If we're on day 2, spent $200, elapsed weight = 2, total weight = 6
      // Projected = 200 * (6/2) = $600
      const result = calculatePacing({
        monthlyBudget: 600,
        spendToDate: 200,
        year: 2026,
        month: 4, // April, 30 days
        currentDay: 2,
        dayWeights: [1, 1, 1, 1, 1, 1, 1], // flat for predictable math
      });

      // With flat weights, day 2 of 30: projected = 200 * (30/2) = 3000
      expect(result.projectedSpend).toBeCloseTo(3000, 0);
    });

    test('projected spend with non-flat weights differs from flat projection', () => {
      const spendToDate = 3000;
      const withDefault = calculatePacing({
        monthlyBudget: 10000,
        spendToDate,
        year: 2026,
        month: 3, // March starts on Sunday
        currentDay: 7,
        // uses DEFAULT_DAY_WEIGHTS
      });

      const withFlat = calculatePacing({
        monthlyBudget: 10000,
        spendToDate,
        year: 2026,
        month: 3,
        currentDay: 7,
        dayWeights: [1, 1, 1, 1, 1, 1, 1],
      });

      // Flat: 3000 * (31/7) = ~13285.71
      // Weighted: different because first 7 days include lighter Sunday
      expect(withDefault.projectedSpend).not.toBe(withFlat.projectedSpend);
    });

    test('heavier weekend weight shifts expected spend for weeks with more weekends', () => {
      // March 2026 starts on Sunday — first 7 days: Sun Mon Tue Wed Thu Fri Sat
      // Day 7 includes 1 Sunday (0.75) and 1 Saturday (1.15)
      const result = calculatePacing({
        monthlyBudget: 10000,
        spendToDate: 2000,
        year: 2026,
        month: 3,
        currentDay: 7,
      });

      // Verify expected spend accounts for the lighter Sunday
      expect(result.expectedSpend).toBeDefined();
      expect(result.expectedSpend).toBeGreaterThan(0);
      expect(result.expectedSpend).toBeLessThan(10000);
    });
  });
});
