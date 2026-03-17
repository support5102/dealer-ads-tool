/**
 * Budget Recommender — generates budget adjustment recommendations
 * for dealer accounts based on pacing state and market data.
 *
 * Called by: routes/pacing.js
 * Calls: services/pacing-calculator.js
 *
 * Takes a dealer's goal, spend data, shared budgets, dedicated budgets,
 * impression share, and inventory count, and produces a recommendation object with:
 * - Pacing state (from calculatePacing)
 * - Color-coded status for dashboard display
 * - Specific dollar-amount budget adjustments for shared + VLA budgets
 * - Impression share summary
 * - Inventory status
 */

const { calculatePacing } = require('./pacing-calculator');

// VLA impression share targets — below 75% we're leaving money on the table,
// above 90% CPC inflates with diminishing returns.
const VLA_IS_TARGET = { min: 0.75, max: 0.90 };

/**
 * Maps pacing status to dashboard color.
 *
 * @param {string} status - Pacing status from calculatePacing
 * @returns {string} Color: 'green', 'yellow', 'red', or 'gray'
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
 *
 * @param {Object} campaign - Campaign with campaignName and channelType
 * @returns {boolean} True if VLA campaign
 */
function isVlaCampaign(campaign) {
  const name = (campaign.campaignName || '').toLowerCase();
  const type = (campaign.channelType || '').toUpperCase();
  return name.includes('vla') || type === 'SHOPPING' || type === 'LOCAL';
}

/**
 * Summarizes impression share data across campaigns.
 *
 * @param {Object[]} impressionShareData - From getImpressionShare
 * @returns {Object} { avgImpressionShare, avgBudgetLostShare, limitedCampaigns }
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
 * Calculates recommended daily budget adjustments for shared budgets.
 *
 * When off-pace, adjusts each shared budget proportionally so the total
 * daily spend rate matches the required daily rate from pacing.
 *
 * @param {Object} pacing - Output from calculatePacing
 * @param {Object[]} sharedBudgets - From getSharedBudgets
 * @returns {Object[]} Array of adjustment recommendations
 */
function calculateBudgetAdjustments(pacing, sharedBudgets) {
  if (!sharedBudgets || sharedBudgets.length === 0) return [];
  if (pacing.daysRemaining === 0) return [];
  if (pacing.paceStatus === 'on_pace') return [];

  const totalDailyBudget = sharedBudgets.reduce((sum, b) => sum + b.dailyBudget, 0);
  // Use flat daily rate (remainingBudget / daysRemaining), not the weighted-for-today
  // rate, because Google Ads daily budgets apply every day going forward.
  const requiredRate = pacing.daysRemaining > 0
    ? pacing.remainingBudget / pacing.daysRemaining
    : 0;

  // Compare against actual daily spend rate (not budget settings) because Google Ads
  // routinely overspends daily budgets. Using budget settings as the denominator leads
  // to wrong recommendations when actual spend diverges from settings (e.g. account
  // spending $287/day on a $71/day budget would get an "increase" recommendation
  // even when critically over-pacing).
  // Fall back to budget settings only when there's no spend history.
  const actualDailySpend = pacing.dailyAvgSpend || 0;
  const denominator = actualDailySpend > 0 ? actualDailySpend : totalDailyBudget;
  const useEvenDistribution = denominator === 0;
  const ratio = useEvenDistribution ? 0 : requiredRate / denominator;

  return sharedBudgets.map(budget => {
    let recommended;
    if (useEvenDistribution) {
      recommended = requiredRate / sharedBudgets.length;
    } else {
      recommended = budget.dailyBudget * ratio;
    }

    // Enforce minimum $1/day
    recommended = Math.max(recommended, 1);
    // Round to 2 decimals
    recommended = Math.round(recommended * 100) / 100;

    const change = Math.round((recommended - budget.dailyBudget) * 100) / 100;
    const direction = change >= 0 ? 'increase' : 'decrease';
    const pacingLabel = change >= 0 ? 'Under' : 'Over';

    return {
      type: 'shared_budget',
      target: budget.name,
      resourceName: budget.resourceName,
      currentDailyBudget: budget.dailyBudget,
      recommendedDailyBudget: recommended,
      change,
      reason: `${pacingLabel}-pacing — ${direction} daily budget from $${budget.dailyBudget.toFixed(2)} to $${recommended.toFixed(2)} to hit monthly target`,
    };
  });
}

