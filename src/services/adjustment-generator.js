/**
 * Adjustment Generator — produces executable budget adjustments using
 * inventory-weighted proportional priority logic.
 *
 * Called by: routes/budget-adjustments.js (Phase 2)
 * Uses: campaign-classifier.js for type detection and weight computation
 *       budget-recommender.js for underlying recommendation math
 *
 * Core algorithm:
 *   1. Classify each campaign/budget by type (VLA, brand, service, etc.)
 *   2. Extract model names and compute inventory shares
 *   3. Compute effective weight per campaign (base weight × inventory multiplier)
 *   4. Distribute the needed budget change proportionally by weighted share
 *   5. Package into executor-ready format with unique IDs
 */

const crypto = require('crypto');
const {
  CAMPAIGN_TYPES,
  classifyCampaign,
  extractModel,
  computeInventoryShares,
  getEffectiveWeight,
} = require('./campaign-classifier');
const { BUDGET_SPLITS } = require('./strategy-rules');

/**
 * Generates executable budget adjustments for a single account.
 *
 * Takes the raw budget data (dedicated + shared budgets with current spend)
 * and produces a set of changes that, when applied, would bring the account
 * back on pace with its monthly budget target.
 *
 * @param {Object} params
 * @param {string} params.customerId - Google Ads customer ID
 * @param {string} params.dealerName - Dealer name
 * @param {Object} params.pacing - From calculatePacing()
 * @param {Object[]} params.dedicatedBudgets - From getDedicatedBudgets()
 * @param {Object[]} params.sharedBudgets - From getSharedBudgets()
 * @param {Object[]} params.campaignSpend - From getMonthSpend()
 * @param {Object[]} params.impressionShareData - From getImpressionShare()
 * @param {Object} params.inventoryByModel - Map of model → count (e.g., { civic: 40 })
 * @param {Map} [params.spendMap] - Campaign ID → daily spend map
 * @param {string} params.direction - 'over' or 'under'
 * @returns {Object} { adjustmentId, adjustments[], summary }
 */
function generateExecutableAdjustments(params) {
  const {
    customerId,
    dealerName,
    pacing,
    dedicatedBudgets = [],
    sharedBudgets = [],
    campaignSpend = [],
    impressionShareData = [],
    inventoryByModel = {},
    spendMap,
    direction,
  } = params;

  const adjustmentId = generateAdjustmentId();
  const now = new Date();

  // No adjustment possible at end of month
  if (pacing.daysRemaining === 0) {
    return { adjustmentId, adjustments: [], summary: null };
  }

  // Compute inventory shares
  const inventoryShares = computeInventoryShares(inventoryByModel);

  // Build impression share lookup
  const isMap = new Map();
  (impressionShareData || []).forEach(d => isMap.set(d.campaignId, d));

  // Build spend map from campaign spend if not provided
  const dailySpendMap = spendMap || buildDailySpendMap(campaignSpend, pacing.daysElapsed || 1);

  // Required daily rate to finish the month on target
  const requiredDailyRate = pacing.daysRemaining > 0
    ? pacing.remainingBudget / pacing.daysRemaining
    : 0;

  // Calculate total daily change needed FIRST to derive true direction.
  // The detector's direction can disagree with the math when pace variance
  // and projected miss diverge — the math is authoritative.
  // Note: isAddition=false here is arbitrary; only currentDailySpend is extracted
  // and that doesn't depend on the weight direction.
  const currentDailyTotal = (() => {
    const tempClassified = classifyAllBudgets(
      dedicatedBudgets, sharedBudgets, dailySpendMap, inventoryShares, false
    );
    return tempClassified.reduce((s, b) => s + b.currentDailySpend, 0);
  })();
  const totalChangeNeeded = requiredDailyRate - currentDailyTotal;

  // No change needed — short-circuit
  if (Math.abs(totalChangeNeeded) < 1) {
    return { adjustmentId, customerId, dealerName, generatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      direction: direction || 'under', adjustments: [], summary: null };
  }

  // Derive direction from actual change needed, not detector input
  const actualDirection = totalChangeNeeded > 0 ? 'under' : 'over';
  const isAddition = actualDirection === 'under';

  // Classify all budgets with correct direction for weight computation
  const classifiedBudgets = classifyAllBudgets(
    dedicatedBudgets, sharedBudgets, dailySpendMap, inventoryShares, isAddition
  );

  // Distribute the change proportionally by weighted share
  const adjustments = distributeByWeight(classifiedBudgets, totalChangeNeeded, isAddition, isMap, requiredDailyRate);

  // Filter out negligible changes (< $1)
  const significantAdjustments = adjustments.filter(a => Math.abs(a.change) >= 1);

  // Build summary
  const summary = {
    requiredDailyRate: Math.round(requiredDailyRate * 100) / 100,
    currentDailyTotal: Math.round(currentDailyTotal * 100) / 100,
    totalChangeNeeded: Math.round(totalChangeNeeded * 100) / 100,
    adjustmentCount: significantAdjustments.length,
    direction: actualDirection,
  };

  return {
    adjustmentId,
    customerId,
    dealerName,
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    direction: actualDirection,
    adjustments: significantAdjustments,
    summary,
  };
}

