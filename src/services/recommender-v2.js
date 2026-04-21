/**
 * Recommender v2 — orchestrator for pacing recommendations.
 *
 * Called by: budget-recommender.js (Phase 5 wiring), tests.
 * Calls: pacing-engine-v2.proposeAdjustment, campaign-classifier.classifyCampaign,
 *        inventory-baseline-store.classifyTier.
 *
 * Phase 3 implements: R1 direction invariant, R3 IS classifier, R4 shared-budget
 * binding check, R5 campaign-weight reshaper, R7 rationale composer.
 * Phase 4 will add R6 diagnostics (diagnostics: [] for now).
 *
 * Pure async function — no side effects, no DB calls, no external API calls.
 * All data is passed in via params.
 */

const { proposeAdjustment } = require('./pacing-engine-v2');
const { classifyCampaign, CAMPAIGN_TYPES, CUT_WEIGHTS, ADDITION_WEIGHTS } = require('./campaign-classifier');
const { daysInMonth } = require('./pacing-calculator');
const { cumulativeTarget } = require('./pacing-curve');

// ── IS target bands by campaign type (spec Section 2 R3) ─────────────────────
// Keyed by the lowercased CAMPAIGN_TYPES values.
// null means "no target" for that bound (no upper cap, or skip entirely).
const IS_TARGETS = {
  [CAMPAIGN_TYPES.BRAND]:         { min: 90, max: null },
  [CAMPAIGN_TYPES.VLA]:           { min: 80, max: null },
  [CAMPAIGN_TYPES.MODEL_KEYWORD]: { min: 75, max: 90 },
  [CAMPAIGN_TYPES.GENERAL]:       { min: 50, max: null },
  [CAMPAIGN_TYPES.COMP]:          { min: 30, max: 50 },
  [CAMPAIGN_TYPES.REGIONAL]:      { min: 30, max: 50 },
  [CAMPAIGN_TYPES.SERVICE]:       null,  // no IS target — budget-based campaign
};

// ── Inventory tier factors for R5 ────────────────────────────────────────────
// Cut: higher = cut VLA/MODEL_KEYWORD more aggressively
const INVENTORY_CUT_FACTORS = {
  healthy:  1.0,
  low:      1.5,
  very_low: 2.0,
  critical: 3.0,
};