/**
 * Calculates recommended daily budget adjustments for VLA campaigns
 * based on impression share targets (75-90%).
 *
 * VLAs are priority campaigns — below 75% IS we're leaving money on the table,
 * above 90% IS CPC inflates with diminishing returns.
 *
 * @param {Object} pacing - Output from calculatePacing
 * @param {Object[]} dedicatedBudgets - From getDedicatedBudgets
 * @param {Object[]} impressionShareData - From getImpressionShare
 * @returns {Object[]} Array of VLA adjustment recommendations
 */
function calculateVlaAdjustments(pacing, dedicatedBudgets, impressionShareData) {
  if (!dedicatedBudgets || dedicatedBudgets.length === 0) return [];
  if (pacing.daysRemaining === 0) return [];

  // Only VLA campaigns
  const vlaCampaigns = dedicatedBudgets.filter(isVlaCampaign);
  if (vlaCampaigns.length === 0) return [];

  // Build impression share lookup by campaign ID
  const isMap = new Map();
  (impressionShareData || []).forEach(d => isMap.set(d.campaignId, d));

  return vlaCampaigns.map(campaign => {
    const campIS = isMap.get(campaign.campaignId);
    const is = campIS?.impressionShare;
    const bls = campIS?.budgetLostShare;

    let recommended = campaign.dailyBudget;
    let reason;

    if (is != null) {
      if (is < VLA_IS_TARGET.min) {
        // Under 75% IS — increase VLA budget to capture more traffic
        // Scale proportionally toward 75%, cap at 2x to avoid over-correction
        const boost = Math.min(VLA_IS_TARGET.min / Math.max(is, 0.01), 2.0);
        recommended = campaign.dailyBudget * boost;
        reason = `Impression share ${(is * 100).toFixed(1)}% below 75% target`
          + (bls != null && bls > 0.05 ? ` (${(bls * 100).toFixed(1)}% lost to budget)` : '')
          + ` — increase to capture more VLA traffic`;
      } else if (is > VLA_IS_TARGET.max) {
        // Over 90% IS — scale back to avoid CPC inflation
        const scale = VLA_IS_TARGET.max / is;
        recommended = campaign.dailyBudget * scale;
        reason = `Impression share ${(is * 100).toFixed(1)}% exceeds 90% — reduce to avoid CPC inflation`;
      } else {
        // IS in target range 75-90% — VLA is performing well, no change needed
        return null;
      }
    } else {
      // No IS data available — can't make IS-based recommendation
      return null;
    }

    recommended = Math.max(recommended, 1);
    recommended = Math.round(recommended * 100) / 100;
    const change = Math.round((recommended - campaign.dailyBudget) * 100) / 100;

    // Skip if change is negligible
    if (Math.abs(change) < 0.01) return null;

    return {
      type: 'campaign_budget',
      target: campaign.campaignName,
      resourceName: campaign.resourceName,
      currentDailyBudget: campaign.dailyBudget,
      recommendedDailyBudget: recommended,
      change,
      reason,
      isVla: true,
    };
  }).filter(Boolean);
}

/**
 * Generates a full pacing recommendation for a dealer account.
 *
 * @param {Object} params
 * @param {Object} params.goal - DealerGoal from goal-reader
 * @param {Object[]} params.campaignSpend - From getMonthSpend
 * @param {Object[]} params.sharedBudgets - From getSharedBudgets
 * @param {Object[]} [params.dedicatedBudgets] - From getDedicatedBudgets (VLAs etc.)
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

  // Budget adjustments — VLA campaigns first (priority), then shared budgets
  const vlaRecs = calculateVlaAdjustments(pacing, dedicatedBudgets, impressionShare);
  const sharedRecs = calculateBudgetAdjustments(pacing, sharedBudgets);
  const recommendations = [...vlaRecs, ...sharedRecs];

  // Impression share summary
  const impressionShareSummary = summarizeImpressionShare(impressionShare);

  return {
    dealerName: goal.dealerName,
    totalSpend,
    pacing,
    status: pacing.paceStatus,
    statusColor: statusToColor(pacing.paceStatus),
    recommendations,
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
  calculateBudgetAdjustments,
  calculateVlaAdjustments,
  summarizeImpressionShare,
  statusToColor,
  isVlaCampaign,
  VLA_IS_TARGET,
};