/**
 * Classifies all dedicated and shared budgets with their effective weights.
 */
function classifyAllBudgets(dedicatedBudgets, sharedBudgets, spendMap, inventoryShares, isAddition) {
  const classified = [];

  // Dedicated budgets (VLAs and standalone campaigns)
  for (const budget of dedicatedBudgets) {
    const campaignType = classifyCampaign(budget.campaignName, budget.channelType);
    const model = extractModel(budget.campaignName);
    const weight = getEffectiveWeight(campaignType, model, inventoryShares, isAddition);
    const currentDailySpend = spendMap.get(String(budget.campaignId)) || budget.dailyBudget || 0;

    classified.push({
      budgetType: 'campaign_budget',
      resourceName: budget.resourceName,
      target: budget.campaignName,
      campaignType,
      model,
      weight,
      currentDailySpend,
      currentBudgetSetting: budget.dailyBudget || 0,
      isShared: false,
      campaigns: budget.campaigns || [{ campaignId: budget.campaignId, campaignName: budget.campaignName }],
    });
  }

  // Shared budgets
  for (const budget of sharedBudgets) {
    // Classify shared budget by its highest-priority campaign
    const campaigns = budget.campaigns || [];
    let bestType = CAMPAIGN_TYPES.GENERAL;
    let bestModel = null;
    for (const c of campaigns) {
      const type = classifyCampaign(c.campaignName);
      const model = extractModel(c.campaignName);
      // Use the highest-priority (lowest cut weight) campaign type for the budget
      if (type === CAMPAIGN_TYPES.VLA || type === CAMPAIGN_TYPES.BRAND) {
        bestType = type;
        if (model) bestModel = model;
      } else if (bestType !== CAMPAIGN_TYPES.VLA && bestType !== CAMPAIGN_TYPES.BRAND) {
        bestType = type;
        if (model) bestModel = model;
      }
    }

    const weight = getEffectiveWeight(bestType, bestModel, inventoryShares, isAddition);
    // Sum actual spend of all campaigns under this shared budget
    let currentDailySpend = 0;
    for (const c of campaigns) {
      const campSpend = spendMap.get(String(c.campaignId));
      if (campSpend != null) currentDailySpend += campSpend;
    }
    // Fall back to budget setting if no spend data for any campaign
    if (currentDailySpend === 0) currentDailySpend = budget.dailyBudget || 0;

    classified.push({
      budgetType: 'shared_budget',
      resourceName: budget.resourceName,
      target: budget.name,
      campaignType: bestType,
      model: bestModel,
      weight,
      currentDailySpend,
      currentBudgetSetting: budget.dailyBudget || 0,
      isShared: true,
      campaigns,
    });
  }

  return classified;
}

/**
 * Distributes the total change proportionally by weighted share.
 *
 * Each budget gets:
 *   share = (currentSpend × weight) / totalWeightedSpend
 *   change = totalChange × share
 *
 * @param {Object[]} classified - Classified budgets with weights
 * @param {number} totalChangeNeeded - Total daily $ change (positive = need more, negative = need less)
 * @param {boolean} isAddition - true = under-pacing (adding budget)
 * @param {Map} isMap - Impression share lookup
 * @returns {Object[]} Adjustment objects ready for executor
 */
