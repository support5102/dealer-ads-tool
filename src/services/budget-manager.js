/**
 * Budget Manager — enforces budget split targets and detects shared budget contention.
 *
 * Called by: routes/optimization.js (POST /api/optimize/budgets/:customerId)
 * Calls: strategy-rules.js (BUDGET_SPLITS, classifyCampaignType, NAMING_PATTERNS)
 *
 * Ensures VLA campaigns get 40-50% of total daily budget, detects shared budgets
 * with too many or mismatched campaigns, and generates rebalance suggestions
 * when allocations drift from strategy targets.
 */

const { BUDGET_SPLITS, NAMING_PATTERNS, classifyCampaignType } = require('./strategy-rules');

/** Maximum campaigns per shared budget before flagging contention */
const MAX_SHARED_BUDGET_CAMPAIGNS = 5;

/**
 * Checks whether budget allocations match strategy split targets.
 *
 * @param {Object[]} budgets - Dedicated budgets from getDedicatedBudgets()
 * @returns {Object[]} Array of findings with severity, category, and details
 */
function checkBudgetSplits(budgets) {
  if (!budgets || !budgets.length) return [];

  const findings = [];
  const totalDaily = budgets.reduce((sum, b) => sum + b.dailyBudget, 0);
  if (totalDaily === 0) return [];

  // Calculate VLA share
  const vlaBudget = budgets
    .filter(b => isVlaCampaign(b.campaignName))
    .reduce((sum, b) => sum + b.dailyBudget, 0);
  const vlaPercent = vlaBudget / totalDaily;

  if (vlaPercent < BUDGET_SPLITS.vla.min) {
    findings.push({
      severity: vlaPercent < 0.25 ? 'critical' : 'warning',
      category: 'vla',
      message: `VLA budget allocation (${(vlaPercent * 100).toFixed(1)}%) is below target range (${BUDGET_SPLITS.vla.min * 100}-${BUDGET_SPLITS.vla.max * 100}%)`,
      details: {
        actualPercent: Math.round(vlaPercent * 1000) / 10,
        targetRange: `${BUDGET_SPLITS.vla.min * 100}-${BUDGET_SPLITS.vla.max * 100}%`,
        vlaBudget,
        totalDaily,
      },
    });
  } else if (vlaPercent > BUDGET_SPLITS.vla.max) {
    findings.push({
      severity: 'warning',
      category: 'vla',
      message: `VLA budget allocation (${(vlaPercent * 100).toFixed(1)}%) exceeds target range (${BUDGET_SPLITS.vla.min * 100}-${BUDGET_SPLITS.vla.max * 100}%)`,
      details: {
        actualPercent: Math.round(vlaPercent * 1000) / 10,
        targetRange: `${BUDGET_SPLITS.vla.min * 100}-${BUDGET_SPLITS.vla.max * 100}%`,
        vlaBudget,
        totalDaily,
      },
    });
  }

  return findings;
}

/**
 * Detects shared budget contention issues.
 *
 * @param {Object[]} sharedBudgets - Shared budgets from getSharedBudgets()
 * @returns {Object[]} Array of contention findings
 */
function detectSharedBudgetContention(sharedBudgets) {
  if (!sharedBudgets || !sharedBudgets.length) return [];

  const findings = [];

  for (const budget of sharedBudgets) {
    const campaigns = budget.campaigns || [];

    // Check campaign count
    if (campaigns.length > MAX_SHARED_BUDGET_CAMPAIGNS) {
      findings.push({
        type: 'too_many_campaigns',
        budgetName: budget.budgetName,
        budgetId: budget.budgetId,
        message: `Shared budget "${budget.budgetName}" has ${campaigns.length} campaigns — may cause contention (max recommended: ${MAX_SHARED_BUDGET_CAMPAIGNS})`,
        campaigns: campaigns.map(c => c.campaignName),
      });
    }

    // Check for mixed campaign types
    if (campaigns.length >= 2) {
      const types = new Set(campaigns.map(c => classifyCampaignType(c.campaignName)));
      if (types.size > 1) {
        findings.push({
          type: 'mixed_types',
          budgetName: budget.budgetName,
          budgetId: budget.budgetId,
          message: `Shared budget "${budget.budgetName}" contains mixed campaign types: ${[...types].join(', ')} — campaigns compete for different audiences`,
          campaignTypes: [...types],
        });
      }
    }
  }

  return findings;
}

