/**
 * Budget Recommender — generates budget adjustment recommendations
 * for dealer accounts based on pacing state and market data.
 *
 * Called by: routes/pacing.js (future)
 * Calls: services/pacing-calculator.js
 *
 * Takes a dealer's goal, spend data, shared budgets, impression share,
 * and inventory count, and produces a recommendation object with:
 * - Pacing state (from calculatePacing)
 * - Color-coded status for dashboard display
 * - Specific dollar-amount budget adjustments for shared budgets
 * - Impression share summary
 * - Inventory status
 */

const { calculatePacing } = require('./pacing-calculator');

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

  // If total daily budget is zero, distribute required rate evenly
  const useEvenDistribution = totalDailyBudget === 0;
  const ratio = useEvenDistribution ? 0 : requiredRate / totalDailyBudget;

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
 * Generates a full pacing recommendation for a dealer account.
 *
 * @param {Object} params
 * @param {Object} params.goal - DealerGoal from goal-reader
 * @param {Object[]} params.campaignSpend - From getMonthSpend
 * @param {Object[]} params.sharedBudgets - From getSharedBudgets
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

  // Budget adjustments
  const recommendations = calculateBudgetAdjustments(pacing, sharedBudgets);

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
  summarizeImpressionShare,
  statusToColor,
};
