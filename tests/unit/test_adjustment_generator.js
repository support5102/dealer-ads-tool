/**
 * Unit tests for adjustment-generator.js
 */

const {
  generateExecutableAdjustments,
  classifyAllBudgets,
  distributeByWeight,
  buildDailySpendMap,
} = require('../../src/services/adjustment-generator');
const { CAMPAIGN_TYPES } = require('../../src/services/campaign-classifier');

// Helpers
function makeDedicated(name, channelType, dailyBudget, campaignId) {
  return {
    campaignId: campaignId || '100',
    campaignName: name,
    channelType: channelType || 'SEARCH',
    resourceName: `customers/123/campaignBudgets/${campaignId || 100}`,
    dailyBudget,
    campaigns: [{ campaignId: campaignId || '100', campaignName: name }],
  };
}

function makeShared(name, dailyBudget, campaigns) {
  return {
    resourceName: `customers/123/campaignBudgets/shared-${name}`,
    name,
    dailyBudget,
    campaigns: campaigns || [{ campaignId: '200', campaignName: name }],
  };
}

function makePacing(overrides = {}) {
  return {
    daysInMonth: 31, daysElapsed: 20, daysRemaining: 11,
    monthlyBudget: 15000, remainingBudget: 5000,
    spendToDate: 10000,
    dailyAvgSpend: 500, idealDailyRate: 484, requiredDailyRate: 454.5,
    pacePercent: 3.2, paceStatus: 'on_pace',
    ...overrides,
  };
}

describe('classifyAllBudgets', () => {
  const inventory = { civic: 40, accord: 5 };
  const shares = { civic: 40 / 45, accord: 5 / 45 };

  test('classifies dedicated VLA budgets', () => {
    const dedicated = [makeDedicated('Honda Civic VLA', 'SHOPPING', 100, '101')];
    const result = classifyAllBudgets(dedicated, [], new Map(), shares, true);
    expect(result).toHaveLength(1);
    expect(result[0].campaignType).toBe(CAMPAIGN_TYPES.VLA);
    expect(result[0].model).toBe('civic');
    expect(result[0].isShared).toBe(false);
  });

  test('classifies shared budgets by highest-priority campaign', () => {
    const shared = [makeShared('Honda Budget', 200, [
      { campaignId: '201', campaignName: 'Honda Brand' },
      { campaignId: '202', campaignName: 'Honda General' },
    ])];
    const result = classifyAllBudgets([], shared, new Map(), {}, true);
    expect(result).toHaveLength(1);
    expect(result[0].campaignType).toBe(CAMPAIGN_TYPES.BRAND); // brand > general
    expect(result[0].isShared).toBe(true);
  });

  test('uses spend map for current daily spend', () => {
    const dedicated = [makeDedicated('Honda Civic VLA', 'SHOPPING', 100, '101')];
    const spendMap = new Map([['101', 150]]);
    const result = classifyAllBudgets(dedicated, [], spendMap, {}, true);
    expect(result[0].currentDailySpend).toBe(150);
  });

  test('falls back to budget setting when no spend data', () => {
    const dedicated = [makeDedicated('Honda Civic VLA', 'SHOPPING', 100, '101')];
    const result = classifyAllBudgets(dedicated, [], new Map(), {}, true);
    expect(result[0].currentDailySpend).toBe(100);
  });
});