/**
 * Generates budget rebalance suggestions to align with strategy targets.
 * Takes from lower-priority campaign types (general/regional) and gives to VLA.
 *
 * @param {Object[]} budgets - Dedicated budgets from getDedicatedBudgets()
 * @returns {Object[]} Array of rebalance suggestions with current and recommended budgets
 */
function generateBudgetRebalance(budgets) {
  if (!budgets || budgets.length <= 1) return [];

  const totalDaily = budgets.reduce((sum, b) => sum + b.dailyBudget, 0);
  if (totalDaily === 0) return [];

  const vlaBudgets = budgets.filter(b => isVlaCampaign(b.campaignName));
  const nonVlaBudgets = budgets.filter(b => !isVlaCampaign(b.campaignName));
  const vlaCurrent = vlaBudgets.reduce((sum, b) => sum + b.dailyBudget, 0);
  const vlaPercent = vlaCurrent / totalDaily;

  // Only rebalance if VLA is outside target range
  if (vlaPercent >= BUDGET_SPLITS.vla.min && vlaPercent <= BUDGET_SPLITS.vla.max) {
    return [];
  }

  const suggestions = [];

  if (vlaPercent < BUDGET_SPLITS.vla.min) {
    // VLA underfunded — take from non-VLA campaigns, prioritizing general/regional
    const vlaTarget = totalDaily * BUDGET_SPLITS.vla.min;
    const deficit = vlaTarget - vlaCurrent;

    // Sort non-VLA by priority: general/regional first (lowest priority = cut first)
    const prioritized = nonVlaBudgets.map(b => ({
      ...b,
      type: classifyCampaignType(b.campaignName),
      priority: getCutPriority(classifyCampaignType(b.campaignName)),
    })).sort((a, b) => a.priority - b.priority);

    let remaining = deficit;

    for (const campaign of prioritized) {
      if (remaining <= 0) break;
      // Take up to 30% from each non-VLA campaign
      const maxCut = campaign.dailyBudget * 0.30;
      const cut = Math.min(maxCut, remaining);
      if (cut > 0) {
        suggestions.push({
          campaignId: campaign.campaignId,
          campaignName: campaign.campaignName,
          resourceName: campaign.resourceName,
          currentBudget: campaign.dailyBudget,
          recommendedBudget: Math.round((campaign.dailyBudget - cut) * 100) / 100,
          change: Math.round(-cut * 100) / 100,
          reason: `Reduce to fund VLA campaigns (currently at ${(vlaPercent * 100).toFixed(1)}%, target: ${BUDGET_SPLITS.vla.min * 100}%+)`,
        });
        remaining -= cut;
      }
    }

    // Add VLA increase suggestion
    const actualIncrease = deficit - remaining;
    if (actualIncrease > 0) {
      for (const vla of vlaBudgets) {
        // Distribute increase proportionally across VLA campaigns
        const share = vlaBudgets.length === 1 ? 1 : vla.dailyBudget / vlaCurrent;
        const increase = actualIncrease * share;
        suggestions.push({
          campaignId: vla.campaignId,
          campaignName: vla.campaignName,
          resourceName: vla.resourceName,
          currentBudget: vla.dailyBudget,
          recommendedBudget: Math.round((vla.dailyBudget + increase) * 100) / 100,
          change: Math.round(increase * 100) / 100,
          reason: `Increase VLA allocation from ${(vlaPercent * 100).toFixed(1)}% to target ${BUDGET_SPLITS.vla.min * 100}%+`,
        });
      }
    }
  }

  return suggestions;
}

/**
 * Returns cut priority for a campaign type (lower = cut first).
 * @param {string} type - Campaign type from classifyCampaignType
 * @returns {number} Priority (1 = cut first, 3 = cut last)
 */
function getCutPriority(type) {
  switch (type) {
    case 'general':
    case 'regional':
      return 1; // Lowest priority — cut first
    case 'competitor':
    case 'used':
      return 2;
    case 'new_high':
    case 'new_low':
    case 'brand':
    default:
      return 3; // Highest priority — cut last
  }
}

/**
 * Checks if a campaign name indicates a VLA/PMax campaign.
 * @param {string} name - Campaign name
 * @returns {boolean}
 */
function isVlaCampaign(name) {
  if (!name) return false;
  return name.startsWith(NAMING_PATTERNS.pmaxPrefix) ||
    /\bPMax\b/i.test(name) ||
    /\bVLA\b/i.test(name);
}

module.exports = {
  checkBudgetSplits,
  detectSharedBudgetContention,
  generateBudgetRebalance,
  isVlaCampaign,
  getCutPriority,
  MAX_SHARED_BUDGET_CAMPAIGNS,
};
