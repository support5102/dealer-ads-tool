/**
 * Pacing Engine v2 — damped daily budget controller.
 *
 * Called by: services/scheduler.js (daily job, registered in server.js),
 *            routes/pacing.js (optional preview endpoint).
 * Calls: pacing-curve.js (cumulativeTarget), pacing-calculator.js (daysInMonth).
 *
 * Core algorithm:
 *   1. Compute target cumulative spend from curve + day-of-month.
 *   2. Compute required daily rate for remaining days to hit EOM target.
 *   3. Apply safety rails: ±20% cap, freeze last 2 days, 24h/72h cooldown,
 *      dead-zone (±2% variance), absolute floor/ceiling.
 *   4. Return either { skipped: true, reason } or { newDailyBudget, ... }.
 */

const { cumulativeTarget } = require('./pacing-curve');
const { daysInMonth } = require('./pacing-calculator');

const SAFETY_LIMITS = Object.freeze({
  MAX_ADJUSTMENT_PCT: 0.20,           // ±20% per day
  FREEZE_DAYS_AT_EOM: 2,              // no adjustments in last N days
  COOLDOWN_HOURS_DEFAULT: 24,         // minimum hours between adjustments
  COOLDOWN_HOURS_TARGET_STRATEGY: 72, // for TARGET_CPA / TARGET_ROAS
  DEAD_ZONE_PCT: 0.02,                // skip if variance < 2%
  ABSOLUTE_FLOOR: 5,                  // never propose below $5/day
  CEILING_MULTIPLIER: 3,              // never propose above 3x naive daily rate
});

const TARGET_STRATEGIES = new Set(['TARGET_CPA', 'TARGET_ROAS']);

/**
 * @typedef {Object} AdjustmentResult
 * @property {boolean} skipped - True if no adjustment was proposed
 * @property {string|null} reason - Skip reason (e.g. 'freeze_window:last_2_days'); null if not skipped
 * @property {number|null} newDailyBudget - Proposed daily budget in dollars, rounded to cents; null if skipped
 * @property {number|null} variance - Fractional variance from curve target (0.15 = 15% over); null for freeze/cooldown skips
 * @property {number|null} curveTarget - Curve target in dollars, rounded to cents; null for freeze/cooldown skips
 * @property {'max_increase'|'max_decrease'|'floor'|'ceiling'|null} clampedBy - Name of the binding constraint if the proposed budget was clamped; null if no clamp fired or if skipped
 */

/**
 * Proposes a new daily budget for one account based on curve + safety rails.
 *
 * @param {Object} params
 * @param {number} params.monthlyBudget - Monthly budget target ($)
 * @param {number} params.mtdSpend - Month-to-date total spend ($)
 * @param {number} params.currentDailyBudget - Current daily budget ($)
 * @param {string} params.curveId - Curve ID from pacing-curve.PACING_CURVES
 * @param {number} params.year - Year (e.g. 2026)
 * @param {number} params.month - Month 1-12
 * @param {number} params.currentDay - Day of month (1-based)
 * @param {string|null} params.lastChangeTimestamp - ISO timestamp of last budget change, or null
 * @param {string} params.bidStrategyType - Google Ads bid strategy enum (e.g. MAXIMIZE_CLICKS, TARGET_CPA)
 * @returns {AdjustmentResult}
 */