describe('distributeByWeight', () => {
  test('distributes proportionally by weighted spend', () => {
    const classified = [
      { campaignType: 'vla', weight: 1.0, currentDailySpend: 200, currentBudgetSetting: 200,
        budgetType: 'campaign_budget', target: 'VLA Campaign', resourceName: 'r1',
        model: null, isShared: false, campaigns: [] },
      { campaignType: 'regional', weight: 1.0, currentDailySpend: 100, currentBudgetSetting: 100,
        budgetType: 'shared_budget', target: 'Regional Budget', resourceName: 'r2',
        model: null, isShared: true, campaigns: [] },
    ];

    // Need to add $90/day total. Equal weights, 2:1 spend ratio
    const result = distributeByWeight(classified, 90, true, new Map());
    expect(result).toHaveLength(2);

    // VLA: 200/(200+100) = 66.7% of $90 = $60
    // Regional: 100/(200+100) = 33.3% of $90 = $30
    expect(result[0].change).toBeCloseTo(60, 0);
    expect(result[1].change).toBeCloseTo(30, 0);
  });

  test('higher weight gets larger share of change', () => {
    const classified = [
      { campaignType: 'vla', weight: 1.0, currentDailySpend: 100, currentBudgetSetting: 100,
        budgetType: 'campaign_budget', target: 'VLA', resourceName: 'r1',
        model: null, isShared: false, campaigns: [] },
      { campaignType: 'regional', weight: 0.1, currentDailySpend: 100, currentBudgetSetting: 100,
        budgetType: 'shared_budget', target: 'Regional', resourceName: 'r2',
        model: null, isShared: true, campaigns: [] },
    ];

    const result = distributeByWeight(classified, 100, true, new Map());

    // VLA weighted: 100 * 1.0 = 100. Regional weighted: 100 * 0.1 = 10. Total: 110.
    // VLA share: 100/110 = 90.9%, Regional: 10/110 = 9.1%
    expect(Math.abs(result[0].change)).toBeGreaterThan(Math.abs(result[1].change));
    expect(result[0].change).toBeCloseTo(90.91, 0);
    expect(result[1].change).toBeCloseTo(9.09, 0);
  });

  test('over-pacing: cuts distributed by weight (high weight = bigger cut)', () => {
    const classified = [
      { campaignType: 'regional', weight: 1.0, currentDailySpend: 100, currentBudgetSetting: 100,
        budgetType: 'shared_budget', target: 'Regional', resourceName: 'r1',
        model: null, isShared: true, campaigns: [] },
      { campaignType: 'vla', weight: 0.15, currentDailySpend: 100, currentBudgetSetting: 100,
        budgetType: 'campaign_budget', target: 'VLA', resourceName: 'r2',
        model: null, isShared: false, campaigns: [] },
    ];

    // Need to cut $50/day total
    const result = distributeByWeight(classified, -50, false, new Map());

    // Regional (weight 1.0): 100*1.0/(100*1.0 + 100*0.15) = 87% of cut
    // VLA (weight 0.15): 100*0.15/(100*1.0 + 100*0.15) = 13% of cut
    expect(Math.abs(result[0].change)).toBeGreaterThan(Math.abs(result[1].change)); // regional cut more
    expect(result[0].change).toBeLessThan(0);
    expect(result[1].change).toBeLessThan(0);
  });

  test('never goes below $1/day floor (respects 30% max cut cap)', () => {
    const classified = [
      { campaignType: 'regional', weight: 1.0, currentDailySpend: 5, currentBudgetSetting: 5,
        budgetType: 'shared_budget', target: 'Regional', resourceName: 'r1',
        model: null, isShared: true, campaigns: [] },
    ];
    const result = distributeByWeight(classified, -100, false, new Map());
    // 30% max cut: $5 * 0.70 = $3.50 (capped before $1 floor applies)
    expect(result[0].recommendedDailyBudget).toBe(3.5);
  });

  test('returns empty for negligible change needed', () => {
    const classified = [
      { campaignType: 'vla', weight: 1.0, currentDailySpend: 100, currentBudgetSetting: 100,
        budgetType: 'campaign_budget', target: 'VLA', resourceName: 'r1',
        model: null, isShared: false, campaigns: [] },
    ];
    expect(distributeByWeight(classified, 0.5, true, new Map())).toEqual([]);
  });
});

