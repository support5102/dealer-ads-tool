/**
 * Unit tests for budget-recommender — generates budget adjustment
 * recommendations from pacing state, spend, and inventory data.
 *
 * Tier 2 (unit): pure logic, no external deps.
 */

const {
  generateRecommendation,
  calculateBudgetAdjustments,
  summarizeImpressionShare,
  statusToColor,
} = require('../../src/services/budget-recommender');

// Flat weights for predictable math in tests
const FLAT_WEIGHTS = [1, 1, 1, 1, 1, 1, 1];

// ===========================================================================
// statusToColor
// ===========================================================================

describe('statusToColor', () => {
  test('on_pace → green', () => {
    expect(statusToColor('on_pace')).toBe('green');
  });

  test('over → yellow', () => {
    expect(statusToColor('over')).toBe('yellow');
  });

  test('under → yellow', () => {
    expect(statusToColor('under')).toBe('yellow');
  });

  test('critical_over → red', () => {
    expect(statusToColor('critical_over')).toBe('red');
  });

  test('critical_under → red', () => {
    expect(statusToColor('critical_under')).toBe('red');
  });

  test('unknown status → gray', () => {
    expect(statusToColor('unknown')).toBe('gray');
  });
});

// ===========================================================================
// summarizeImpressionShare
// ===========================================================================

describe('summarizeImpressionShare', () => {
  test('computes averages across campaigns', () => {
    const data = [
      { campaignId: '1', campaignName: 'Camp A', impressionShare: 0.80, budgetLostShare: 0.10 },
      { campaignId: '2', campaignName: 'Camp B', impressionShare: 0.60, budgetLostShare: 0.30 },
    ];
    const summary = summarizeImpressionShare(data);

    expect(summary.avgImpressionShare).toBeCloseTo(0.70, 2);
    expect(summary.avgBudgetLostShare).toBeCloseTo(0.20, 2);
  });

  test('identifies budget-limited campaigns (budgetLostShare > 10%)', () => {
    const data = [
      { campaignId: '1', campaignName: 'Limited', impressionShare: 0.60, budgetLostShare: 0.25 },
      { campaignId: '2', campaignName: 'Not Limited', impressionShare: 0.90, budgetLostShare: 0.05 },
    ];
    const summary = summarizeImpressionShare(data);

    expect(summary.limitedCampaigns).toEqual(['Limited']);
  });

  test('returns empty summary for no data', () => {
    const summary = summarizeImpressionShare([]);

    expect(summary.avgImpressionShare).toBeNull();
    expect(summary.avgBudgetLostShare).toBeNull();
    expect(summary.limitedCampaigns).toEqual([]);
  });

  test('handles null impression share values', () => {
    const data = [
      { campaignId: '1', campaignName: 'A', impressionShare: null, budgetLostShare: null },
      { campaignId: '2', campaignName: 'B', impressionShare: 0.80, budgetLostShare: 0.10 },
    ];
    const summary = summarizeImpressionShare(data);

    // Should only average non-null values
    expect(summary.avgImpressionShare).toBeCloseTo(0.80, 2);
    expect(summary.avgBudgetLostShare).toBeCloseTo(0.10, 2);
  });

  test('all null values returns null averages', () => {
    const data = [
      { campaignId: '1', campaignName: 'A', impressionShare: null, budgetLostShare: null },
    ];
    const summary = summarizeImpressionShare(data);
    expect(summary.avgImpressionShare).toBeNull();
    expect(summary.avgBudgetLostShare).toBeNull();
  });
});

// ===========================================================================
// calculateBudgetAdjustments
// ===========================================================================