function proposeAdjustment(params) {
  const {
    monthlyBudget,
    mtdSpend,
    currentDailyBudget,
    curveId,
    year,
    month,
    currentDay,
    lastChangeTimestamp,
    bidStrategyType,
  } = params;

  const totalDays = daysInMonth(year, month);
  const daysRemaining = Math.max(totalDays - currentDay, 0);

  // Rail 1: freeze window (last 2 days)
  if (daysRemaining < SAFETY_LIMITS.FREEZE_DAYS_AT_EOM) {
    return {
      skipped: true,
      reason: `freeze_window:last_${SAFETY_LIMITS.FREEZE_DAYS_AT_EOM}_days`,
      newDailyBudget: null,
      variance: null,
      curveTarget: null,
      clampedBy: null,
    };
  }

  // Rail 2: cooldown
  if (lastChangeTimestamp) {
    const hoursSince = (Date.now() - new Date(lastChangeTimestamp).getTime()) / (1000 * 60 * 60);
    const isTargetStrategy = TARGET_STRATEGIES.has(String(bidStrategyType).toUpperCase());
    const cooldown = isTargetStrategy
      ? SAFETY_LIMITS.COOLDOWN_HOURS_TARGET_STRATEGY
      : SAFETY_LIMITS.COOLDOWN_HOURS_DEFAULT;
    if (hoursSince < cooldown) {
      return {
        skipped: true,
        reason: isTargetStrategy
          ? `target_strategy_cooldown:${cooldown}h`
          : `cooldown:${cooldown}h_recent_change`,
        newDailyBudget: null,
        variance: null,
        curveTarget: null,
        clampedBy: null,
      };
    }
  }

  // Compute curve target and variance
  const cumFrac = cumulativeTarget(curveId, currentDay, totalDays);
  const curveTargetDollars = monthlyBudget * cumFrac;
  const varianceDollars = mtdSpend - curveTargetDollars;
  const variancePct = curveTargetDollars > 0
    ? varianceDollars / curveTargetDollars
    : 0;

  // Rail 3: dead zone
  if (Math.abs(variancePct) < SAFETY_LIMITS.DEAD_ZONE_PCT) {
    return {
      skipped: true,
      reason: 'dead_zone:on_pace_within_2pct',
      newDailyBudget: null,
      variance: variancePct,
      curveTarget: Math.round(curveTargetDollars * 100) / 100,
      clampedBy: null,
    };
  }

  // Required daily rate for remaining days to hit EOM target
  const remainingBudget = monthlyBudget - mtdSpend;
  const rawRequiredDaily = daysRemaining > 0
    ? remainingBudget / daysRemaining
    : 0;

  // Rail 4: ±20% cap on single-day adjustment
  const maxIncrease = currentDailyBudget * (1 + SAFETY_LIMITS.MAX_ADJUSTMENT_PCT);
  const maxDecrease = currentDailyBudget * (1 - SAFETY_LIMITS.MAX_ADJUSTMENT_PCT);
  let clampedBy = null;
  let proposed = rawRequiredDaily;
  if (proposed > maxIncrease) {
    proposed = maxIncrease;
    clampedBy = 'max_increase';
  } else if (proposed < maxDecrease) {
    proposed = maxDecrease;
    clampedBy = 'max_decrease';
  }

  // Rail 5: absolute floor + ceiling (overrides Rail 4 if they fire)
  const naiveDaily = monthlyBudget / totalDays;
  const ceiling = naiveDaily * SAFETY_LIMITS.CEILING_MULTIPLIER;
  if (proposed > ceiling) {
    proposed = ceiling;
    clampedBy = 'ceiling';
  }
  if (proposed < SAFETY_LIMITS.ABSOLUTE_FLOOR) {
    proposed = SAFETY_LIMITS.ABSOLUTE_FLOOR;
    clampedBy = 'floor';
  }

  return {
    skipped: false,
    reason: null,
    newDailyBudget: Math.round(proposed * 100) / 100,
    variance: variancePct,
    curveTarget: Math.round(curveTargetDollars * 100) / 100,
    clampedBy,
  };
}

/**
 * @typedef {Object} RunForAccountResult
 * @property {'skipped'|'advisory'|'logged'|'applied'|'failed'} outcome - Discriminator for the five exit paths
 * @property {boolean} skipped - Redundant with outcome === 'skipped' but kept for backwards reading
 * @property {boolean} applied - True only if Google Ads budget actually changed (outcome === 'applied')
 * @property {AdjustmentResult} proposed - The raw proposal object from proposeAdjustment
 * @property {string} [reason] - Set when outcome === 'skipped'; the skip reason from proposeAdjustment
 * @property {string} [error] - Set when outcome === 'failed'; message from the failing applyBudgetChange
 * @property {string} [logError] - Set when logChange itself threw; independent of error
 */

