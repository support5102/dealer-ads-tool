/**
 * Unit tests for budget-adjust-math.js.
 *
 * The math module is pure (no DB, no I/O). Every test pins `today` so day-of-month
 * arithmetic is deterministic regardless of when the suite runs.
 */

const math = require('../../src/services/budget-adjust-math');

// May 15 2026: 31 days in May, 17 days remaining including today.
const MAY_15 = new Date(Date.UTC(2026, 4, 15, 12, 0, 0));
// Feb 10 2024 (leap year): 29 days, 20 days remaining including today.
const FEB_10_LEAP = new Date(Date.UTC(2024, 1, 10, 12, 0, 0));
// May 31 2026: 31 days, 1 day remaining.
const MAY_31 = new Date(Date.UTC(2026, 4, 31, 12, 0, 0));

describe('compute() — scope: day_forward (prorated)', () => {
  test('+$30 on May 15 with $3000 monthly: monthly += 30×17, daily = old+30', () => {
    const result = math.compute({
      scope: 'day',
      daySubScope: 'forward',
      amount: 30,
      currentMonthly: 3000,
      today: MAY_15,
    });
    expect(result.newMonthlyBudget).toBeCloseTo(3510, 2);
    expect(result.newDailyBudget).toBeCloseTo(126.77, 1);
    expect(result.dailyBudgetWritten).toBe(true);
  });
});

describe('compute() — scope: day_whole_month (rebases)', () => {
  test('+$30 on May 15 with $3000 monthly: monthly = (old_daily+30)*31, daily = old+30', () => {
    const result = math.compute({
      scope: 'day',
      daySubScope: 'whole_month',
      amount: 30,
      currentMonthly: 3000,
      today: MAY_15,
    });
    expect(result.newMonthlyBudget).toBeCloseTo(3930, 1);
    expect(result.newDailyBudget).toBeCloseTo(126.77, 1);
    expect(result.dailyBudgetWritten).toBe(true);
  });

  test('Feb 10 in a leap year uses 29 days', () => {
    const result = math.compute({
      scope: 'day',
      daySubScope: 'whole_month',
      amount: 10,
      currentMonthly: 2900,
      today: FEB_10_LEAP,
    });
    expect(result.newMonthlyBudget).toBeCloseTo(3190, 2);
    expect(result.newDailyBudget).toBeCloseTo(110, 2);
  });
});

describe('compute() — scope: rest_of_month', () => {
  test('+$30 on May 15: monthly += 30, daily unchanged, dailyBudgetWritten=false', () => {
    const result = math.compute({
      scope: 'rest_of_month',
      amount: 30,
      currentMonthly: 3000,
      today: MAY_15,
    });
    expect(result.newMonthlyBudget).toBe(3030);
    expect(result.dailyBudgetWritten).toBe(false);
  });

  test('-$50 (decrease) is supported and produces correct delta', () => {
    const result = math.compute({
      scope: 'rest_of_month',
      amount: -50,
      currentMonthly: 3000,
      today: MAY_15,
    });
    expect(result.newMonthlyBudget).toBe(2950);
    expect(result.dailyBudgetWritten).toBe(false);
  });

  test('rest-of-month on May 31 still computes the new total — runner schedules revert separately', () => {
    const result = math.compute({
      scope: 'rest_of_month',
      amount: 100,
      currentMonthly: 3000,
      today: MAY_31,
    });
    expect(result.newMonthlyBudget).toBe(3100);
  });
});

describe('compute() — scope: month', () => {
  test('+$30 on May 15: monthly += 30, daily = (old_monthly+30)/31', () => {
    const result = math.compute({
      scope: 'month',
      amount: 30,
      currentMonthly: 3000,
      today: MAY_15,
    });
    expect(result.newMonthlyBudget).toBe(3030);
    expect(result.newDailyBudget).toBeCloseTo(3030 / 31, 2);
    expect(result.dailyBudgetWritten).toBe(true);
  });
});

describe('compute() — set_total (used by Set-total tab)', () => {
  test('user types $4200 on May 15: monthly=4200, daily=4200/31', () => {
    const result = math.compute({
      scope: 'set_total',
      newTotal: 4200,
      today: MAY_15,
    });
    expect(result.newMonthlyBudget).toBe(4200);
    expect(result.newDailyBudget).toBeCloseTo(4200 / 31, 2);
    expect(result.dailyBudgetWritten).toBe(true);
  });
});

describe('compute() — scope: day_rest_of_month (temporary daily bump)', () => {
  test('+$30 day rest_of_month on May 15: monthly += 30×17, daily UNCHANGED, dailyBudgetWritten=false', () => {
    const result = math.compute({
      scope: 'day',
      daySubScope: 'rest_of_month',
      amount: 30,
      currentMonthly: 3000,
      today: MAY_15,
    });
    expect(result.newMonthlyBudget).toBe(3510);
    expect(result.newDailyBudget).toBeNull();
    expect(result.dailyBudgetWritten).toBe(false);
  });

  test('-$10 (decrease) day rest_of_month is supported', () => {
    const result = math.compute({
      scope: 'day',
      daySubScope: 'rest_of_month',
      amount: -10,
      currentMonthly: 3000,
      today: MAY_15,
    });
    expect(result.newMonthlyBudget).toBe(2830);   // 3000 - 10*17
    expect(result.newDailyBudget).toBeNull();
    expect(result.dailyBudgetWritten).toBe(false);
  });
});

describe('compute() — validation', () => {
  test('amount: 0 throws', () => {
    expect(() => math.compute({
      scope: 'rest_of_month', amount: 0, currentMonthly: 3000, today: MAY_15,
    })).toThrow(/non-zero/);
  });

  test('day scope without daySubScope throws', () => {
    expect(() => math.compute({
      scope: 'day', amount: 30, currentMonthly: 3000, today: MAY_15,
    })).toThrow(/daySubScope/);
  });

  test('amount that would drive monthly_budget <= 0 throws', () => {
    expect(() => math.compute({
      scope: 'month', amount: -3000, currentMonthly: 3000, today: MAY_15,
    })).toThrow(/positive/);
  });

  test('day amount that would drive daily_budget <= 0 throws', () => {
    expect(() => math.compute({
      scope: 'day', daySubScope: 'whole_month', amount: -200,
      currentMonthly: 3000, today: MAY_15,
    })).toThrow(/positive/);
  });

  test('unknown scope throws', () => {
    expect(() => math.compute({
      scope: 'banana', amount: 1, currentMonthly: 3000, today: MAY_15,
    })).toThrow(/unknown scope/i);
  });
});

describe('firstOfNextMonth()', () => {
  test('May 15 2026 → 2026-06-01', () => {
    expect(math.firstOfNextMonth(MAY_15).toISOString().slice(0, 10)).toBe('2026-06-01');
  });

  test('May 31 2026 → 2026-06-01', () => {
    expect(math.firstOfNextMonth(MAY_31).toISOString().slice(0, 10)).toBe('2026-06-01');
  });

  test('Dec 15 2026 → 2027-01-01 (year rollover)', () => {
    const dec15 = new Date(Date.UTC(2026, 11, 15));
    expect(math.firstOfNextMonth(dec15).toISOString().slice(0, 10)).toBe('2027-01-01');
  });
});
