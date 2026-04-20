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
// Only 3 statuses: on_pace, over, under. No "critical" — severity is handled
// by urgency levels in pacing-detector.js (separate concern).
const PACING_THRESHOLDS = {
  ON_PACE: { min: -5, max: 5 },
  OVER:    { min: 5           },
  UNDER:   {          max: -5 },
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
 * @returns {string} One of: 'on_pace', 'over', 'under'
 */
function getPacingStatus(variancePercent) {
  if (variancePercent > PACING_THRESHOLDS.ON_PACE.max) return 'over';
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

/**
 * Computes 7-day spend trend from daily spend data.
 *
 * Compares the average daily spend over the last 7 days to the prior 7 days.
 * Returns direction (up/down/flat) and percent change.
 *
 * @param {Object[]} dailySpend - Array of { date, spend } sorted by date ascending
 * @returns {{ sevenDayAvg: number, sevenDayTrend: string, sevenDayTrendPercent: number }}
 */
function calculateSevenDayTrend(dailySpend) {
  const flat = { sevenDayAvg: 0, sevenDayTrend: 'flat', sevenDayTrendPercent: 0 };

  if (!dailySpend || dailySpend.length < 2) return flat;

  // Take the most recent 14 entries max
  const recent = dailySpend.slice(-14);

  // Split into last 7 and prior 7
  const last7 = recent.slice(-7);
  const prior7 = recent.slice(0, recent.length - last7.length);

  const last7Avg = last7.length > 0
    ? last7.reduce((sum, d) => sum + d.spend, 0) / last7.length
    : 0;

  const prior7Avg = prior7.length > 0
    ? prior7.reduce((sum, d) => sum + d.spend, 0) / prior7.length
    : 0;

  let trendPercent;
  if (prior7Avg === 0 && last7Avg > 0) {
    trendPercent = 100;
  } else if (prior7Avg === 0 && last7Avg === 0) {
    trendPercent = 0;
  } else {
    trendPercent = ((last7Avg - prior7Avg) / prior7Avg) * 100;
  }

  const trend = trendPercent > 3 ? 'up' : trendPercent < -3 ? 'down' : 'flat';

  return {
    sevenDayAvg: Math.round(last7Avg * 100) / 100,
    sevenDayTrend: trend,
    sevenDayTrendPercent: Math.round(trendPercent * 10) / 10,
  };
}

/**
 * Projects month-end spend based on post-change daily average.
 *
 * If a budget change happened this month, uses only the spend rate since that
 * change to project whether the account will hit its monthly budget.
 * If no change, uses the full-month projected spend from calculatePacing.
 *
 * @param {Object} params
 * @param {number} params.monthlyBudget - Monthly budget target
 * @param {number} params.mtdSpend - Month-to-date total spend
 * @param {Object[]} params.dailySpend - Array of { date, spend } (14-day data)
 * @param {string|null} params.changeDate - Last budget change date (YYYY-MM-DD) or null
 * @param {number} params.year - Current year
 * @param {number} params.month - Current month (1-12)
 * @param {number} params.currentDay - Current day of month
 * @returns {{ projectedSpend: number, projectedStatus: string, postChangeDailyAvg: number|null, changeDate: string|null }}
 */
function calculateProjection(params) {
  const { monthlyBudget, mtdSpend, dailySpend, changeDate, year, month, currentDay } = params;

  const totalDays = daysInMonth(year, month);
  const daysElapsed = Math.min(currentDay, totalDays);
  const daysRemaining = Math.max(totalDays - daysElapsed, 0);

  // No budget change: project from full-month average
  if (!changeDate || !dailySpend || dailySpend.length === 0) {
    const dailyAvg = daysElapsed > 0 ? mtdSpend / daysElapsed : 0;
    const projectedSpend = mtdSpend + (dailyAvg * daysRemaining);
    const variance = monthlyBudget > 0
      ? ((projectedSpend - monthlyBudget) / monthlyBudget) * 100
      : 0;
    return {
      projectedSpend: Math.round(projectedSpend * 100) / 100,
      projectedStatus: getProjectionStatus(variance),
      postChangeDailyAvg: null,
      changeDate: null,
    };
  }

  // Filter daily spend to post-change days
  const postChangeDays = dailySpend.filter(d => d.date >= changeDate);

  if (postChangeDays.length === 0) {
    // Change too recent, no post-change data yet — fall back to full-month
    const dailyAvg = daysElapsed > 0 ? mtdSpend / daysElapsed : 0;
    const projectedSpend = mtdSpend + (dailyAvg * daysRemaining);
    const variance = monthlyBudget > 0
      ? ((projectedSpend - monthlyBudget) / monthlyBudget) * 100
      : 0;
    return {
      projectedSpend: Math.round(projectedSpend * 100) / 100,
      projectedStatus: getProjectionStatus(variance),
      postChangeDailyAvg: null,
      changeDate,
    };
  }

  // Compute post-change daily average and project forward
  const postChangeTotal = postChangeDays.reduce((sum, d) => sum + (d.spend || 0), 0);
  const postChangeDailyAvg = postChangeTotal / postChangeDays.length;
  const projectedRemainingSpend = postChangeDailyAvg * daysRemaining;
  const projectedSpend = mtdSpend + projectedRemainingSpend;

  const variance = monthlyBudget > 0
    ? ((projectedSpend - monthlyBudget) / monthlyBudget) * 100
    : 0;

  return {
    projectedSpend: Math.round(projectedSpend * 100) / 100,
    projectedStatus: getProjectionStatus(variance),
    postChangeDailyAvg: Math.round(postChangeDailyAvg * 100) / 100,
    changeDate,
  };
}

/**
 * Maps a projection variance % to a status string.
 * Uses the same thresholds as pacing status.
 */
function getProjectionStatus(variance) {
  if (variance >= 15)  return 'will_over';
  if (variance >= 5)   return 'over';
  if (variance <= -15)  return 'will_under';
  if (variance <= -5)   return 'under';
  return 'on_track';
}

module.exports = {
  calculatePacing,
  calculateProjection,
  calculateSevenDayTrend,
  getPacingStatus,
  applyInventoryModifier,
  weightedExpectedSpend,
  requiredDailyRate,
  getMonthDayWeights,
  daysInMonth,
  DEFAULT_DAY_WEIGHTS,
  PACING_THRESHOLDS,
};