/**
 * Runs the pacing engine for one account end-to-end.
 * Computes a proposal, then applies/logs according to pacingMode.
 *
 * @param {Object} account - { customerId, dealerName, goal, mtdSpend,
 *                             currentDailyBudget, bidStrategyType, lastChangeTimestamp }
 * @param {Object} deps - { now: Date, applyBudgetChange(cid, $), logChange(entry) }
 * @returns {Promise<RunForAccountResult>}
 */
async function runForAccount(account, deps) {
  const getErrorMessage = (err) => (err && err.message) ? err.message : String(err);

  const now = deps.now || new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  // TODO(8.2): verify timezone semantics — getUTCDate() on a midnight-ET scheduler run
  // returns the *next* day in UTC, which could cause off-by-one day-of-month for US dealers.
  const day = now.getUTCDate();

  const proposal = proposeAdjustment({
    monthlyBudget: account.goal.monthlyBudget,
    mtdSpend: account.mtdSpend,
    currentDailyBudget: account.currentDailyBudget,
    curveId: account.goal.pacingCurveId || 'linear',
    year,
    month,
    currentDay: day,
    lastChangeTimestamp: account.lastChangeTimestamp,
    bidStrategyType: account.bidStrategyType,
  });

  if (proposal.skipped) {
    return { outcome: 'skipped', skipped: true, applied: false, proposed: proposal, reason: proposal.reason };
  }

  const mode = account.goal.pacingMode || 'one_click';

  // Advisory: no side effects
  if (mode === 'advisory') {
    return { outcome: 'advisory', skipped: false, applied: false, proposed: proposal };
  }

  // one_click: log as pending, do not apply
  if (mode === 'one_click') {
    try {
      await deps.logChange({
        action: 'update_budget',
        accountId: account.customerId,
        dealerName: account.dealerName,
        details: {
          oldDailyBudget: account.currentDailyBudget,
          newDailyBudget: proposal.newDailyBudget,
          curveTarget: proposal.curveTarget,
          variance: proposal.variance,
          clampedBy: proposal.clampedBy,
        },
        source: 'pacing_engine_v2_pending',
        success: true,
      });
    } catch (logErr) {
      return { outcome: 'logged', skipped: false, applied: false, proposed: proposal, logError: getErrorMessage(logErr) };
    }
    return { outcome: 'logged', skipped: false, applied: false, proposed: proposal };
  }

  // auto_apply: push to Google Ads, then log
  try {
    await deps.applyBudgetChange(account.customerId, proposal.newDailyBudget);
    try {
      await deps.logChange({
        action: 'update_budget',
        accountId: account.customerId,
        dealerName: account.dealerName,
        details: {
          oldDailyBudget: account.currentDailyBudget,
          newDailyBudget: proposal.newDailyBudget,
          curveTarget: proposal.curveTarget,
          variance: proposal.variance,
          clampedBy: proposal.clampedBy,
        },
        source: 'pacing_engine_v2',
        success: true,
      });
    } catch (logErr) {
      return { outcome: 'applied', skipped: false, applied: true, proposed: proposal, logError: getErrorMessage(logErr) };
    }
    return { outcome: 'applied', skipped: false, applied: true, proposed: proposal };
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    let logError;
    try {
      await deps.logChange({
        action: 'update_budget',
        accountId: account.customerId,
        dealerName: account.dealerName,
        details: {
          oldDailyBudget: account.currentDailyBudget,
          newDailyBudget: proposal.newDailyBudget,
          curveTarget: proposal.curveTarget,
          variance: proposal.variance,
          clampedBy: proposal.clampedBy,
          attemptedButFailed: true,
        },
        source: 'pacing_engine_v2',
        success: false,
        error: errorMessage,
      });
    } catch (logErr) {
      logError = getErrorMessage(logErr);
    }
    const result = { outcome: 'failed', skipped: false, applied: false, proposed: proposal, error: errorMessage };
    if (logError !== undefined) result.logError = logError;
    return result;
  }
}

module.exports = {
  proposeAdjustment,
  runForAccount,
  SAFETY_LIMITS,
};
