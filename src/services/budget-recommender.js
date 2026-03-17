/**
 * Budget Recommender — generates budget adjustment recommendations
 * for dealer accounts based on account-level pacing.
 *
 * Called by: routes/pacing.js
 * Calls: services/pacing-calculator.js
 *
 * Core principle: the ENTIRE ACCOUNT must pace at 100%. Individual budget
 * pacing doesn't matter — what matters is that VLA daily budgets + shared
 * daily budgets = the required daily rate to finish the month on target.
 *
 * VLAs are priority campaigns. Their budgets are set by impression share
 * targets (75-90%). Shared budgets get whatever's left to hit the account target.
 */

const { calculatePacing } = require('./pacing-calculator');

// VLA impression share targets — below 75% we're leaving money on the table,
// above 90% CPC inflates with diminishing returns.
const VLA_IS_TARGET = { min: 0.75, max: 0.90 };

/**
 * Maps pacing status to dashboard color.
 */
function statusToColor(status) {
  switch (status) {
    case 'on_pace':        return 'green';
    case 'over':
    case 'under':          return 'yellow';
    case 'critical_over':
    case 'critical_under': return 'red';
    default:               return 'gray';
  }
}

/**
 * Checks if a campaign is a VLA (Vehicle Listing Ad) campaign.
 * Matches by name pattern or Google Ads channel type.
 */
function isVlaCampaign(campaign) {
  const name = (campaign.campaignName || '').toLowerCase();
  const type = (campaign.channelType || '').toUpperCase();
  return name.includes('vla') || type === 'SHOPPING' || type === 'LOCAL';
}

/**
 * Summarizes impression share data across campaigns.
 */
function summarizeImpressionShare(impressionShareData) {
  if (!impressionShareData || impressionShareData.length === 0) {
    return { avgImpressionShare: null, avgBudgetLostShare: null, limitedCampaigns: [] };
  }

  const validIS = impressionShareData.filter(d => d.impressionShare != null);
  const validBLS = impressionShareData.filter(d => d.budgetLostShare != null);

  const avgImpressionShare = validIS.length > 0
    ? validIS.reduce((sum, d) => sum + d.impressionShare, 0) / validIS.length
    : null;

  const avgBudgetLostShare = validBLS.length > 0
    ? validBLS.reduce((sum, d) => sum + d.budgetLostShare, 0) / validBLS.length
    : null;

  const limitedCampaigns = impressionShareData
    .filter(d => d.budgetLostShare != null && d.budgetLostShare > 0.10)
    .map(d => d.campaignName);

  return { avgImpressionShare, avgBudgetLostShare, limitedCampaigns };
}

/**
 * Builds a lookup map of campaign spend per day (spend / daysElapsed).
 * @param {Object[]} campaignSpend - From getMonthSpend
 * @param {number} daysElapsed - Days elapsed in the month
 * @returns {Map<string, number>} campaignId → daily spend rate
 */
function buildSpendMap(campaignSpend, daysElapsed) {
  const map = new Map();
  if (!campaignSpend || daysElapsed <= 0) return map;
  for (const c of campaignSpend) {
    map.set(String(c.campaignId), (c.spend || 0) / daysElapsed);
  }
  return map;
}

/**
 * Calculates actual daily spend for a budget by summing linked campaign spend.
 * Falls back to dailyBudget setting if no spend data is available.
 * @param {Object} budget - Budget with campaigns array and dailyBudget
 * @param {Map<string, number>} spendMap - campaignId → daily spend rate
 * @returns {number} Actual daily spend rate (or budget setting as fallback)
 */
