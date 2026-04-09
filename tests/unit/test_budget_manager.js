/**
 * Tier 2 Budget Manager Tests — validates budget split enforcement and contention detection.
 *
 * Tests: src/services/budget-manager.js
 * Uses: direct function calls with sample budget data (no fakes needed)
 */

const {
  checkBudgetSplits,
  detectSharedBudgetContention,
  generateBudgetRebalance,
} = require('../../src/services/budget-manager');

// ── Sample data factories ──

function makeDedicatedBudget(overrides = {}) {
  return {
    campaignId: '100',
    campaignName: 'PMax: VLA Ads - New',
    channelType: 'PERFORMANCE_MAX',
    resourceName: 'customers/123/campaignBudgets/456',
    dailyBudget: 50.00,
    ...overrides,
  };
}

function makeSharedBudget(overrides = {}) {
  return {
    budgetId: '789',
    budgetName: 'Shared - Search',
    resourceName: 'customers/123/campaignBudgets/789',
    dailyBudget: 100.00,
    campaigns: [
      { campaignId: '200', campaignName: 'Springfield Ford - New - F-150' },
      { campaignId: '201', campaignName: 'Springfield Ford - New - Escape' },
    ],
    ...overrides,
  };
}

function makeSpendData(overrides = {}) {
  return {
    campaignId: '100',
    campaignName: 'PMax: VLA Ads - New',
    spend: 400.00,
    ...overrides,
  };
}

// ── checkBudgetSplits ──

describe('checkBudgetSplits', () => {
  test('detects VLA campaigns getting less than 40% of total budget', () => {
    const budgets = [
      makeDedicatedBudget({ campaignName: 'PMax: VLA Ads - New', dailyBudget: 20 }),
      makeDedicatedBudget({ campaignId: '200', campaignName: 'Springfield Ford - New - F-150', dailyBudget: 80, channelType: 'SEARCH' }),
    ];
    const findings = checkBudgetSplits(budgets);
    expect(findings.length).toBeGreaterThan(0);
    const vlaFinding = findings.find(f => f.category === 'vla');
    expect(vlaFinding).toBeDefined();
    expect(vlaFinding.severity).toMatch(/warning|critical/);
  });

  test('detects VLA campaigns getting more than 50% of total budget', () => {
    const budgets = [
      makeDedicatedBudget({ campaignName: 'PMax: VLA Ads - New', dailyBudget: 70 }),
      makeDedicatedBudget({ campaignId: '200', campaignName: 'Springfield Ford - New - F-150', dailyBudget: 30, channelType: 'SEARCH' }),
    ];
    const findings = checkBudgetSplits(budgets);
    const vlaFinding = findings.find(f => f.category === 'vla');
    expect(vlaFinding).toBeDefined();
    expect(vlaFinding.message).toMatch(/above|over|exceeds/i);
  });

  test('passes when VLA is in the 40-50% range', () => {
    const budgets = [
      makeDedicatedBudget({ campaignName: 'PMax: VLA Ads - New', dailyBudget: 45 }),
      makeDedicatedBudget({ campaignId: '200', campaignName: 'Springfield Ford - New - F-150', dailyBudget: 55, channelType: 'SEARCH' }),
    ];
    const findings = checkBudgetSplits(budgets);
    const vlaFinding = findings.find(f => f.category === 'vla');
    expect(vlaFinding).toBeUndefined();
  });

  test('handles accounts with no VLA campaigns gracefully', () => {
    const budgets = [
      makeDedicatedBudget({ campaignName: 'Springfield Ford - New - F-150', channelType: 'SEARCH', dailyBudget: 50 }),
      makeDedicatedBudget({ campaignId: '200', campaignName: 'Springfield Ford - Used', channelType: 'SEARCH', dailyBudget: 50 }),
    ];
    const findings = checkBudgetSplits(budgets);
    // Should not crash, may flag missing VLA
    expect(Array.isArray(findings)).toBe(true);
  });

  test('handles empty budget list', () => {
    expect(checkBudgetSplits([])).toEqual([]);
  });

  test('includes actual percentages in findings', () => {
    const budgets = [
      makeDedicatedBudget({ campaignName: 'PMax: VLA Ads - New', dailyBudget: 10 }),
      makeDedicatedBudget({ campaignId: '200', campaignName: 'Springfield Ford - New - Civic', dailyBudget: 90, channelType: 'SEARCH' }),
    ];
    const findings = checkBudgetSplits(budgets);
    const vlaFinding = findings.find(f => f.category === 'vla');
    expect(vlaFinding.details).toHaveProperty('actualPercent');
    expect(vlaFinding.details).toHaveProperty('targetRange');
  });
});

