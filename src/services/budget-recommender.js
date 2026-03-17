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
 * Distributes the account's required daily rate across VLA and shared budgets.
 *
 * Algorithm:
 * 1. Calculate account-level required daily rate (remainingBudget / daysRemaining)
 * 2. Subtract non-VLA dedicated campaign budgets (not being adjusted)
 * 3. Set VLA budgets based on impression share targets (priority)
 * 4. Distribute remainder to shared budgets proportionally
 *
 * @param {Object} params
 * @param {Object} params.pacing - Output from calculatePacing
 * @param {Object[]} [params.dedicatedBudgets] - From getDedicatedBudgets
 * @param {Object[]} [params.sharedBudgets] - From getSharedBudgets
 * @param {Object[]} [params.impressionShareData] - From getImpressionShare
 * @returns {Object} { recommendations, budgetSummary }
 */
function distributeAccountBudget({ pacing, dedicatedBudgets, sharedBudgets, impressionShareData }) {
  if (pacing.daysRemaining === 0) {
    return { recommendations: [], budgetSummary: null };
  }

  const requiredDailyRate = pacing.remainingBudget / pacing.daysRemaining;

  // Separate VLA vs non-VLA dedicated campaigns
  const allDedicated = dedicatedBudgets || [];
  const vlaCampaigns = allDedicated.filter(isVlaCampaign);
  const nonVlaDedicated = allDedicated.filter(c => !isVlaCampaign(c));
  const nonVlaDedicatedTotal = nonVlaDedicated.reduce((s, c) => s + c.dailyBudget, 0);

  // Budget available for VLA + shared (subtract non-VLA dedicated which we don't adjust)
  const targetForAdjustable = Math.max(requiredDailyRate - nonVlaDedicatedTotal, 0);

  // --- Step 1: VLA budgets — impression share driven (priority) ---
  const isMap = new Map();
  (impressionShareData || []).forEach(d => isMap.set(d.campaignId, d));

  const vlaAllocations = vlaCampaigns.map(campaign => {
    const campIS = isMap.get(campaign.campaignId);
    const is = campIS?.impressionShare;
    const bls = campIS?.budgetLostShare;

    let recommended = campaign.dailyBudget;
    let reason;

    if (is != null && is < VLA_IS_TARGET.min) {
      // Under 75% IS — boost to capture more traffic
      const boost = Math.min(VLA_IS_TARGET.min / Math.max(is, 0.01), 2.0);
      recommended = campaign.dailyBudget * boost;
      reason = `IS ${(is * 100).toFixed(1)}% below 75% target`
        + (bls != null && bls > 0.05 ? ` (${(bls * 100).toFixed(1)}% lost to budget)` : '')
        + ` — increase to capture more VLA traffic`;
    } else if (is != null && is > VLA_IS_TARGET.max) {
      // Over 90% IS — scale back to avoid CPC inflation
      const scale = VLA_IS_TARGET.max / is;
      recommended = campaign.dailyBudget * scale;
      reason = `IS ${(is * 100).toFixed(1)}% exceeds 90% — reduce to avoid CPC inflation`;
    } else if (is != null) {
      // IS in target range 75-90% — keep current
      reason = `IS ${(is * 100).toFixed(1)}% on target (75-90%)`;
    } else {
      // No IS data — keep current budget
      reason = null;
    }

    recommended = Math.max(recommended, 1);
    recommended = Math.round(recommended * 100) / 100;

    return { campaign, recommended, reason, currentBudget: campaign.dailyBudget };
  });

  const totalVlaRecommended = vlaAllocations.reduce((s, v) => s + v.recommended, 0);

  // --- Step 2: Shared budgets get the remainder ---
  const budgets = sharedBudgets || [];
  const remainingForShared = Math.max(targetForAdjustable - totalVlaRecommended, 0);
  const currentSharedTotal = budgets.reduce((s, b) => s + b.dailyBudget, 0);

  // Build final recommendations
  const recommendations = [];

  // VLA recs (only if there's a meaningful change)
  vlaAllocations.forEach(v => {
    if (!v.reason) return;
    const change = Math.round((v.recommended - v.currentBudget) * 100) / 100;
    if (Math.abs(change) < 0.01) return;

    recommendations.push({
      type: 'campaign_budget',
      target: v.campaign.campaignName,
      resourceName: v.campaign.resourceName,
      currentDailyBudget: v.currentBudget,
      recommendedDailyBudget: v.recommended,
      change,
      reason: v.reason,
      isVla: true,
    });
  });

  // Shared budget recs — distribute remaining proportionally
  if (budgets.length > 0) {
    budgets.forEach(budget => {
      let recommended;
      if (currentSharedTotal > 0) {
        const proportion = budget.dailyBudget / currentSharedTotal;
        recommended = remainingForShared * proportion;
      } else {
        recommended = remainingForShared / budgets.length;
      }

      recommended = Math.max(recommended, 1);
      recommended = Math.round(recommended * 100) / 100;
      const change = Math.round((recommended - budget.dailyBudget) * 100) / 100;

      if (Math.abs(change) < 0.01) return;

      const direction = change >= 0 ? 'increase' : 'decrease';
      recommendations.push({
        type: 'shared_budget',
        target: budget.name,
        resourceName: budget.resourceName,
        currentDailyBudget: budget.dailyBudget,
        recommendedDailyBudget: recommended,
        change,
        reason: `Account needs $${requiredDailyRate.toFixed(2)}/day total — ${direction} to hit monthly budget`,
      });
    });
  }

  // Budget allocation summary for the dashboard
  const currentTotal = vlaCampaigns.reduce((s, c) => s + c.dailyBudget, 0) + currentSharedTotal + nonVlaDedicatedTotal;
  const recommendedSharedTotal = budgets.length > 0
    ? budgets.reduce((s, b) => {
        let rec;
        if (currentSharedTotal > 0) rec = remainingForShared * (b.dailyBudget / currentSharedTotal);
        else rec = remainingForShared / budgets.length;
        return s + Math.max(Math.round(rec * 100) / 100, 1);
      }, 0)
    : 0;
  const recommendedTotal = totalVlaRecommended + recommendedSharedTotal + nonVlaDedicatedTotal;

  const budgetSummary = {
    requiredDailyRate: Math.round(requiredDailyRate * 100) / 100,
    currentDailyTotal: Math.round(currentTotal * 100) / 100,
    recommendedDailyTotal: Math.round(recommendedTotal * 100) / 100,
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