function actualDailySpend(budget, spendMap) {
  if (spendMap.size === 0) {
    // No spend data available — fall back to budget setting
    return budget.dailyBudget || 0;
  }
  const campaigns = budget.campaigns || [];
  if (campaigns.length === 0 && budget.campaignId) {
    // Dedicated budget with single campaignId (legacy shape)
    const spend = spendMap.get(String(budget.campaignId));
    return spend != null ? spend : (budget.dailyBudget || 0);
  }
  if (campaigns.length === 0) {
    // Shared budget with no linked campaigns — fall back to budget setting
    return budget.dailyBudget || 0;
  }
  const totalSpend = campaigns.reduce((sum, c) => sum + (spendMap.get(String(c.campaignId)) || 0), 0);
  // If none of the linked campaigns had spend data, fall back to budget setting
  return totalSpend > 0 ? totalSpend : (budget.dailyBudget || 0);
}

/**
 * Distributes the account's required daily rate across VLA and shared budgets.
 *
 * Uses ACTUAL SPEND RATES (not budget settings) as the baseline. A campaign
 * with a $200/day budget that only spends $50/day shows $50/day as current.
 *
 * Algorithm:
 * 1. Calculate account-level required daily rate (remainingBudget / daysRemaining)
 * 2. Compute actual daily spend per budget from campaign spend data
 * 3. Subtract non-VLA dedicated campaign spend (not being adjusted)
 * 4. Set VLA budgets based on impression share targets (priority)
 * 5. Distribute remainder to shared budgets proportionally
 *
 * @param {Object} params
 * @param {Object} params.pacing - Output from calculatePacing
 * @param {Object[]} [params.dedicatedBudgets] - From getDedicatedBudgets
 * @param {Object[]} [params.sharedBudgets] - From getSharedBudgets
 * @param {Object[]} [params.impressionShareData] - From getImpressionShare
 * @param {Object[]} [params.campaignSpend] - From getMonthSpend
 * @returns {Object} { recommendations, budgetSummary }
 */