describe('generateExecutableAdjustments', () => {
  test('produces adjustments with valid structure', () => {
    const result = generateExecutableAdjustments({
      customerId: '111-111-1111',
      dealerName: 'Test Dealer',
      pacing: makePacing({ remainingBudget: 5000, daysRemaining: 11 }),
      dedicatedBudgets: [
        makeDedicated('Honda Civic VLA', 'SHOPPING', 200, '101'),
        makeDedicated('Honda Brand', 'SEARCH', 50, '102'),
      ],
      sharedBudgets: [
        makeShared('Regional Budget', 100, [{ campaignId: '201', campaignName: 'Honda Regional' }]),
      ],
      campaignSpend: [
        { campaignId: '101', spend: 4000 },
        { campaignId: '102', spend: 1000 },
        { campaignId: '201', spend: 2000 },
      ],
      inventoryByModel: { civic: 40, accord: 5 },
      direction: 'under',
    });

    expect(result.adjustmentId).toMatch(/^adj-/);
    expect(result.customerId).toBe('111-111-1111');
    expect(result.dealerName).toBe('Test Dealer');
    expect(result.generatedAt).toBeDefined();
    expect(result.expiresAt).toBeDefined();
    expect(result.direction).toBe('under');
    expect(result.summary).toBeDefined();
    expect(result.summary.direction).toBe('under');
    expect(Array.isArray(result.adjustments)).toBe(true);
  });

  test('returns no adjustments at end of month', () => {
    const result = generateExecutableAdjustments({
      customerId: '111',
      dealerName: 'Test',
      pacing: makePacing({ daysRemaining: 0 }),
      direction: 'under',
    });
    expect(result.adjustments).toHaveLength(0);
  });

  test('expiry is 24 hours after generation', () => {
    const result = generateExecutableAdjustments({
      customerId: '111',
      dealerName: 'Test',
      pacing: makePacing(),
      dedicatedBudgets: [makeDedicated('Honda VLA', 'SHOPPING', 100, '101')],
      campaignSpend: [{ campaignId: '101', spend: 2000 }],
      direction: 'under',
    });
    const generated = new Date(result.generatedAt);
    const expires = new Date(result.expiresAt);
    expect(expires.getTime() - generated.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  test('VLA gets more budget than regional when under-pacing', () => {
    const result = generateExecutableAdjustments({
      customerId: '111',
      dealerName: 'Test',
      pacing: makePacing({ remainingBudget: 8000, daysRemaining: 11 }),
      dedicatedBudgets: [
        makeDedicated('Honda VLA', 'SHOPPING', 200, '101'),
      ],
      sharedBudgets: [
        makeShared('Regional Budget', 200, [{ campaignId: '201', campaignName: 'Regional Campaign' }]),
      ],
      campaignSpend: [
        { campaignId: '101', spend: 4000 },
        { campaignId: '201', spend: 4000 },
      ],
      inventoryByModel: {},
      direction: 'under',
    });

    const vla = result.adjustments.find(a => a.campaignType === CAMPAIGN_TYPES.VLA);
    const regional = result.adjustments.find(a => a.campaignType === CAMPAIGN_TYPES.REGIONAL);

    expect(vla).toBeDefined();
    expect(regional).toBeDefined();
    // VLA addition weight (1.0) > Regional addition weight (0.1)
    // With equal spend, VLA should get ~10x the change
    expect(Math.abs(vla.change)).toBeGreaterThan(Math.abs(regional.change));
  });

  test('regional gets bigger cut than VLA when over-pacing', () => {
    const result = generateExecutableAdjustments({
      customerId: '111',
      dealerName: 'Test',
      pacing: makePacing({ remainingBudget: 2000, daysRemaining: 11 }),
      dedicatedBudgets: [
        makeDedicated('Honda VLA', 'SHOPPING', 300, '101'),
      ],
      sharedBudgets: [
        makeShared('Regional Budget', 300, [{ campaignId: '201', campaignName: 'Regional Campaign' }]),
      ],
      campaignSpend: [
        { campaignId: '101', spend: 6000 },
        { campaignId: '201', spend: 6000 },
      ],
      inventoryByModel: {},
      direction: 'over',
    });

    const vla = result.adjustments.find(a => a.campaignType === CAMPAIGN_TYPES.VLA);
    const regional = result.adjustments.find(a => a.campaignType === CAMPAIGN_TYPES.REGIONAL);

    expect(vla).toBeDefined();
    expect(regional).toBeDefined();
    // Regional cut weight (1.0) > VLA cut weight (0.15)
    // Regional should absorb more of the cut
    expect(Math.abs(regional.change)).toBeGreaterThan(Math.abs(vla.change));
  });

  test('high inventory VLA gets more budget than low inventory VLA', () => {
    const result = generateExecutableAdjustments({
      customerId: '111',
      dealerName: 'Test',
      pacing: makePacing({ remainingBudget: 8000, daysRemaining: 11 }),
      dedicatedBudgets: [
        makeDedicated('Honda Civic VLA', 'SHOPPING', 100, '101'),
        makeDedicated('Honda Accord VLA', 'SHOPPING', 100, '102'),
      ],
      campaignSpend: [
        { campaignId: '101', spend: 2000 },
        { campaignId: '102', spend: 2000 },
      ],
      inventoryByModel: { civic: 40, accord: 5 },
      direction: 'under',
    });

    const civic = result.adjustments.find(a => a.model === 'civic');
    const accord = result.adjustments.find(a => a.model === 'accord');

    expect(civic).toBeDefined();
    expect(accord).toBeDefined();
    // Civic has 8x the inventory → should get much more budget
    expect(civic.change).toBeGreaterThan(accord.change);
  });
});

describe('buildDailySpendMap', () => {
  test('computes daily average from monthly spend', () => {
    const spend = [
      { campaignId: '101', spend: 3000 },
      { campaignId: '102', spend: 600 },
    ];
    const map = buildDailySpendMap(spend, 20);
    expect(map.get('101')).toBe(150);
    expect(map.get('102')).toBe(30);
  });

  test('handles empty input', () => {
    expect(buildDailySpendMap([], 20).size).toBe(0);
    expect(buildDailySpendMap(null, 20).size).toBe(0);
  });
});