function distributeByWeight(classified, totalChangeNeeded, isAddition, isMap, requiredDailyRate) {
  if (classified.length === 0 || Math.abs(totalChangeNeeded) < 1) return [];

  // Compute weighted shares
  const totalWeightedSpend = classified.reduce((sum, b) => {
    return sum + Math.max(b.currentDailySpend, 1) * b.weight;
  }, 0);

  if (totalWeightedSpend === 0) return [];

  // VLA minimum floor: 40% of required daily rate per strategy-rules.js BUDGET_SPLITS
  // Guard: floor total must not exceed requiredDailyRate (small accounts near month-end)
  const vlaBudgets = classified.filter(b => b.campaignType === CAMPAIGN_TYPES.VLA);
  const rawVlaFloor = (requiredDailyRate || 0) * (BUDGET_SPLITS.vla.min || 0.40);
  const vlaMinFloor = Math.min(rawVlaFloor, (requiredDailyRate || 0) * 0.70); // cap at 70% of target
  const vlaFloorPerBudget = vlaBudgets.length > 0 ? vlaMinFloor / vlaBudgets.length : 0;

  // Max increase cap: 2x current budget per cycle (prevents absurd single-change spikes)
  const MAX_INCREASE_MULTIPLIER = 2.0;
  // Max cut: 30% of current budget per cycle (per strategy-rules budget-manager)
  const MAX_CUT_RATIO = 0.30;

  return classified.map(budget => {
    const weightedSpend = Math.max(budget.currentDailySpend, 1) * budget.weight;
    const share = weightedSpend / totalWeightedSpend;
    const rawChange = totalChangeNeeded * share;

    // Calculate new budget
    let newDailyBudget = budget.currentBudgetSetting + rawChange;

    const isVla = budget.campaignType === CAMPAIGN_TYPES.VLA;

    if (isAddition) {
      // Under-pacing: cap increase at 2x current budget per cycle
      const base = Math.max(budget.currentBudgetSetting, budget.currentDailySpend);
      const maxBudget = base * MAX_INCREASE_MULTIPLIER;
      newDailyBudget = Math.min(newDailyBudget, Math.max(maxBudget, base + 1));
    } else {
      // Over-pacing: cap cut at 30% of the LOWER of spend and budget setting.
      // Using the higher would push recommendations UP when budget setting >> actual spend.
      const base = Math.min(budget.currentDailySpend, budget.currentBudgetSetting);
      const minAfterCut = base > 0 ? base * (1 - MAX_CUT_RATIO) : 0;
      newDailyBudget = Math.max(newDailyBudget, minAfterCut);
    }

    // VLA floor: don't cut VLAs below their share of 40% allocation.
    // But if already below the floor, don't force UP while over-pacing.
    if (isVla) {
      const effectiveFloor = isAddition
        ? vlaFloorPerBudget  // under-pacing: push toward 40% target
        : Math.min(vlaFloorPerBudget, budget.currentBudgetSetting);  // over-pacing: don't cut below floor or force up
      newDailyBudget = Math.max(newDailyBudget, effectiveFloor);
    }

    // General floor: never below $1/day
    newDailyBudget = Math.max(newDailyBudget, 1);

    // Round to cents
    newDailyBudget = Math.round(newDailyBudget * 100) / 100;

    const change = Math.round((newDailyBudget - budget.currentBudgetSetting) * 100) / 100;

    // Build reason string
    const reason = buildReason(budget, change, isAddition, isMap);

    return {
      type: budget.budgetType,
      target: budget.target,
      resourceName: budget.resourceName,
      campaignType: budget.campaignType,
      model: budget.model,
      isShared: budget.isShared,
      currentDailyBudget: Math.round(budget.currentBudgetSetting * 100) / 100,
      currentDailySpend: Math.round(budget.currentDailySpend * 100) / 100,
      recommendedDailyBudget: newDailyBudget,
      change,
      weight: Math.round(budget.weight * 1000) / 1000,
      reason,
      affectedCampaigns: budget.campaigns.map(c => c.campaignName),
    };
  });
}

/**
 * Builds a human-readable reason string for an adjustment.
 */
function buildReason(budget, change, isAddition, isMap) {
  const typeLabel = budget.campaignType.replace(/_/g, ' ');
  const direction = change >= 0 ? 'Increase' : 'Decrease';
  const invLabel = budget.model ? ` (${budget.model})` : '';

  let reason = `${direction} ${typeLabel}${invLabel}`;

  // Add IS context if available
  if (budget.campaigns && budget.campaigns.length > 0) {
    const campId = String(budget.campaigns[0].campaignId);
    const isData = isMap.get(campId);
    if (isData?.impressionShare != null) {
      reason += ` — IS: ${(isData.impressionShare * 100).toFixed(1)}%`;
      if (isData.budgetLostShare != null && isData.budgetLostShare > 0.05) {
        reason += `, ${(isData.budgetLostShare * 100).toFixed(1)}% lost to budget`;
      }
    }
  }

  return reason;
}

/**
 * Builds a daily spend map from monthly campaign spend data.
 */
function buildDailySpendMap(campaignSpend, daysElapsed) {
  const map = new Map();
  for (const c of (campaignSpend || [])) {
    map.set(String(c.campaignId), c.spend / Math.max(daysElapsed, 1));
  }
  return map;
}

/**
 * Generates a unique adjustment ID.
 */
function generateAdjustmentId() {
  return `adj-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

module.exports = {
  generateExecutableAdjustments,
  classifyAllBudgets,
  distributeByWeight,
  buildDailySpendMap,
  generateAdjustmentId,
};