function distributeAccountBudget({ pacing, dedicatedBudgets, sharedBudgets, impressionShareData, campaignSpend }) {
  if (pacing.daysRemaining === 0) {
    return { recommendations: [], budgetSummary: null };
  }

  const requiredDailyRate = pacing.remainingBudget / pacing.daysRemaining;
  const daysElapsed = pacing.daysElapsed || 1;
  const spendMap = buildSpendMap(campaignSpend, daysElapsed);

  // Separate VLA vs non-VLA dedicated campaigns
  const allDedicated = dedicatedBudgets || [];
  const vlaCampaigns = allDedicated.filter(isVlaCampaign);
  const nonVlaDedicated = allDedicated.filter(c => !isVlaCampaign(c));
  const nonVlaDedicatedSpend = nonVlaDedicated.reduce((s, c) => s + actualDailySpend(c, spendMap), 0);

  // Budget available for VLA + shared (subtract non-VLA dedicated which we don't adjust)
  const targetForAdjustable = Math.max(requiredDailyRate - nonVlaDedicatedSpend, 0);

  const currentVlaSpend = vlaCampaigns.reduce((s, c) => s + actualDailySpend(c, spendMap), 0);
  const budgets = sharedBudgets || [];
  const currentSharedSpend = budgets.reduce((s, b) => s + actualDailySpend(b, spendMap), 0);
  const currentAdjustableSpend = currentVlaSpend + currentSharedSpend;

  // Over-pacing: current actual spend exceeds the target.
  // ALL budgets must decrease proportionally — no increases allowed.
  const accountOverPacing = targetForAdjustable < currentAdjustableSpend;

  // Proportional ratio to scale all budgets when over-pacing
  const overPacingRatio = (accountOverPacing && currentAdjustableSpend > 0)
    ? targetForAdjustable / currentAdjustableSpend
    : 1;

  // Build impression share lookup
  const isMap = new Map();
  (impressionShareData || []).forEach(d => isMap.set(d.campaignId, d));

  // --- Step 1: VLA budgets ---
  // Over-pacing: proportional decrease (same as shared). IS > 90% can decrease further.
  // Under-pacing: IS-driven allocation (priority), shared gets remainder.
  const vlaAllocations = vlaCampaigns.map(campaign => {
    const campIS = isMap.get(campaign.campaignId);
    const is = campIS?.impressionShare;
    const bls = campIS?.budgetLostShare;
    const currentSpend = actualDailySpend(campaign, spendMap);

    let recommended;
    let reason;

    if (accountOverPacing) {
      // All budgets decrease proportionally to hit the target
      recommended = currentSpend * overPacingRatio;
      reason = `Account over-pacing — decrease to hit $${requiredDailyRate.toFixed(2)}/day target`;

      // If IS > 90%, the IS reduction might be even steeper — use lower value
      if (is != null && is > VLA_IS_TARGET.max) {
        const isReduced = currentSpend * (VLA_IS_TARGET.max / is);
        if (isReduced < recommended) {
          recommended = isReduced;
          reason = `IS ${(is * 100).toFixed(1)}% exceeds 90% — reduce to avoid CPC inflation`;
        }
      }
      // Note IS issue even though we can't boost
      if (is != null && is < VLA_IS_TARGET.min) {
        reason += ` (IS ${(is * 100).toFixed(1)}% below 75% target`
          + (bls != null && bls > 0.05 ? `, ${(bls * 100).toFixed(1)}% lost to budget` : '')
          + `)`;
      }
    } else {
      // Under-pacing: IS-driven allocation
      recommended = currentSpend;
      if (is != null && is < VLA_IS_TARGET.min) {
        const boost = Math.min(VLA_IS_TARGET.min / Math.max(is, 0.01), 2.0);
        recommended = currentSpend * boost;
        reason = `IS ${(is * 100).toFixed(1)}% below 75% target`
          + (bls != null && bls > 0.05 ? ` (${(bls * 100).toFixed(1)}% lost to budget)` : '')
          + ` — increase to capture more VLA traffic`;
      } else if (is != null && is > VLA_IS_TARGET.max) {
        const scale = VLA_IS_TARGET.max / is;
        recommended = currentSpend * scale;
        reason = `IS ${(is * 100).toFixed(1)}% exceeds 90% — reduce to avoid CPC inflation`;
      } else if (is != null) {
        reason = `IS ${(is * 100).toFixed(1)}% on target (75-90%)`;
      } else {
        reason = null;
      }
      recommended = Math.max(recommended, 1);
    }

    recommended = Math.max(recommended, 0.01);
    recommended = Math.round(recommended * 100) / 100;

    return { campaign, recommended, reason, currentSpend };
  });

  const totalVlaRecommended = vlaAllocations.reduce((s, v) => s + v.recommended, 0);

  // --- Step 2: Shared budgets ---
  // Over-pacing: proportional decrease (same ratio as VLAs).
  // Under-pacing: get whatever's left after VLA allocation.
  const remainingForShared = accountOverPacing
    ? null  // not used — shared also uses proportional ratio
    : Math.max(targetForAdjustable - totalVlaRecommended, 0);

  // Build final recommendations
  const recommendations = [];

  // VLA recs
  vlaAllocations.forEach(v => {
    if (!v.reason) return;
    const change = Math.round((v.recommended - v.currentSpend) * 100) / 100;
    if (Math.abs(change) < 0.01) return;

    recommendations.push({
      type: 'campaign_budget',
      target: v.campaign.campaignName,
      resourceName: v.campaign.resourceName,
      currentDailyBudget: Math.round(v.currentSpend * 100) / 100,
      recommendedDailyBudget: v.recommended,
      change,
      reason: v.reason,
      isVla: true,
    });
  });

  // Shared budget recs
  let recommendedSharedTotal = 0;
  if (budgets.length > 0) {
    budgets.forEach(budget => {
      const currentSpend = actualDailySpend(budget, spendMap);
      let recommended;
      if (accountOverPacing) {
        // Proportional decrease, same ratio as everything else
        recommended = currentSpend * overPacingRatio;
      } else if (currentSharedSpend > 0) {
        const proportion = currentSpend / currentSharedSpend;
        recommended = remainingForShared * proportion;
      } else {
        recommended = remainingForShared / budgets.length;
      }

      if (!accountOverPacing) {
        recommended = Math.max(recommended, 1);
      }
      recommended = Math.max(recommended, 0.01);
      recommended = Math.round(recommended * 100) / 100;
      recommendedSharedTotal += recommended;

      const change = Math.round((recommended - currentSpend) * 100) / 100;
      if (Math.abs(change) < 0.01) return;

      const direction = change >= 0 ? 'increase' : 'decrease';
      recommendations.push({
        type: 'shared_budget',
        target: budget.name,
        resourceName: budget.resourceName,
        currentDailyBudget: Math.round(currentSpend * 100) / 100,
        recommendedDailyBudget: recommended,
        change,
        reason: `Account needs $${requiredDailyRate.toFixed(2)}/day total — ${direction} to hit monthly budget`,
      });
    });
  }

  // Budget allocation summary — uses actual spend rates, not budget settings
  const currentTotal = currentVlaSpend + currentSharedSpend + nonVlaDedicatedSpend;
  const recommendedTotal = totalVlaRecommended + recommendedSharedTotal + nonVlaDedicatedSpend;
  const totalChange = Math.round((recommendedTotal - currentTotal) * 100) / 100;

  const budgetSummary = {
    requiredDailyRate: Math.round(requiredDailyRate * 100) / 100,
    currentDailyTotal: Math.round(currentTotal * 100) / 100,
    recommendedDailyTotal: Math.round(recommendedTotal * 100) / 100,
    totalChange,
  };

  return { recommendations, budgetSummary };
}

