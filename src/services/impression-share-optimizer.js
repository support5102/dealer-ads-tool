/**
 * Impression Share Optimizer — recommends budget changes based on IS performance.
 *
 * Called by: routes/optimization.js (POST /api/optimize/impression-share/:customerId)
 * Calls: strategy-rules.js (IS targets)
 *
 * Core idea: if IS < 75% and budget-lost IS > 5%, the campaign is losing auctions
 * due to budget constraints — increase budget. If IS > 90%, we're overspending
 * for diminishing returns — decrease budget to reallocate elsewhere.
 */

const { IMPRESSION_SHARE } = require('./strategy-rules');

/** IS targets and thresholds */
const IS_TARGETS = {
  min: IMPRESSION_SHARE.target.min,   // 0.75
  max: IMPRESSION_SHARE.target.max,   // 0.90
  budgetLostThreshold: 0.05,          // Only flag if >5% IS lost to budget
};

/** Maximum budget increase per cycle */
const MAX_INCREASE_PERCENT = 50;

/** Maximum budget decrease per cycle */
const MAX_DECREASE_PERCENT = 20;

/**
 * Analyzes campaign IS data and identifies budget optimization opportunities.
 *
 * @param {Object[]} isData - Impression share data from getImpressionShare()
 * @returns {Object[]} Array of findings with action (increase_budget/decrease_budget)
 */
function analyzeImpressionShare(isData) {
  if (!isData || !isData.length) return [];

  const findings = [];

  for (const campaign of isData) {
    const is = campaign.impressionShare;
    const budgetLost = campaign.budgetLostShare;

    // Skip campaigns with missing data
    if (is === null || is === undefined) continue;

    if (is < IS_TARGETS.min && budgetLost > IS_TARGETS.budgetLostThreshold) {
      // Low IS + significant budget-lost → budget is the constraint
      findings.push({
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName,
        impressionShare: is,
        budgetLostShare: budgetLost,
        action: 'increase_budget',
        reason: `Impression share (${(is * 100).toFixed(1)}%) below 75% target with ${(budgetLost * 100).toFixed(1)}% lost to budget — increase budget to capture more traffic`,
      });
    } else if (is > IS_TARGETS.max) {
      // High IS → overspending for diminishing returns
      findings.push({
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName,
        impressionShare: is,
        budgetLostShare: budgetLost ?? 0,
        action: 'decrease_budget',
        reason: `Impression share (${(is * 100).toFixed(1)}%) above 90% target — decrease budget to avoid CPC inflation and reallocate`,
      });
    }
  }

  return findings;
}

/**
 * Generates specific budget change amounts for each IS finding.
 * Increase is proportional to budget-lost IS. Decrease is proportional to IS overshoot.
 *
 * @param {Object[]} findings - Output from analyzeImpressionShare()
 * @param {Object[]} budgets - Dedicated budgets from getDedicatedBudgets()
 * @returns {Object[]} Array of budget changes with recommendedBudget and metadata
 */
function generateBudgetChanges(findings, budgets) {
  if (!findings || !findings.length) return [];

  // Index budgets by campaign ID for fast lookup
  const budgetMap = new Map();
  for (const b of budgets) {
    budgetMap.set(b.campaignId, b);
  }

  const changes = [];

  for (const finding of findings) {
    const budget = budgetMap.get(finding.campaignId);
    if (!budget) continue; // No matching budget found

    let recommendedBudget;

    if (finding.action === 'increase_budget') {
      // Scale increase by budget-lost IS (more budget lost → bigger increase)
      // budgetLostShare ranges from ~0.05 to ~0.50+
      const increasePercent = Math.min(
        finding.budgetLostShare * 100, // e.g. 0.20 → 20%
        MAX_INCREASE_PERCENT
      );
      recommendedBudget = budget.dailyBudget * (1 + increasePercent / 100);
    } else {
      // Scale decrease by how far IS exceeds 90%
      const overBy = finding.impressionShare - IS_TARGETS.max; // 0.01 to ~0.10
      const decreasePercent = Math.min(
        overBy * (MAX_DECREASE_PERCENT / 0.10),
        MAX_DECREASE_PERCENT
      );
      recommendedBudget = budget.dailyBudget * (1 - decreasePercent / 100);
    }

    // Round to 2 decimal places
    recommendedBudget = Math.round(recommendedBudget * 100) / 100;

    changes.push({
      campaignId: finding.campaignId,
      campaignName: finding.campaignName,
      resourceName: budget.resourceName,
      currentBudget: budget.dailyBudget,
      recommendedBudget,
      change: Math.round((recommendedBudget - budget.dailyBudget) * 100) / 100,
      impressionShare: finding.impressionShare,
      budgetLostShare: finding.budgetLostShare,
      action: finding.action,
      reason: finding.reason,
    });
  }

  return changes;
}

module.exports = {
  analyzeImpressionShare,
  generateBudgetChanges,
  IS_TARGETS,
};