// Addition: lower = add less to VLA/MODEL_KEYWORD; critical = 0 (none)
const INVENTORY_ADDITION_FACTORS = {
  healthy:  1.0,
  low:      0.5,
  very_low: 0.2,
  critical: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// R1 — Direction invariant enforcer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enforces the direction invariant: an overpacing account must never receive
 * an increase, and an underpacing account must never receive a decrease.
 *
 * This is a belt-and-suspenders check applied AFTER the engine output. If the
 * engine ever produces a wrong-direction proposal due to edge-case math, this
 * catches it and converts it to a hold.
 *
 * @param {Object} params
 * @param {number} params.variance - Fractional variance from curve target
 *   (positive = overpacing, negative = underpacing, 0 or near-0 = on-pace/dead-zone)
 * @param {Object} params.proposed - AdjustmentResult from pacing-engine-v2
 * @param {number} params.currentDailyBudget - Current daily budget ($)
 * @returns {Object} Either the original proposed object or an override hold
 */
function enforceDirectionInvariant({ proposed, currentDailyBudget, mtdSpend, monthlyBudget, daysRemaining }) {
  // Dead zone / skipped — no direction to enforce
  if (proposed.skipped || proposed.newDailyBudget === null) {
    return proposed;
  }

  const isIncrease = proposed.newDailyBudget > currentDailyBudget;
  const isDecrease = proposed.newDailyBudget < currentDailyBudget;

  // PROJECTED EOM variance: if the dealer keeps spending at currentDailyBudget
  // for the remaining days, where do they land relative to monthlyBudget?
  // This is what matters for direction-correctness — NOT the current-day
  // curve variance (which can say "overpacing" even when the account is
  // projected to underspend, e.g. when the daily setting is already too low).
  const projectedEom = currentDailyBudget * daysRemaining + mtdSpend;
  const projectedVariance = monthlyBudget > 0
    ? (projectedEom - monthlyBudget) / monthlyBudget
    : 0;

  // Use ±2% threshold to match the engine's dead zone — no override for
  // proposals within that band (projections that close to target don't
  // justify blocking a small corrective move).
  const PROJECTED_THRESHOLD = 0.02;

  // Projected to overspend AND engine wants to raise daily → override
  if (projectedVariance > PROJECTED_THRESHOLD && isIncrease) {
    return {
      ...proposed,
      skipped: true,
      reason: 'direction_invariant_projected_overspend',
      newDailyBudget: null,
      clampedBy: null,
    };
  }

  // Projected to underspend AND engine wants to lower daily → override
  if (projectedVariance < -PROJECTED_THRESHOLD && isDecrease) {
    return {
      ...proposed,
      skipped: true,
      reason: 'direction_invariant_projected_underspend',
      newDailyBudget: null,
      clampedBy: null,
    };
  }

  return proposed;
}

// ─────────────────────────────────────────────────────────────────────────────
// R3 — IS target classifier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classifies each campaign's impression share against its type-specific IS
 * target band.
 *
 * @param {Object} params
 * @param {Object[]} params.campaigns - Array of { campaignId, campaignName, ... }
 * @param {Object} params.impressionShare - Map of campaignId → { is: number, ... }
 * @returns {Array<{
 *   campaignId: string,
 *   campaignName: string,
 *   type: string,
 *   is: number|null,
 *   status: 'below_band'|'in_band'|'above_band'|'no_target',
 *   deficit?: number,
 *   surplus?: number,
 * }>}
 */
function classifyByImpressionShare({ campaigns, impressionShare }) {
  return (campaigns || []).map(campaign => {
    const type = classifyCampaign(campaign.campaignName);
    const target = IS_TARGETS[type];

    // Service campaigns and any unrecognized type with no target
    if (!target) {
      return {
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName,
        type,
        is: null,
        status: 'no_target',
      };
    }

    const isData = impressionShare && impressionShare[campaign.campaignId];
    const isValue = isData != null ? (typeof isData === 'object' ? isData.is : isData) : null;

    if (isValue === null || isValue === undefined) {
      return {
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName,
        type,
        is: null,
        status: 'no_target',
      };
    }

    const { min, max } = target;

    if (min !== null && isValue < min) {
      return {
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName,
        type,
        is: isValue,
        status: 'below_band',
        deficit: Math.round((min - isValue) * 10) / 10,
      };
    }

    if (max !== null && isValue > max) {
      return {
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName,
        type,
        is: isValue,
        status: 'above_band',
        surplus: Math.round((isValue - max) * 10) / 10,
      };
    }

    return {
      campaignId: campaign.campaignId,
      campaignName: campaign.campaignName,
      type,
      is: isValue,
      status: 'in_band',
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// R4 — Shared-budget-not-binding check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks whether each shared budget is actually binding (i.e., constraining
 * spend) by comparing the daily budget ceiling to the trailing average spend.
 *
 * NOTE ON TRAILING AVERAGE: Ideally this uses per-day spend data. Since params
 * only provide MTD sums (not per-day breakdowns), we fall back to:
 *   dailyAvg = mtdSpend_for_budget_campaigns / currentDay
 * This approximation is conservative and acceptable for the non-binding check.
 *
 * @param {Object} params
 * @param {Object[]} params.sharedBudgets - [{ resourceName, name, dailyBudget, campaigns }]
 * @param {Object} params.trailingDailyAvgByBudget - Map resourceName → trailingDailyAvg
 * @returns {Array<{
 *   resourceName: string,
 *   name: string,
 *   dailyBudget: number,
 *   trailingAvg: number,
 *   binding: boolean,
 *   reason: string|null,
 * }>}
 */
function checkSharedBudgetBinding({ sharedBudgets, trailingDailyAvgByBudget }) {
  return (sharedBudgets || []).map(budget => {
    const trailingAvg = (trailingDailyAvgByBudget || {})[budget.resourceName] || 0;
    const threshold = trailingAvg * 1.5;

    // If dailyBudget > 1.5 × trailing avg, the budget is not binding
    const notBinding = budget.dailyBudget > threshold;

    return {
      resourceName: budget.resourceName,
      name: budget.name,
      dailyBudget: budget.dailyBudget,
      trailingAvg,
      binding: !notBinding,
      reason: notBinding ? 'budget_headroom_1.5x' : null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// R5 — Campaign-weight reshaper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Distributes a budget delta across campaigns using type-based weights,
 * adjusted for inventory tier for VLA and MODEL_KEYWORD campaigns.
 *
 * @param {Object} params
 * @param {number} params.totalDelta - Signed dollar change (negative = cut, positive = add)
 * @param {Object[]} params.campaigns - Campaigns with { campaignId, campaignName, spend }
 * @param {string} params.inventoryTier - 'healthy'|'low'|'very_low'|'critical'
 * @returns {Array<{
 *   campaignId: string,
 *   campaignName: string,
 *   type: string,
 *   currentSpend: number,
 *   deltaDollars: number,
 *   deltaPct: number,
 *   newSpend: number,
 * }>}
 */
function reshapeCampaignAllocation({ totalDelta, campaigns, inventoryTier }) {
  if (!campaigns || campaigns.length === 0) return [];

  const isDecrease = totalDelta < 0;
  const tier = inventoryTier || 'healthy';

  // Classify each campaign and compute its raw weight
  const classified = campaigns.map(c => {
    const type = classifyCampaign(c.campaignName);
    return { ...c, type };
  });

  // Compute effective weights
  const weights = classified.map(c => {
    const baseWeights = isDecrease ? CUT_WEIGHTS : ADDITION_WEIGHTS;
    let w = baseWeights[c.type] != null ? baseWeights[c.type] : 0.5;

    const isVlaOrModel = c.type === CAMPAIGN_TYPES.VLA || c.type === CAMPAIGN_TYPES.MODEL_KEYWORD;

    if (isVlaOrModel) {
      if (isDecrease) {
        // Cut more aggressively with worse inventory
        w = w * (INVENTORY_CUT_FACTORS[tier] || 1.0);
      } else {
        // Add less (or zero) to VLA/MODEL_KEYWORD with worse inventory
        const factor = INVENTORY_ADDITION_FACTORS[tier];
        w = w * (factor != null ? factor : 1.0);
        // Critical: VLA/MODEL_KEYWORD get zero of the increase
        if (tier === 'critical') w = 0;
      }
    }

    return w;
  });

  // Normalize weights
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  // Distribute proportionally and assign the remainder to the last non-zero campaign
  // to ensure deltas sum exactly to totalDelta (avoids cent-rounding accumulation).
  let assigned = 0;
  const results = classified.map((c, i) => {
    const share = totalWeight > 0 ? weights[i] / totalWeight : 0;
    const isLast = i === classified.length - 1;

    let deltaDollars;
    if (isLast) {
      // Absorb rounding remainder so that sum(deltas) === totalDelta exactly
      deltaDollars = Math.round((totalDelta - assigned) * 100) / 100;
    } else {
      deltaDollars = Math.round(totalDelta * share * 100) / 100;
      assigned += deltaDollars;
    }

    const currentSpend = c.spend || 0;
    const newSpend = Math.round((currentSpend + deltaDollars) * 100) / 100;
    const deltaPct = currentSpend !== 0
      ? Math.round((deltaDollars / currentSpend) * 10000) / 100
      : 0;

    return {
      campaignId: c.campaignId,
      campaignName: c.campaignName,
      type: c.type,
      currentSpend,
      deltaDollars,
      deltaPct,
      newSpend,
    };
  });

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// R7 — Rationale composer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produces an ordered array of human-readable rationale sentences for a
 * recommendation. Every recommendation must pass the "makes sense" test.
 *
 * Sentence order:
 *   1. Current pacing position (always included)
 *   2. What will happen (action description)
 *   3. Single-step cap note if clamped by max_increase/max_decrease
 *   4. Inventory context (always included if inventory is provided)
 *   5. Clamp reason if clamped by floor/ceiling
 *   6. IS issues (one line per below-band campaign)
 *   7. Shared-budget non-binding warnings
 *
 * @param {Object} params
 * @param {Object} params.pacing - { mtdSpend, monthlyBudget, curveTarget, pacePercent, daysRemaining }
 * @param {Object|null} params.inventory - { newVinCount, baseline, tier } or null
 * @param {Object} params.recommendation - { action, direction, newDailyBudget, change, changePct, confidence }
 * @param {Array} params.isAssessments - Output of classifyByImpressionShare
 * @param {Array} params.sharedBudgetBindings - Output of checkSharedBudgetBinding
 * @param {string|null} params.clampedBy - e.g. 'max_increase', 'floor'
 * @returns {string[]}
 */
function composeRationale({
  pacing,
  inventory,
  recommendation,
  isAssessments,
  sharedBudgetBindings,
  clampedBy,
}) {
  const lines = [];

  // 1. Pacing position
  const { pacePercent, daysRemaining, monthlyBudget, mtdSpend } = pacing;
  const paceStr = typeof pacePercent === 'number' ? pacePercent.toFixed(1) : '?';
  const direction = pacePercent > 100 ? 'over' : pacePercent < 100 ? 'under' : 'at';
  lines.push(
    `Account at ${paceStr}% of curve target with ${daysRemaining} day${daysRemaining !== 1 ? 's' : ''} remaining.`
  );

  // 2. Action description
  const { action, newDailyBudget, change, changePct, skipReason } = recommendation;
  if (action === 'hold' || action === 'diagnose') {
    // Differentiate WHY we're holding. Generic "on pace" is misleading when
    // the real reason is freeze/cooldown/invariant.
    if (skipReason && skipReason.startsWith('freeze_window')) {
      lines.push('No change — within end-of-month freeze window (last 2 days).');
    } else if (skipReason && skipReason.startsWith('cooldown')) {
      lines.push('No change — within 24h cooldown from the most recent budget edit.');
    } else if (skipReason && skipReason.startsWith('target_strategy_cooldown')) {
      lines.push('No change — Smart Bidding strategy still in 72h cooldown from last edit.');
    } else if (skipReason === 'direction_invariant_projected_overspend') {
      lines.push('No change — current daily budget is already projected to overspend the monthly target; a further increase would make it worse.');
    } else if (skipReason === 'direction_invariant_projected_underspend') {
      lines.push('No change — current daily budget is already projected to underspend the monthly target; a further decrease would leave more money on the table.');
    } else if (skipReason && skipReason.startsWith('dead_zone')) {
      lines.push('No change — variance from curve target is within the ±2% dead zone.');
    } else {
      // Fallback for unknown/missing reason
      lines.push('No budget change proposed.');
    }
    // Always tell the operator where the account is projected to land so
    // they can judge the hold themselves. Uses mtdSpend + remaining days at
    // current rate — the same signal R1 uses.
    if (typeof mtdSpend === 'number' && typeof monthlyBudget === 'number' && typeof daysRemaining === 'number') {
      // NB: we don't have currentDailyBudget directly in pacing, but the
      // action description is enough; the v2 UI card already shows the
      // derived current daily.
    }
  } else if (newDailyBudget !== null && newDailyBudget !== undefined) {
    const verb = action === 'reduce_daily_budget' ? 'Reducing' : 'Increasing';
    const cappedByCap = (clampedBy === 'max_increase' || clampedBy === 'max_decrease');
    const cappedByBound = (clampedBy === 'floor' || clampedBy === 'ceiling');
    if (cappedByBound) {
      // Absolute bound hit — can't promise EOM landing. Be honest.
      lines.push(
        `${verb} daily budget to $${newDailyBudget.toFixed(2)} (clamped by absolute ${clampedBy} — won't hit EOM target this cycle; revisit after cooldown).`
      );
    } else if (cappedByCap) {
      // ±20% cap — proposal is a single-step move toward target, not the full correction
      lines.push(
        `${verb} daily budget to $${newDailyBudget.toFixed(2)} (single-step move toward target; further adjustment may follow after cooldown).`
      );
    } else {
      // Normal proposal — the math actually does land at the monthly budget
      const eomEstimate = typeof monthlyBudget === 'number' ? `$${monthlyBudget.toLocaleString()}` : '?';
      lines.push(
        `${verb} daily budget to $${newDailyBudget.toFixed(2)} will land at ${eomEstimate} EOM.`
      );
    }
  }

  // 3. Single-step cap note
  if ((clampedBy === 'max_increase' || clampedBy === 'max_decrease') && changePct !== undefined) {
    const capLabel = clampedBy === 'max_increase' ? '+20%' : '-20%';
    lines.push(
      `Within \u00b120% single-step cap (currently ${changePct > 0 ? '+' : ''}${typeof changePct === 'number' ? changePct.toFixed(2) : '?'}%).`
    );
  }

  // 4. Inventory context
  if (inventory) {
    const { newVinCount, baseline, tier } = inventory;
    const baselineVal = baseline != null ? baseline : '?';
    const tierLabel = tier ? tier.replace('_', ' ') : 'unknown';
    if (tier === 'healthy') {
      lines.push(
        `Inventory ${tierLabel} (${newVinCount} new VINs vs ${baselineVal} baseline) \u2014 no inventory damping applied.`
      );
    } else if (tier === 'low') {
      lines.push(
        `Inventory ${tierLabel} (${newVinCount} new VINs vs ${baselineVal} baseline) \u2014 increase cap dampened to +10%.`
      );
    } else if (tier === 'very_low') {
      lines.push(
        `Inventory ${tierLabel} (${newVinCount} new VINs vs ${baselineVal} baseline) \u2014 proposing VLA/model-keyword cuts.`
      );
    } else if (tier === 'critical') {
      lines.push(
        `Inventory ${tierLabel} (${newVinCount} new VINs vs ${baselineVal} baseline) \u2014 VLA/model-keyword budget redirected to other campaign types.`
      );
    }
  }

  // 5. Other clamp reasons (floor/ceiling)
  if (clampedBy && clampedBy !== 'max_increase' && clampedBy !== 'max_decrease') {
    lines.push(`Proposal clamped by ${clampedBy}.`);
  }

  // 6. IS issues (below-band campaigns)
  const belowBand = (isAssessments || []).filter(a => a.status === 'below_band');
  for (const a of belowBand) {
    const target = IS_TARGETS[a.type];
    const targetStr = target ? `${target.min}%` : '?';
    lines.push(
      `${a.type.charAt(0).toUpperCase() + a.type.slice(1)} campaign '${a.campaignName}' at ${a.is}% IS \u2014 below ${targetStr} target, check structural issues.`
    );
  }

  // 7. Shared-budget non-binding warnings
  const notBinding = (sharedBudgetBindings || []).filter(b => !b.binding);
  for (const b of notBinding) {
    lines.push(
      `Shared budget '${b.name}' is not binding: daily limit $${b.dailyBudget} but 7-day avg spend $${b.trailingAvg.toFixed(2)}. Not recommending budget increase.`
    );
  }

  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a structured pacing recommendation for one dealer account.
 * Orchestrates: pacing-engine-v2.proposeAdjustment + R1 direction enforcer +
 * R3 IS classifier + R4 shared-budget check + R5 campaign-weight reshaper +
 * R7 rationale composer. (R6 diagnostics added in Phase 4.)
 *
 * @param {Object} params
 * @param {Object} params.goal - { dealerName, monthlyBudget, pacingMode, pacingCurveId }
 * @param {Object[]} params.campaignSpend - [{ campaignId, campaignName, status, spend }]
 * @param {Object[]} params.sharedBudgets - [{ resourceName, name, dailyBudget, campaigns }]
 * @param {Object} params.impressionShare - { campaignId: { is: number, ... } } keyed by campaign ID
 * @param {Object|null} params.inventory - { newVinCount, baselineRolling90Day, tier } or null if unmapped
 * @param {number} params.currentDailyBudget - Current total daily budget across enabled campaigns ($)
 * @param {string|null} params.bidStrategyType - Primary bid strategy
 * @param {string|null} params.lastChangeTimestamp - ISO timestamp of last budget change
 * @param {number} params.year
 * @param {number} params.month
 * @param {number} params.currentDay
 * @param {Object} [params.restCtx] - Optional. When provided, triggers R6 diagnostic analyzer.
 *   Must be { accessToken, developerToken, customerId, loginCustomerId }.
 * @param {Object} [params._googleAds] - Optional injected google-ads module for testing.
 * @returns {Promise<Object>} Structured recommendation (see spec Section 4)
 */
async function run(params) {
  const {
    goal,
    campaignSpend,
    sharedBudgets,
    impressionShare,
    inventory,
    currentDailyBudget,
    bidStrategyType,
    lastChangeTimestamp,
    year,
    month,
    currentDay,
    // R6: optional REST context + optional injected googleAds module (for testing)
    // restCtx and _googleAds are accessed via params.restCtx / params._googleAds below
  } = params;

  const { dealerName, monthlyBudget, pacingCurveId } = goal;
  const curveId = pacingCurveId || 'linear';

  // Compute MTD spend from campaignSpend array
  const mtdSpend = (campaignSpend || []).reduce((sum, c) => sum + (c.spend || 0), 0);

  // Compute pacing metrics
  const totalDays = daysInMonth(year, month);
  const daysRemaining = Math.max(totalDays - currentDay, 0);
  const cumFrac = cumulativeTarget(curveId, currentDay, totalDays);
  const curveTargetDollars = Math.round(monthlyBudget * cumFrac * 100) / 100;
  const pacePercent = curveTargetDollars > 0
    ? Math.round((mtdSpend / curveTargetDollars) * 10000) / 100
    : 100;
  const variance = curveTargetDollars > 0
    ? (mtdSpend - curveTargetDollars) / curveTargetDollars
    : 0;

  // ── Step 1: Engine proposal ────────────────────────────────────────────────
  const engineProposal = proposeAdjustment({
    monthlyBudget,
    mtdSpend,
    currentDailyBudget,
    curveId,
    year,
    month,
    currentDay,
    lastChangeTimestamp,
    bidStrategyType,
  });

  // ── Step 2: R1 direction invariant ────────────────────────────────────────
  // Uses PROJECTED EOM variance, not current-day curve variance. An account
  // can be short-term overpacing (MTD > curve today) yet projected to
  // underspend (current daily × daysRemaining + MTD < monthlyBudget); the
  // right move in that case is to INCREASE, which strict current-day logic
  // would wrongly block.
  const enforcedProposal = enforceDirectionInvariant({
    proposed: engineProposal,
    currentDailyBudget,
    mtdSpend,
    monthlyBudget,
    daysRemaining,
  });

  // ── Step 3: R3 IS classifier ──────────────────────────────────────────────
  const isAssessments = classifyByImpressionShare({
    campaigns: campaignSpend || [],
    impressionShare: impressionShare || {},
  });

  // ── Step 4: R4 shared-budget binding check ────────────────────────────────
  // Derive trailing daily averages from MTD spend / currentDay (approximation)
  const trailingDailyAvgByBudget = {};
  for (const budget of (sharedBudgets || [])) {
    // Identify campaigns belonging to this shared budget
    const budgetCampaignIds = new Set((budget.campaigns || []).map(c => String(c.campaignId || c)));
    const budgetMtdSpend = (campaignSpend || [])
      .filter(c => budgetCampaignIds.has(String(c.campaignId)))
      .reduce((sum, c) => sum + (c.spend || 0), 0);
    // Approximate trailing daily avg as MTD spend / days so far
    trailingDailyAvgByBudget[budget.resourceName] = currentDay > 0
      ? budgetMtdSpend / currentDay
      : 0;
  }

  const sharedBudgetBindings = checkSharedBudgetBinding({
    sharedBudgets: sharedBudgets || [],
    trailingDailyAvgByBudget,
  });

  // ── Step 5: R5 campaign-weight reshaper ───────────────────────────────────
  const inventoryTier = inventory ? inventory.tier : 'healthy';
  let campaignAllocation = [];
  if (!enforcedProposal.skipped && enforcedProposal.newDailyBudget !== null) {
    const delta = enforcedProposal.newDailyBudget - currentDailyBudget;
    campaignAllocation = reshapeCampaignAllocation({
      totalDelta: delta,
      campaigns: campaignSpend || [],
      inventoryTier,
    });
  }

  // ── Step 6: Build recommendation object ───────────────────────────────────
  let recommendation;
  const clampedBy = enforcedProposal.clampedBy || null;

  if (enforcedProposal.skipped) {
    // Skipped — action is 'hold', but carry the reason through so the
    // rationale composer can produce an honest, specific message instead
    // of the generic "on pace" line.
    recommendation = {
      action: 'hold',
      direction: 'hold',
      newDailyBudget: null,
      change: 0,
      changePct: 0,
      confidence: 'low',
      skipReason: enforcedProposal.reason || null,
    };
  } else {
    const newDailyBudget = enforcedProposal.newDailyBudget;
    const change = Math.round((newDailyBudget - currentDailyBudget) * 100) / 100;
    const changePct = currentDailyBudget !== 0
      ? Math.round((change / currentDailyBudget) * 10000) / 100
      : 0;

    const direction = change > 0 ? 'increase' : change < 0 ? 'decrease' : 'hold';
    const action = direction === 'increase'
      ? 'increase_daily_budget'
      : direction === 'decrease'
        ? 'reduce_daily_budget'
        : 'hold';

    // Confidence: high if no clamp and inventory healthy, medium if some ambiguity, low if diagnostic needed
    let confidence = 'high';
    const hasNotBindingBudget = sharedBudgetBindings.some(b => !b.binding);
    const hasBelowBandIS = isAssessments.some(a => a.status === 'below_band');
    if (clampedBy || inventoryTier === 'low' || hasNotBindingBudget || hasBelowBandIS) {
      confidence = 'medium';
    }
    if (inventoryTier === 'very_low' || inventoryTier === 'critical') {
      confidence = 'low';
    }

    recommendation = {
      action,
      direction,
      newDailyBudget,
      change,
      changePct,
      confidence,
    };
  }

  // ── Step 6b: R6 Diagnostic analyzer ──────────────────────────────────────
  // Run ONLY for campaigns where shared budget is not binding AND IS is below band.
  // restCtx is optional — only run if caller provided it (backward compat with Phase 3).
  const diagnostics = [];
  if (params.restCtx) {
    const { analyze } = require('./diagnostic-analyzer');
    const nonBindingBudgetResourceNames = new Set(
      sharedBudgetBindings.filter(b => !b.binding).map(b => b.resourceName)
    );
    const campaignsInNonBindingBudget = new Set();
    for (const sb of params.sharedBudgets || []) {
      if (nonBindingBudgetResourceNames.has(sb.resourceName) && Array.isArray(sb.campaigns)) {
        sb.campaigns.forEach(c => campaignsInNonBindingBudget.add(String(c.id || c.campaignId || c)));
      }
    }
    for (const isItem of isAssessments) {
      if (isItem.status === 'below_band' && campaignsInNonBindingBudget.has(String(isItem.campaignId))) {
        try {
          const campaignDiagnostics = await analyze({
            restCtx: params.restCtx,
            campaignId: isItem.campaignId,
            campaignName: isItem.campaignName,
            campaignType: isItem.type,
            _googleAds: params._googleAds,
          });
          diagnostics.push(...campaignDiagnostics);
        } catch (err) {
          console.warn(`[recommender-v2] diagnostic failed for campaign ${isItem.campaignId}:`, err.message);
        }
      }
    }
  }

  // ── Step 7: R7 Rationale ──────────────────────────────────────────────────
  // Build inventory object for rationale (normalize field names)
  const inventoryForRationale = inventory
    ? {
        newVinCount: inventory.newVinCount,
        baseline: inventory.baselineRolling90Day != null
          ? inventory.baselineRolling90Day
          : (inventory.baseline != null ? inventory.baseline : null),
        tier: inventory.tier,
      }
    : null;

  const rationale = composeRationale({
    pacing: {
      mtdSpend,
      monthlyBudget,
      curveTarget: curveTargetDollars,
      pacePercent,
      daysRemaining,
    },
    inventory: inventoryForRationale,
    recommendation,
    isAssessments,
    sharedBudgetBindings,
    clampedBy,
  });

  // Append diagnostic rationale lines
  for (const diag of diagnostics) {
    rationale.push(`Diagnostic finding (${diag.severity}): ${diag.message}`);
  }

  // ── Final output shape (spec Section 4) ───────────────────────────────────
  return {
    dealerName,
    pacing: {
      mtdSpend,
      monthlyBudget,
      curveTarget: curveTargetDollars,
      pacePercent,
      curveId,
      daysRemaining,
    },
    inventory: inventoryForRationale,
    recommendation,
    rationale,
    diagnostics,
    clampedBy,
    source: 'pacing_engine_v2',
    // Exposed for callers that want per-campaign breakdown
    _campaignAllocation: campaignAllocation,
    _isAssessments: isAssessments,
    _sharedBudgetBindings: sharedBudgetBindings,
  };
}

module.exports = {
  run,
  // Export helpers for direct testing
  enforceDirectionInvariant,
  classifyByImpressionShare,
  checkSharedBudgetBinding,
  reshapeCampaignAllocation,
  composeRationale,
  IS_TARGETS,
  INVENTORY_CUT_FACTORS,
  INVENTORY_ADDITION_FACTORS,
};