/**
 * Generates a full pacing recommendation for a dealer account.
 *
 * @param {Object} params
 * @param {Object} params.goal - DealerGoal from goal-reader
 * @param {Object[]} params.campaignSpend - From getMonthSpend
 * @param {Object[]} params.sharedBudgets - From getSharedBudgets
 * @param {Object[]} [params.dedicatedBudgets] - From getDedicatedBudgets
 * @param {Object[]} params.impressionShare - From getImpressionShare
 * @param {number|null} params.inventoryCount - Count of new vehicles
 * @param {number} params.year - Current year
 * @param {number} params.month - Current month (1-12)
 * @param {number} params.currentDay - Current day of month
 * @param {number[]} [params.dayWeights] - Custom day-of-week weights
 * @returns {Object} Full recommendation with pacing, adjustments, and status
 */
function generateRecommendation(params) {
  const {
    goal,
    campaignSpend,
    sharedBudgets,
    dedicatedBudgets,
    impressionShare,
    inventoryCount,
    year,
    month,
    currentDay,
    dayWeights,
  } = params;

  // Sum all campaign spend
  const totalSpend = (campaignSpend || []).reduce((sum, c) => sum + c.spend, 0);

  // Calculate pacing state
  const pacingParams = {
    monthlyBudget: goal.monthlyBudget,
    spendToDate: totalSpend,
    year,
    month,
    currentDay,
    currentInventory: inventoryCount,
    baselineInventory: goal.baselineInventory,
  };
  if (dayWeights) pacingParams.dayWeights = dayWeights;

  const pacing = calculatePacing(pacingParams);

  // Distribute account budget: VLA (priority) + shared (remainder)
  const { recommendations, budgetSummary } = distributeAccountBudget({
    pacing,
    dedicatedBudgets,
    sharedBudgets,
    impressionShareData: impressionShare,
    campaignSpend,
  });

  // Impression share summary
  const impressionShareSummary = summarizeImpressionShare(impressionShare);

  return {
    dealerName: goal.dealerName,
    totalSpend,
    pacing,
    status: pacing.paceStatus,
    statusColor: statusToColor(pacing.paceStatus),
    recommendations,
    budgetSummary,
    impressionShareSummary,
    inventory: {
      count: inventoryCount,
      modifier: pacing.inventoryModifier,
      reason: pacing.inventoryReason,
    },
  };
}

module.exports = {
  generateRecommendation,
  distributeAccountBudget,
  summarizeImpressionShare,
  statusToColor,
  isVlaCampaign,
  VLA_IS_TARGET,
};
