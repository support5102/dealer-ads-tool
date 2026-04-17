/**
 * Pacing Curve — pure-function registry of per-day target percentages.
 *
 * Called by: services/pacing-engine-v2.js, services/pacing-fetcher.js
 * Calls: nothing (pure math, no external deps)
 *
 * A curve maps (day_of_month, days_in_month) -> target % of linear pace.
 * cumulativeTarget() returns the fraction of the monthly budget that should
 * be spent by end-of-day N, normalized so day=daysInMonth always returns 1.0.
 */

/**
 * Registry of pacing curves. Keys are curve IDs used in Google Sheets goals
 * and in ACCOUNT_CURVES in strategy-rules.js.
 *
 * Each curve is a function: (day, daysInMonth) -> target_pct_of_linear.
 * - 1.0 means "spend at linear monthly pace today"
 * - 0.95 means "spend 5% below linear today" (e.g. Alan Jay first two weeks)
 * - 1.05 means "spend 5% above linear today" (e.g. Alan Jay last two weeks)
 */
const PACING_CURVES = {
  linear: (day, daysInMonth) => 1.0,

  // Alan Jay 95/105: first ~half of month at 95%, second ~half at 105%.
  // Split point is day 14 regardless of month length (his request).
  alanJay9505: (day, daysInMonth) => (day <= 14 ? 0.95 : 1.05),
};

/**
 * Evaluates a curve for a single day.
 *
 * @param {string} curveId - Key into PACING_CURVES (e.g. 'linear', 'alanJay9505')
 * @param {number} day - Day of month (1-based)
 * @param {number} daysInMonth - Total days in the current month
 * @returns {number} Target multiplier (1.0 = linear pace)
 * @throws {Error} If curveId is not registered
 */
function evaluateCurve(curveId, day, daysInMonth) {
  const curve = PACING_CURVES[curveId];
  if (!curve) {
    throw new Error(`Unknown curve "${curveId}". Known: ${Object.keys(PACING_CURVES).join(', ')}`);
  }
  return curve(day, daysInMonth);
}

/**
 * Returns the cumulative fraction of the monthly budget that should be spent
 * by end-of-day `throughDay`, normalized so day=daysInMonth returns 1.0.
 *
 * Normalization: sum curve values for all days, divide each day's share by total.
 * This ensures every curve lands at exactly 100% on the last day.
 *
 * @param {string} curveId - Key into PACING_CURVES
 * @param {number} throughDay - Compute cumulative through end of this day (0 = nothing yet)
 * @param {number} daysInMonth - Total days in month
 * @returns {number} Cumulative fraction (0.0 to 1.0)
 */
function cumulativeTarget(curveId, throughDay, daysInMonth) {
  if (throughDay <= 0) return 0;
  if (throughDay >= daysInMonth) return 1.0;

  const curve = PACING_CURVES[curveId];
  if (!curve) {
    throw new Error(`Unknown curve "${curveId}". Known: ${Object.keys(PACING_CURVES).join(', ')}`);
  }

  let totalWeight = 0;
  let elapsedWeight = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const w = curve(d, daysInMonth);
    totalWeight += w;
    if (d <= throughDay) elapsedWeight += w;
  }

  return totalWeight === 0 ? 0 : elapsedWeight / totalWeight;
}

module.exports = {
  PACING_CURVES,
  evaluateCurve,
  cumulativeTarget,
};
