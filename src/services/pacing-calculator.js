/**
 * Pacing Calculator — computes budget pacing state for dealer accounts.
 *
 * Called by: services/pacing-scheduler.js (future), routes/pacing.js (future)
 * Calls: nothing (pure calculation, no external deps)
 *
 * Takes a dealer's monthly goal and current spend data, produces a pacing
 * state object with variance %, status, required daily rate, and recommended
 * adjustments. Supports day-of-week weighting and inventory modifiers.
 */

// Day-of-week spend weights (0=Sunday, 6=Saturday)
// Reflects typical auto dealer search traffic patterns
const DEFAULT_DAY_WEIGHTS = [0.75, 0.95, 1.00, 1.00, 1.05, 1.10, 1.15];

// Consumer-facing reference for threshold values.
// getPacingStatus() uses these values directly — keep in sync if changing.
const PACING_THRESHOLDS = {
  ON_PACE:        { min: -5,   max: 5   },
  OVER:           { min: 5,    max: 15  },
  UNDER:          { min: -15,  max: -5  },
  CRITICAL_OVER:  { min: 15               },
  CRITICAL_UNDER: {            max: -15  },
};

/**
 * Returns the number of days in a given month.
 *
 * @param {number} year - Full year (e.g. 2026)
 * @param {number} month - Month 1-12
 * @returns {number} Days in the month
 */
function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * Gets the day-of-week weights for each day in a month.
 *
 * @param {number} year - Full year
 * @param {number} month - Month 1-12
 * @param {number[]} [weights=DEFAULT_DAY_WEIGHTS] - Weight per day of week (Sun=0..Sat=6)
 * @returns {number[]} Array of weights, one per day of the month (index 0 = day 1)
 */
function getMonthDayWeights(year, month, weights = DEFAULT_DAY_WEIGHTS) {
  const days = daysInMonth(year, month);
  const result = [];
  for (let d = 1; d <= days; d++) {
    const dow = new Date(year, month - 1, d).getDay();
    result.push(weights[dow]);
  }
  return result;
}

/**
 * Calculates the weighted expected spend for a range of days within a month.
 *
 * @param {number} monthlyBudget - Total monthly budget target
 * @param {number[]} dayWeights - Weight for each day of the month
 * @param {number} throughDay - Calculate expected spend through this day (1-based, inclusive)
 * @returns {number} Expected spend through the given day
 */
function weightedExpectedSpend(monthlyBudget, dayWeights, throughDay) {
  const totalWeight = dayWeights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) return 0;

  const elapsedWeight = dayWeights.slice(0, throughDay).reduce((sum, w) => sum + w, 0);
  return monthlyBudget * (elapsedWeight / totalWeight);
}

/**
 * Calculates the required daily spend rate for remaining days.
 *
 * @param {number} remainingBudget - Budget left to spend
 * @param {number[]} remainingDayWeights - Weights for remaining days
 * @param {number} [todayIndex=0] - Index into remainingDayWeights for "today"
 * @returns {number} Weighted daily rate for today (or average if no weights)
 */
function requiredDailyRate(remainingBudget, remainingDayWeights, todayIndex = 0) {
  if (remainingDayWeights.length === 0) return 0;
  if (remainingBudget <= 0) return 0;

  const totalWeight = remainingDayWeights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) return 0;

  const todayWeight = remainingDayWeights[todayIndex] || remainingDayWeights[0];
  return remainingBudget * (todayWeight / totalWeight);
}

/**
 * Applies inventory modifier to a monthly budget target.
 *
 * @param {number} monthlyBudget - Base monthly budget
 * @param {number} currentInventory - Current inventory count
 * @param {number} baselineInventory - Normal inventory level
 * @returns {{ effectiveBudget: number, modifier: number, reason: string|null }}
 */
function applyInventoryModifier(monthlyBudget, currentInventory, baselineInventory) {
  if (!baselineInventory || baselineInventory <= 0 || currentInventory == null) {
    return { effectiveBudget: monthlyBudget, modifier: 1.0, reason: null };
  }

  const ratio = currentInventory / baselineInventory;

  if (ratio < 0.5) {
    return {
      effectiveBudget: Math.round(monthlyBudget * 0.60 * 100) / 100,
      modifier: 0.60,
      reason: `Low inventory (${Math.round(ratio * 100)}% of normal) — budget reduced to 60%`,
    };
  }
  if (ratio < 0.8) {
    return {
      effectiveBudget: Math.round(monthlyBudget * 0.80 * 100) / 100,
      modifier: 0.80,
      reason: `Below-average inventory (${Math.round(ratio * 100)}% of normal) — budget reduced to 80%`,
    };
  }
  if (ratio > 1.2) {
    const mod = Math.min(1.20, 1.0 + (ratio - 1.0) * 0.5);
    return {
      effectiveBudget: Math.round(monthlyBudget * mod * 100) / 100,
      modifier: mod,
      reason: `High inventory (${Math.round(ratio * 100)}% of normal) — budget increased to ${Math.round(mod * 100)}%`,
    };
  }

  return { effectiveBudget: monthlyBudget, modifier: 1.0, reason: null };
}