describe('calculateBudgetAdjustments', () => {
  test('recommends increase when under-pacing', () => {
    const pacing = {
      paceStatus: 'under',
      requiredDailyRate: 600,
      dailyAvgSpend: 400,
      daysRemaining: 15,
      remainingBudget: 9000,
    };
    const sharedBudgets = [
      { resourceName: 'r/1', name: 'Budget A', dailyBudget: 300, campaigns: [{ campaignId: '1', campaignName: 'C1' }] },
      { resourceName: 'r/2', name: 'Budget B', dailyBudget: 100, campaigns: [{ campaignId: '2', campaignName: 'C2' }] },
    ];

    const adjustments = calculateBudgetAdjustments(pacing, sharedBudgets);

    expect(adjustments).toHaveLength(2);
    // Both should increase proportionally
    expect(adjustments[0].recommendedDailyBudget).toBeGreaterThan(300);
    expect(adjustments[1].recommendedDailyBudget).toBeGreaterThan(100);
    expect(adjustments[0].change).toBeGreaterThan(0);
    expect(adjustments[1].change).toBeGreaterThan(0);
    expect(adjustments[0].type).toBe('shared_budget');
  });

  test('recommends decrease when over-pacing', () => {
    const pacing = {
      paceStatus: 'over',
      requiredDailyRate: 300,
      dailyAvgSpend: 600,
      daysRemaining: 15,
      remainingBudget: 4500,
    };
    const sharedBudgets = [
      { resourceName: 'r/1', name: 'Budget A', dailyBudget: 400, campaigns: [{ campaignId: '1', campaignName: 'C1' }] },
      { resourceName: 'r/2', name: 'Budget B', dailyBudget: 200, campaigns: [{ campaignId: '2', campaignName: 'C2' }] },
    ];

    const adjustments = calculateBudgetAdjustments(pacing, sharedBudgets);

    expect(adjustments).toHaveLength(2);
    expect(adjustments[0].recommendedDailyBudget).toBeLessThan(400);
    expect(adjustments[1].recommendedDailyBudget).toBeLessThan(200);
    expect(adjustments[0].change).toBeLessThan(0);
  });

  test('returns no adjustments when on_pace', () => {
    const pacing = {
      paceStatus: 'on_pace',
      requiredDailyRate: 500,
      dailyAvgSpend: 500,
      daysRemaining: 15,
      remainingBudget: 7500,
    };
    const sharedBudgets = [
      { resourceName: 'r/1', name: 'Budget A', dailyBudget: 500, campaigns: [] },
    ];

    const adjustments = calculateBudgetAdjustments(pacing, sharedBudgets);
    expect(adjustments).toHaveLength(0);
  });

  test('returns empty array when no shared budgets', () => {
    const pacing = {
      paceStatus: 'under',
      requiredDailyRate: 600,
      dailyAvgSpend: 400,
      daysRemaining: 15,
      remainingBudget: 9000,
    };

    const adjustments = calculateBudgetAdjustments(pacing, []);
    expect(adjustments).toHaveLength(0);
  });

  test('enforces minimum daily budget of $1', () => {
    const pacing = {
      paceStatus: 'critical_over',
      requiredDailyRate: 5,
      dailyAvgSpend: 500,
      daysRemaining: 15,
      remainingBudget: 75,
    };
    const sharedBudgets = [
      { resourceName: 'r/1', name: 'Budget A', dailyBudget: 300, campaigns: [] },
      { resourceName: 'r/2', name: 'Budget B', dailyBudget: 200, campaigns: [] },
    ];

    const adjustments = calculateBudgetAdjustments(pacing, sharedBudgets);
    adjustments.forEach(adj => {
      expect(adj.recommendedDailyBudget).toBeGreaterThanOrEqual(1);
    });
  });

  test('distributes adjustment proportionally to budget size', () => {
    const pacing = {
      paceStatus: 'under',
      requiredDailyRate: 1000,
      dailyAvgSpend: 500,
      daysRemaining: 10,
      remainingBudget: 10000,
    };
    const sharedBudgets = [
      { resourceName: 'r/1', name: 'Big', dailyBudget: 400, campaigns: [] },
      { resourceName: 'r/2', name: 'Small', dailyBudget: 100, campaigns: [] },
    ];

    const adjustments = calculateBudgetAdjustments(pacing, sharedBudgets);

    // Big budget should get larger absolute increase
    const bigChange = adjustments.find(a => a.target === 'Big').change;
    const smallChange = adjustments.find(a => a.target === 'Small').change;
    expect(bigChange).toBeGreaterThan(smallChange);
    // But same ratio
    expect(adjustments[0].recommendedDailyBudget / 400).toBeCloseTo(
      adjustments[1].recommendedDailyBudget / 100, 1
    );
  });

  test('handles critical_under same as under (increase)', () => {
    const pacing = {
      paceStatus: 'critical_under',
      requiredDailyRate: 800,
      dailyAvgSpend: 300,
      daysRemaining: 10,
      remainingBudget: 8000,
    };
    const sharedBudgets = [
      { resourceName: 'r/1', name: 'Budget A', dailyBudget: 300, campaigns: [] },
    ];

    const adjustments = calculateBudgetAdjustments(pacing, sharedBudgets);
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].recommendedDailyBudget).toBeGreaterThan(300);
  });

  test('handles critical_over same as over (decrease)', () => {
    const pacing = {
      paceStatus: 'critical_over',
      requiredDailyRate: 200,
      dailyAvgSpend: 800,
      daysRemaining: 10,
      remainingBudget: 2000,
    };
    const sharedBudgets = [
      { resourceName: 'r/1', name: 'Budget A', dailyBudget: 500, campaigns: [] },
    ];

    const adjustments = calculateBudgetAdjustments(pacing, sharedBudgets);
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].recommendedDailyBudget).toBeLessThan(500);
  });

  test('includes reason text in each adjustment', () => {
    const pacing = {
      paceStatus: 'under',
      requiredDailyRate: 600,
      dailyAvgSpend: 400,
      daysRemaining: 15,
      remainingBudget: 9000,
    };
    const sharedBudgets = [
      { resourceName: 'r/1', name: 'Budget A', dailyBudget: 400, campaigns: [] },
    ];

    const adjustments = calculateBudgetAdjustments(pacing, sharedBudgets);
    expect(adjustments[0].reason).toBeTruthy();
    expect(typeof adjustments[0].reason).toBe('string');
  });

  test('rounds recommended budget to 2 decimal places', () => {
    const pacing = {
      paceStatus: 'under',
      requiredDailyRate: 333.33,
      dailyAvgSpend: 200,
      daysRemaining: 15,
      remainingBudget: 5000,
    };
    const sharedBudgets = [
      { resourceName: 'r/1', name: 'Budget A', dailyBudget: 200, campaigns: [] },
    ];

    const adjustments = calculateBudgetAdjustments(pacing, sharedBudgets);
    const decimals = String(adjustments[0].recommendedDailyBudget).split('.')[1] || '';
    expect(decimals.length).toBeLessThanOrEqual(2);
  });

  test('handles zero daysRemaining (last day of month)', () => {
    const pacing = {
      paceStatus: 'under',
      requiredDailyRate: 0,
      dailyAvgSpend: 400,
      daysRemaining: 0,
      remainingBudget: 0,
    };
    const sharedBudgets = [
      { resourceName: 'r/1', name: 'Budget A', dailyBudget: 400, campaigns: [] },
    ];

    // No adjustments possible on last day
    const adjustments = calculateBudgetAdjustments(pacing, sharedBudgets);
    expect(adjustments).toHaveLength(0);
  });

  test('handles zero total daily budget', () => {
    const pacing = {
      paceStatus: 'under',
      requiredDailyRate: 500,
      dailyAvgSpend: 0,
      daysRemaining: 15,
      remainingBudget: 7500,
    };
    const sharedBudgets = [
      { resourceName: 'r/1', name: 'Budget A', dailyBudget: 0, campaigns: [] },
    ];

    const adjustments = calculateBudgetAdjustments(pacing, sharedBudgets);
    // Can't proportionally distribute with zero base, should still produce recommendation
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].recommendedDailyBudget).toBeGreaterThan(0);
  });
});