// ── detectSharedBudgetContention ──

describe('detectSharedBudgetContention', () => {
  test('flags shared budgets with too many campaigns (>5)', () => {
    const sharedBudgets = [makeSharedBudget({
      campaigns: Array.from({ length: 8 }, (_, i) => ({
        campaignId: String(200 + i),
        campaignName: `Campaign ${i}`,
      })),
    })];
    const findings = detectSharedBudgetContention(sharedBudgets);
    expect(findings.length).toBe(1);
    expect(findings[0].message).toMatch(/8 campaigns/);
  });

  test('flags shared budgets with mixed campaign types', () => {
    const sharedBudgets = [makeSharedBudget({
      campaigns: [
        { campaignId: '200', campaignName: 'PMax: VLA Ads - New' },
        { campaignId: '201', campaignName: 'Springfield Ford - New - F-150' },
      ],
    })];
    const findings = detectSharedBudgetContention(sharedBudgets);
    const mixedFinding = findings.find(f => f.type === 'mixed_types');
    expect(mixedFinding).toBeDefined();
  });

  test('passes shared budget with similar campaign types', () => {
    const sharedBudgets = [makeSharedBudget({
      campaigns: [
        { campaignId: '200', campaignName: 'Springfield Ford - New - F-150' },
        { campaignId: '201', campaignName: 'Springfield Ford - New - Escape' },
      ],
    })];
    const findings = detectSharedBudgetContention(sharedBudgets);
    const mixedFinding = findings.find(f => f.type === 'mixed_types');
    expect(mixedFinding).toBeUndefined();
  });

  test('handles empty shared budgets', () => {
    expect(detectSharedBudgetContention([])).toEqual([]);
  });
});

// ── generateBudgetRebalance ──

describe('generateBudgetRebalance', () => {
  test('generates rebalance suggestions when VLA is underfunded', () => {
    const budgets = [
      makeDedicatedBudget({ campaignName: 'PMax: VLA Ads - New', dailyBudget: 20 }),
      makeDedicatedBudget({ campaignId: '200', campaignName: 'Springfield Ford - General', dailyBudget: 80, channelType: 'SEARCH' }),
    ];
    const suggestions = generateBudgetRebalance(budgets);
    expect(suggestions.length).toBeGreaterThan(0);
    const vlaSuggestion = suggestions.find(s => s.campaignName.includes('VLA'));
    expect(vlaSuggestion.recommendedBudget).toBeGreaterThan(20);
  });

  test('reduces general/regional campaigns first when rebalancing', () => {
    const budgets = [
      makeDedicatedBudget({ campaignName: 'PMax: VLA Ads - New', dailyBudget: 20 }),
      makeDedicatedBudget({ campaignId: '201', campaignName: 'Springfield Ford - General', dailyBudget: 40, channelType: 'SEARCH' }),
      makeDedicatedBudget({ campaignId: '202', campaignName: 'Springfield Ford - New - F-150', dailyBudget: 40, channelType: 'SEARCH' }),
    ];
    const suggestions = generateBudgetRebalance(budgets);
    const generalSuggestion = suggestions.find(s => s.campaignName.includes('General'));
    const newSuggestion = suggestions.find(s => s.campaignName.includes('F-150'));
    if (generalSuggestion && newSuggestion) {
      // General should get a bigger cut than specific model campaigns
      const generalCut = generalSuggestion.currentBudget - generalSuggestion.recommendedBudget;
      const newCut = newSuggestion.currentBudget - newSuggestion.recommendedBudget;
      expect(generalCut).toBeGreaterThanOrEqual(newCut);
    }
  });

  test('returns empty when budgets are already balanced', () => {
    const budgets = [
      makeDedicatedBudget({ campaignName: 'PMax: VLA Ads - New', dailyBudget: 45 }),
      makeDedicatedBudget({ campaignId: '200', campaignName: 'Springfield Ford - New - F-150', dailyBudget: 55, channelType: 'SEARCH' }),
    ];
    const suggestions = generateBudgetRebalance(budgets);
    expect(suggestions.length).toBe(0);
  });

  test('handles single-campaign accounts', () => {
    const budgets = [
      makeDedicatedBudget({ campaignName: 'PMax: VLA Ads - New', dailyBudget: 100 }),
    ];
    const suggestions = generateBudgetRebalance(budgets);
    expect(suggestions.length).toBe(0); // Nothing to rebalance with one campaign
  });

  test('handles empty budget list', () => {
    expect(generateBudgetRebalance([])).toEqual([]);
  });
});
