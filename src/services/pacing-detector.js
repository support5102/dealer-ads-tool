/**
 * Pacing Detector — identifies accounts that need budget intervention.
 *
 * Called by: routes/budget-adjustments.js (Phase 2)
 * Uses: pacing data from /api/pacing/all, projection data from calculateProjection
 *
 * Detection is stricter than display thresholds. An account needs intervention when:
 * 1. Pacing variance is severe (>8% off pace) OR
 * 2. Projected end-of-month miss exceeds 10% of budget OR
 * 3. 7-day trend shows accelerating divergence from target
 *
 * Returns flagged accounts with urgency scores for prioritization.
 */

/**
 * Intervention thresholds — stricter than display thresholds.
 * These trigger budget adjustment recommendations.
 */
const INTERVENTION_THRESHOLDS = {
  // Pacing variance that triggers intervention (±%)
  paceVariance: 8,
  // Projected month-end miss that triggers intervention (%)
  projectedMiss: 10,
  // 7-day trend acceleration that adds urgency (% change)
  trendAcceleration: 15,
  // Minimum days into month before intervening (too early = noisy data).
  // Note: checked by the scan caller (Phase 2) which has date context, not here.
  minimumDaysElapsed: 5,
  // Minimum daily spend to consider (accounts spending <$5/day are likely paused)
  minimumDailySpend: 5,
};

/**
 * Urgency levels for flagged accounts.
 */
const URGENCY = {
  CRITICAL: 'critical',   // >15% off pace + bad projection
  HIGH: 'high',           // >10% off pace or projection shows significant miss
  MEDIUM: 'medium',       // 8-10% off pace, trend worsening
};

/**
 * Analyzes an array of account pacing data and flags those needing intervention.
 *
 * @param {Object[]} accounts - Array of account pacing data from /api/pacing/all
 *   Each account has: customerId, dealerName, monthlyBudget, mtdSpend, pacePercent,
 *   status, dailyAdjustment, sevenDayAvg, sevenDayTrend, sevenDayTrendPercent,
 *   projectedSpend, projectedStatus, postChangeDailyAvg, changeDate
 * @param {Object} [options] - Override default thresholds
 * @returns {Object[]} Flagged accounts sorted by urgency (critical first)
 */
function detectInterventions(accounts, options = {}) {
  const thresholds = { ...INTERVENTION_THRESHOLDS, ...options };

  if (!accounts || accounts.length === 0) return [];

  const flagged = [];

  for (const account of accounts) {
    const result = analyzeAccount(account, thresholds);
    if (result) flagged.push(result);
  }

  // Sort by urgency (critical → high → medium), then by absolute variance (worst first)
  const urgencyOrder = { [URGENCY.CRITICAL]: 0, [URGENCY.HIGH]: 1, [URGENCY.MEDIUM]: 2 };
  flagged.sort((a, b) => {
    const urgDiff = (urgencyOrder[a.urgency] ?? 3) - (urgencyOrder[b.urgency] ?? 3);
    if (urgDiff !== 0) return urgDiff;
    return Math.abs(b.paceVariance) - Math.abs(a.paceVariance);
  });

  return flagged;
}

/**
 * Analyzes a single account and determines if intervention is needed.
 *
 * @param {Object} account - Single account pacing data
 * @param {Object} thresholds - Intervention thresholds
 * @returns {Object|null} Flagged account data or null if no intervention needed
 */