// ===========================================================================
// generateRecommendation
// ===========================================================================

describe('generateRecommendation', () => {
  const baseParams = {
    goal: {
      dealerName: 'Honda of Springfield',
      monthlyBudget: 15000,
    },
    campaignSpend: [
      { campaignId: '100', campaignName: 'Honda Civic - Search', status: 'ENABLED', spend: 3000 },
      { campaignId: '200', campaignName: 'Honda VLA', status: 'ENABLED', spend: 2000 },
    ],
    sharedBudgets: [
      { resourceName: 'r/1', name: 'Shared Budget - Honda', dailyBudget: 500, campaigns: [
        { campaignId: '100', campaignName: 'Honda Civic - Search' },
      ]},
    ],
    impressionShare: [
      { campaignId: '100', campaignName: 'Honda Civic - Search', impressionShare: 0.85, budgetLostShare: 0.10 },
    ],
    inventoryCount: 200,
    year: 2026,
    month: 3,
    currentDay: 15,
    dayWeights: FLAT_WEIGHTS,
  };

  test('produces complete recommendation object', () => {
    const rec = generateRecommendation(baseParams);

    expect(rec.dealerName).toBe('Honda of Springfield');
    expect(rec.totalSpend).toBe(5000);
    expect(rec.pacing).toBeDefined();
    expect(rec.pacing.monthlyBudget).toBe(15000);
    expect(rec.pacing.spendToDate).toBe(5000);
    expect(rec.status).toBeDefined();
    expect(rec.statusColor).toBeDefined();
    expect(rec.recommendations).toBeDefined();
    expect(rec.impressionShareSummary).toBeDefined();
    expect(rec.inventory).toBeDefined();
  });

  test('sums campaign spend into totalSpend', () => {
    const rec = generateRecommendation(baseParams);
    expect(rec.totalSpend).toBe(5000);
  });

  test('passes inventory count to recommendation output', () => {
    const params = {
      ...baseParams,
      inventoryCount: 50,
    };
    const rec = generateRecommendation(params);

    // No baselineInventory in goal → modifier stays 1.0
    expect(rec.pacing.inventoryModifier).toBe(1.0);
    expect(rec.inventory.count).toBe(50);
    expect(rec.inventory.modifier).toBe(1.0);
  });

  test('handles null inventory gracefully', () => {
    const params = {
      ...baseParams,
      inventoryCount: null,
    };
    const rec = generateRecommendation(params);
    expect(rec.pacing.inventoryModifier).toBe(1.0);
    expect(rec.inventory.count).toBeNull();
  });

  test('includes impression share summary', () => {
    const rec = generateRecommendation(baseParams);
    expect(rec.impressionShareSummary.avgImpressionShare).toBeCloseTo(0.85, 2);
  });

  test('produces recommendations when off-pace', () => {
    // Day 15 of 31, spent only 2000 of 15000 → severely under-pacing
    const params = {
      ...baseParams,
      campaignSpend: [
        { campaignId: '100', campaignName: 'Honda Civic - Search', status: 'ENABLED', spend: 2000 },
      ],
    };
    const rec = generateRecommendation(params);
    expect(rec.status).toMatch(/under/);
    expect(rec.statusColor).toMatch(/yellow|red/);
    expect(rec.recommendations.length).toBeGreaterThan(0);
  });

  test('produces no recommendations when on pace', () => {
    // Day 15 of 31, spent ~7258 of 15000 → roughly on pace
    const params = {
      ...baseParams,
      campaignSpend: [
        { campaignId: '100', campaignName: 'Honda', status: 'ENABLED', spend: 7258 },
      ],
    };
    const rec = generateRecommendation(params);
    expect(rec.status).toBe('on_pace');
    expect(rec.statusColor).toBe('green');
    expect(rec.recommendations).toHaveLength(0);
  });

  test('handles empty campaign spend', () => {
    const params = {
      ...baseParams,
      campaignSpend: [],
    };
    const rec = generateRecommendation(params);
    expect(rec.totalSpend).toBe(0);
    expect(rec.status).toMatch(/under/);
  });

  test('handles empty shared budgets', () => {
    const params = {
      ...baseParams,
      sharedBudgets: [],
    };
    const rec = generateRecommendation(params);
    expect(rec.recommendations).toHaveLength(0);
  });

  test('handles empty impression share', () => {
    const params = {
      ...baseParams,
      impressionShare: [],
    };
    const rec = generateRecommendation(params);
    expect(rec.impressionShareSummary.avgImpressionShare).toBeNull();
  });

  test('handles null campaignSpend', () => {
    const params = {
      ...baseParams,
      campaignSpend: null,
    };
    const rec = generateRecommendation(params);
    expect(rec.totalSpend).toBe(0);
  });

  test('handles null sharedBudgets', () => {
    const params = {
      ...baseParams,
      sharedBudgets: null,
    };
    const rec = generateRecommendation(params);
    expect(rec.recommendations).toHaveLength(0);
  });

  test('handles null impressionShare', () => {
    const params = {
      ...baseParams,
      impressionShare: null,
    };
    const rec = generateRecommendation(params);
    expect(rec.impressionShareSummary.avgImpressionShare).toBeNull();
  });

  test('budget fully spent recommends $1 minimum', () => {
    // Day 15, already spent the full budget
    const params = {
      ...baseParams,
      campaignSpend: [
        { campaignId: '100', campaignName: 'Honda', status: 'ENABLED', spend: 15000 },
      ],
    };
    const rec = generateRecommendation(params);
    expect(rec.status).toMatch(/over/);
    rec.recommendations.forEach(r => {
      expect(r.recommendedDailyBudget).toBeGreaterThanOrEqual(1);
    });
  });
});