/**
 * Determines pacing status from variance percentage.
 *
 * @param {number} variancePercent - Pacing variance (positive = over, negative = under)
 * @returns {string} One of: 'on_pace', 'over', 'under', 'critical_over', 'critical_under'
 */
function getPacingStatus(variancePercent) {
  if (variancePercent >= PACING_THRESHOLDS.CRITICAL_OVER.min) return 'critical_over';
  if (variancePercent > PACING_THRESHOLDS.ON_PACE.max) return 'over';
  if (variancePercent <= PACING_THRESHOLDS.CRITICAL_UNDER.max) return 'critical_under';
  if (variancePercent < PACING_THRESHOLDS.ON_PACE.min) return 'under';
  return 'on_pace';
}

/**
 * Computes full pacing state for a dealer account.
 *
 * @param {Object} params
 * @param {number} params.monthlyBudget - Monthly budget target ($)
 * @param {number} params.spendToDate - Actual spend so far this month ($)
 * @param {number} params.year - Current year
 * @param {number} params.month - Current month (1-12)
 * @param {number} params.currentDay - Current day of month (1-based)
 * @param {number} [params.currentInventory] - Current inventory count
 * @param {number} [params.baselineInventory] - Normal inventory level
 * @param {number[]} [params.dayWeights] - Custom day-of-week weights
 * @returns {Object} Pacing state with all computed fields
 */
function calculatePacing(params) {
  const {
    monthlyBudget,
    spendToDate,
    year,
    month,
    currentDay,
    currentInventory,
    baselineInventory,
    dayWeights = DEFAULT_DAY_WEIGHTS,
  } = params;

  const totalDays = daysInMonth(year, month);
  const daysElapsed = Math.min(currentDay, totalDays);
  const daysRemaining = Math.max(totalDays - daysElapsed, 0);

  // Inventory adjustment
  const inventory = applyInventoryModifier(monthlyBudget, currentInventory, baselineInventory);
  const effectiveBudget = inventory.effectiveBudget;

  // Day weights for the month
  const monthWeights = getMonthDayWeights(year, month, dayWeights);

  // Expected spend (weighted) through current day
  const expectedSpend = weightedExpectedSpend(effectiveBudget, monthWeights, daysElapsed);

  // Pacing variance
  const variancePercent = expectedSpend > 0
    ? ((spendToDate - expectedSpend) / expectedSpend) * 100
    : 0;

  const status = getPacingStatus(variancePercent);

  // Remaining budget and required rate
  const remainingBudget = Math.max(effectiveBudget - spendToDate, 0);
  const remainingWeights = monthWeights.slice(daysElapsed);
  const requiredRate = requiredDailyRate(remainingBudget, remainingWeights);

  // Actual daily average
  const dailyAvgSpend = daysElapsed > 0 ? spendToDate / daysElapsed : 0;

  // Ideal daily rate (flat, for reference)
  const idealDailyRate = totalDays > 0 ? effectiveBudget / totalDays : 0;

  // Projected month-end spend — uses weighted projection:
  // spend-per-unit-weight so far, applied to the full month's weight total
  const elapsedWeight = monthWeights.slice(0, daysElapsed).reduce((s, w) => s + w, 0);
  const totalWeight = monthWeights.reduce((s, w) => s + w, 0);
  const projectedSpend = (elapsedWeight > 0 && totalWeight > 0)
    ? spendToDate * (totalWeight / elapsedWeight)
    : 0;

  return {
    // Time
    daysInMonth: totalDays,
    daysElapsed,
    daysRemaining,

    // Budget
    monthlyBudget,
    effectiveBudget,
    inventoryModifier: inventory.modifier,
    inventoryReason: inventory.reason,

    // Spend
    spendToDate,
    expectedSpend: Math.round(expectedSpend * 100) / 100,
    remainingBudget: Math.round(remainingBudget * 100) / 100,

    // Rates
    dailyAvgSpend: Math.round(dailyAvgSpend * 100) / 100,
    idealDailyRate: Math.round(idealDailyRate * 100) / 100,
    requiredDailyRate: Math.round(requiredRate * 100) / 100,

    // Pacing
    pacePercent: Math.round(variancePercent * 10) / 10,
    paceStatus: status,

    // Projection
    projectedSpend: Math.round(projectedSpend * 100) / 100,
  };
}

module.exports = {
  calculatePacing,
  getPacingStatus,
  applyInventoryModifier,
  weightedExpectedSpend,
  requiredDailyRate,
  getMonthDayWeights,
  daysInMonth,
  DEFAULT_DAY_WEIGHTS,
  PACING_THRESHOLDS,
};
