/**
 * Tier 2 Impression Share Optimizer Tests — validates IS-based budget recommendations.
 *
 * Tests: src/services/impression-share-optimizer.js
 * Uses: direct function calls with sample IS + budget data (no fakes needed)
 */

const {
  analyzeImpressionShare,
  generateBudgetChanges,
  IS_TARGETS,
} = require('../../src/services/impression-share-optimizer');

// ── Sample data factories ──

function makeCampaignIS(overrides = {}) {
  return {
    campaignId: '100',
    campaignName: 'Springfield Ford - New - F-150',
    impressionShare: 0.82,
    budgetLostShare: 0.05,
    ...overrides,
  };
}

function makeBudget(overrides = {}) {
  return {
    campaignId: '100',
    campaignName: 'Springfield Ford - New - F-150',
    channelType: 'SEARCH',
    resourceName: 'customers/123/campaignBudgets/456',
    dailyBudget: 50.00,
    ...overrides,
  };
}

// ── analyzeImpressionShare ──

describe('analyzeImpressionShare', () => {
  test('flags campaigns with IS below 75% and budget-lost > 5%', () => {
    const isData = [makeCampaignIS({ impressionShare: 0.60, budgetLostShare: 0.15 })];
    const results = analyzeImpressionShare(isData);
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('increase_budget');
    expect(results[0].reason).toMatch(/below.*75%/i);
  });

  test('flags campaigns with IS above 90% for budget decrease', () => {
    const isData = [makeCampaignIS({ impressionShare: 0.95, budgetLostShare: 0.00 })];
    const results = analyzeImpressionShare(isData);
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('decrease_budget');
    expect(results[0].reason).toMatch(/above.*90%/i);
  });

  test('skips campaigns in the 75-90% sweet spot', () => {
    const isData = [makeCampaignIS({ impressionShare: 0.82, budgetLostShare: 0.03 })];
    const results = analyzeImpressionShare(isData);
    expect(results.length).toBe(0);
  });

  test('skips low-IS campaigns where budget is NOT the issue (budget-lost <= 5%)', () => {
    const isData = [makeCampaignIS({ impressionShare: 0.60, budgetLostShare: 0.02 })];
    const results = analyzeImpressionShare(isData);
    // Low IS but budget isn't the cause — might be rank/CPC issue, not a budget action
    expect(results.length).toBe(0);
  });

  test('skips campaigns with null IS data', () => {
    const isData = [makeCampaignIS({ impressionShare: null, budgetLostShare: null })];
    const results = analyzeImpressionShare(isData);
    expect(results.length).toBe(0);
  });

  test('handles empty input', () => {
    expect(analyzeImpressionShare([])).toEqual([]);
  });

  test('processes multiple campaigns with mixed states', () => {
    const isData = [
      makeCampaignIS({ campaignId: '1', campaignName: 'Low IS', impressionShare: 0.50, budgetLostShare: 0.20 }),
      makeCampaignIS({ campaignId: '2', campaignName: 'Good IS', impressionShare: 0.85, budgetLostShare: 0.01 }),
      makeCampaignIS({ campaignId: '3', campaignName: 'High IS', impressionShare: 0.96, budgetLostShare: 0.00 }),
    ];
    const results = analyzeImpressionShare(isData);
    expect(results.length).toBe(2);
    expect(results.find(r => r.campaignName === 'Low IS').action).toBe('increase_budget');
    expect(results.find(r => r.campaignName === 'High IS').action).toBe('decrease_budget');
  });
});

// ── generateBudgetChanges ──

describe('generateBudgetChanges', () => {
  test('generates budget increase proportional to budget-lost IS', () => {
    const isData = [makeCampaignIS({ impressionShare: 0.60, budgetLostShare: 0.20 })];
    const budgets = [makeBudget({ dailyBudget: 50.00 })];
    const findings = analyzeImpressionShare(isData);
    const changes = generateBudgetChanges(findings, budgets);
    expect(changes.length).toBe(1);
    expect(changes[0].recommendedBudget).toBeGreaterThan(50.00);
    expect(changes[0].change).toBeGreaterThan(0);
  });

  test('generates budget decrease for high-IS campaigns', () => {
    const isData = [makeCampaignIS({ impressionShare: 0.96, budgetLostShare: 0.00 })];
    const budgets = [makeBudget({ dailyBudget: 100.00 })];
    const findings = analyzeImpressionShare(isData);
    const changes = generateBudgetChanges(findings, budgets);
    expect(changes.length).toBe(1);
    expect(changes[0].recommendedBudget).toBeLessThan(100.00);
    expect(changes[0].change).toBeLessThan(0);
  });

  test('caps budget increase at 50%', () => {
    const isData = [makeCampaignIS({ impressionShare: 0.30, budgetLostShare: 0.50 })];
    const budgets = [makeBudget({ dailyBudget: 40.00 })];
    const findings = analyzeImpressionShare(isData);
    const changes = generateBudgetChanges(findings, budgets);
    expect(changes[0].recommendedBudget).toBeLessThanOrEqual(60.00); // 40 * 1.5
  });

  test('caps budget decrease at 20%', () => {
    const isData = [makeCampaignIS({ impressionShare: 0.99, budgetLostShare: 0.00 })];
    const budgets = [makeBudget({ dailyBudget: 100.00 })];
    const findings = analyzeImpressionShare(isData);
    const changes = generateBudgetChanges(findings, budgets);
    expect(changes[0].recommendedBudget).toBeGreaterThanOrEqual(80.00); // 100 * 0.8
  });

  test('skips findings with no matching budget', () => {
    const isData = [makeCampaignIS({ campaignId: '999', impressionShare: 0.50, budgetLostShare: 0.20 })];
    const budgets = [makeBudget({ campaignId: '100' })]; // Different ID
    const findings = analyzeImpressionShare(isData);
    const changes = generateBudgetChanges(findings, budgets);
    expect(changes.length).toBe(0);
  });

  test('includes resource name for API execution', () => {
    const isData = [makeCampaignIS({ impressionShare: 0.96, budgetLostShare: 0.00 })];
    const budgets = [makeBudget({ resourceName: 'customers/123/campaignBudgets/456' })];
    const findings = analyzeImpressionShare(isData);
    const changes = generateBudgetChanges(findings, budgets);
    expect(changes[0].resourceName).toBe('customers/123/campaignBudgets/456');
  });

  test('rounds recommended budget to 2 decimal places', () => {
    const isData = [makeCampaignIS({ impressionShare: 0.55, budgetLostShare: 0.15 })];
    const budgets = [makeBudget({ dailyBudget: 33.33 })];
    const findings = analyzeImpressionShare(isData);
    const changes = generateBudgetChanges(findings, budgets);
    const budget = changes[0].recommendedBudget;
    expect(budget).toBe(Math.round(budget * 100) / 100);
  });

  test('handles empty inputs', () => {
    expect(generateBudgetChanges([], [])).toEqual([]);
  });
});

// ── IS_TARGETS ──

describe('IS_TARGETS', () => {
  test('exports correct target range', () => {
    expect(IS_TARGETS.min).toBe(0.75);
    expect(IS_TARGETS.max).toBe(0.90);
    expect(IS_TARGETS.budgetLostThreshold).toBe(0.05);
  });
});