function analyzeAccount(account, thresholds) {
  // Skip accounts with insufficient data
  if (!account || !account.monthlyBudget || account.monthlyBudget <= 0) return null;

  // Check minimum daily spend (skip near-zero accounts)
  if (account.sevenDayAvg != null && account.sevenDayAvg < thresholds.minimumDailySpend) {
    // Exception: if budget is set but spend is near zero, that's critical under-pacing
    const expectedDaily = account.monthlyBudget / 30;
    if (expectedDaily < thresholds.minimumDailySpend) return null;
  }

  // pacePercent is a variance from target (e.g., +8 = 8% over, -8 = 8% under)
  // as output by pacing-calculator.js: ((spend - expected) / expected) * 100
  const paceVariance = account.pacePercent || 0;
  const absPaceVariance = Math.abs(paceVariance);

  // Calculate projected miss %
  let projectedMissPercent = 0;
  if (account.projectedSpend != null && account.monthlyBudget > 0) {
    projectedMissPercent = ((account.projectedSpend - account.monthlyBudget) / account.monthlyBudget) * 100;
  }
  const absProjectedMiss = Math.abs(projectedMissPercent);

  // 7-day trend acceleration — worsening trend adds urgency
  const trendPercent = account.sevenDayTrendPercent || 0;
  const trendWorsening = (
    (paceVariance > 0 && account.sevenDayTrend === 'up') ||  // over-pacing and spend increasing
    (paceVariance < 0 && account.sevenDayTrend === 'down')    // under-pacing and spend decreasing
  );

  // Determine if intervention is needed
  const needsIntervention =
    absPaceVariance >= thresholds.paceVariance ||
    absProjectedMiss >= thresholds.projectedMiss;

  if (!needsIntervention) return null;

  // Determine urgency
  let urgency;
  const reasons = [];

  if (absPaceVariance >= 15 || absProjectedMiss >= 20) {
    urgency = URGENCY.CRITICAL;
    if (absPaceVariance >= 15) reasons.push(`${paceVariance > 0 ? '+' : ''}${paceVariance.toFixed(1)}% off pace`);
    if (absProjectedMiss >= 20) reasons.push(`projected ${projectedMissPercent > 0 ? '+' : ''}${projectedMissPercent.toFixed(1)}% miss`);
  } else if (absPaceVariance >= 10 || absProjectedMiss >= 15) {
    urgency = URGENCY.HIGH;
    if (absPaceVariance >= 10) reasons.push(`${paceVariance > 0 ? '+' : ''}${paceVariance.toFixed(1)}% off pace`);
    if (absProjectedMiss >= 15) reasons.push(`projected ${projectedMissPercent > 0 ? '+' : ''}${projectedMissPercent.toFixed(1)}% miss`);
  } else {
    urgency = URGENCY.MEDIUM;
    if (absPaceVariance >= thresholds.paceVariance) reasons.push(`${paceVariance > 0 ? '+' : ''}${paceVariance.toFixed(1)}% off pace`);
    if (absProjectedMiss >= thresholds.projectedMiss) reasons.push(`projected ${projectedMissPercent > 0 ? '+' : ''}${projectedMissPercent.toFixed(1)}% miss`);
  }

  // Bump urgency if trend is worsening and significant
  if (trendWorsening && Math.abs(trendPercent) >= thresholds.trendAcceleration && urgency === URGENCY.MEDIUM) {
    urgency = URGENCY.HIGH;
    reasons.push(`trend worsening (${trendPercent > 0 ? '+' : ''}${trendPercent.toFixed(1)}% 7-day)`);
  }

  const direction = paceVariance > 0 ? 'over' : 'under';

  return {
    customerId: account.customerId,
    dealerName: account.dealerName,
    direction,
    urgency,
    reasons,
    paceVariance: Math.round(paceVariance * 10) / 10,
    projectedMissPercent: Math.round(projectedMissPercent * 10) / 10,
    projectedSpend: account.projectedSpend,
    monthlyBudget: account.monthlyBudget,
    mtdSpend: account.mtdSpend,
    sevenDayAvg: account.sevenDayAvg,
    sevenDayTrend: account.sevenDayTrend,
    sevenDayTrendPercent: account.sevenDayTrendPercent,
    changeDate: account.changeDate,
    // Pass through for downstream recommendation engine
    pacePercent: account.pacePercent,
    status: account.status,
    dailyAdjustment: account.dailyAdjustment,
  };
}

module.exports = {
  detectInterventions,
  analyzeAccount,
  INTERVENTION_THRESHOLDS,
  URGENCY,
};
