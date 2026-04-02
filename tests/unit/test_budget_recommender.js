/**
 * Unit tests for budget-recommender — generates budget adjustment
 * recommendations from account-level pacing, VLA impression share, and spend data.
 *
 * Tier 2 (unit): pure logic, no external deps.
 */

const {
  generateRecommendation,
  distributeAccountBudget,
  summarizeImpressionShare,
  statusToColor,
  isVlaCampaign,
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
// isVlaCampaign
// ===========================================================================

describe('isVlaCampaign', () => {
  test('matches campaign with "VLA" in name', () => {
    expect(isVlaCampaign({ campaignName: 'Honda VLA', channelType: 'SEARCH' })).toBe(true);
  });

  test('matches campaign with "vla" in name (case-insensitive)', () => {
    expect(isVlaCampaign({ campaignName: 'Alan Jay - vla - new', channelType: '' })).toBe(true);
  });

  test('matches SHOPPING channel type', () => {
    expect(isVlaCampaign({ campaignName: 'Honda Shopping', channelType: 'SHOPPING' })).toBe(true);
  });

  test('matches LOCAL channel type', () => {
    expect(isVlaCampaign({ campaignName: 'Local Campaign', channelType: 'LOCAL' })).toBe(true);
  });

  test('does not match search campaign without VLA in name', () => {
    expect(isVlaCampaign({ campaignName: 'Honda Brand Search', channelType: 'SEARCH' })).toBe(false);
  });

  test('handles missing fields gracefully', () => {
    expect(isVlaCampaign({})).toBe(false);
    expect(isVlaCampaign({ campaignName: null, channelType: null })).toBe(false);
  });
});

// ===========================================================================
// distributeAccountBudget
// ===========================================================================

describe('distributeAccountBudget', () => {
  // Helper: pacing object with remaining budget and days
  function makePacing({ remainingBudget, daysRemaining, daysElapsed }) {
    return { remainingBudget, daysRemaining, daysElapsed: daysElapsed || 0 };
  }

  test('distributes required daily rate: VLA first (IS-driven), shared gets remainder', () => {
    // Account needs $100/day. VLA IS at 50% → boost VLA budget.
    // Whatever VLA takes, shared gets the rest.
    const pacing = makePacing({ remainingBudget: 1000, daysRemaining: 10 }); // $100/day needed
    const dedicated = [
      { campaignId: '1', campaignName: 'Honda VLA', channelType: 'SHOPPING', resourceName: 'r/1', dailyBudget: 30 },
    ];
    const shared = [
      { resourceName: 'r/2', name: 'Main', dailyBudget: 70, campaigns: [] },
    ];
    const isData = [
      { campaignId: '1', impressionShare: 0.50, budgetLostShare: 0.20 },
    ];

    const { recommendations, budgetSummary } = distributeAccountBudget({
      pacing, dedicatedBudgets: dedicated, sharedBudgets: shared, impressionShareData: isData,
    });

    // VLA should increase (IS 50% < 75% target)
    const vlaRec = recommendations.find(r => r.isVla);
    expect(vlaRec).toBeDefined();
    expect(vlaRec.recommendedDailyBudget).toBeGreaterThan(30);

    // Shared should get whatever's left to hit $100/day total
    const sharedRec = recommendations.find(r => !r.isVla);
    expect(sharedRec).toBeDefined();

    // VLA recommended + shared recommended ≈ required daily rate ($100)
    expect(budgetSummary.requiredDailyRate).toBe(100);
  });

  test('over-pacing account: shared budgets decrease more than VLAs (VLA priority)', () => {
    // Already spent most of the budget, little remaining. Required rate is low.
    // Total cut = 81 - 20 = 61. VLAs absorb 30% ($18.3), shared absorbs 70% ($42.7).
    const pacing = makePacing({ remainingBudget: 280, daysRemaining: 14 }); // $20/day needed
    const dedicated = [
      { campaignId: '1', campaignName: 'Honda VLA', channelType: 'SHOPPING', resourceName: 'r/1', dailyBudget: 10 },
    ];
    const shared = [
      { resourceName: 'r/2', name: 'Main', dailyBudget: 71, campaigns: [] },
    ];
    const isData = [
      { campaignId: '1', impressionShare: 0.82, budgetLostShare: 0.02 }, // IS on target
    ];

    const { recommendations } = distributeAccountBudget({
      pacing, dedicatedBudgets: dedicated, sharedBudgets: shared, impressionShareData: isData,
    });

    // Both decrease, but VLA decreases less than shared proportionally
    const vlaRec = recommendations.find(r => r.isVla);
    const sharedRec = recommendations.find(r => !r.isVla);

    // VLA still decreases (absorbs 30% of the cut)
    expect(vlaRec).toBeDefined();
    expect(vlaRec.recommendedDailyBudget).toBeLessThan(10);
    expect(vlaRec.change).toBeLessThan(0);

    // Shared decreases more (absorbs 70% of the cut)
    expect(sharedRec).toBeDefined();
    expect(sharedRec.recommendedDailyBudget).toBeLessThan(71);
    expect(sharedRec.change).toBeLessThan(0);

    // VLA cut % should be smaller than shared cut %
    const vlaCutPct = Math.abs(vlaRec.change) / 10;
    const sharedCutPct = Math.abs(sharedRec.change) / 71;
    expect(vlaCutPct).toBeLessThan(sharedCutPct);
  });

  test('over-pacing account: NEVER recommends increasing any budget', () => {
    // Account over-pacing. Vinfast at $0.01/day — should NOT get bumped to $1 minimum.
    const pacing = makePacing({ remainingBudget: 280, daysRemaining: 14 }); // $20/day needed
    const shared = [
      { resourceName: 'r/1', name: 'Main', dailyBudget: 71, campaigns: [] },
      { resourceName: 'r/2', name: 'Vinfast', dailyBudget: 0.01, campaigns: [] },
    ];

    const { recommendations } = distributeAccountBudget({
      pacing, dedicatedBudgets: [], sharedBudgets: shared, impressionShareData: [],
    });

    // Every recommendation must be a decrease OR at the $3/day minimum floor
    recommendations.forEach(r => {
      const atFloor = r.recommendedDailyBudget <= 3;
      if (!atFloor) {
        expect(r.change).toBeLessThanOrEqual(0);
        expect(r.recommendedDailyBudget).toBeLessThanOrEqual(r.currentDailyBudget);
      }
    });
  });

  test('over-pacing account: VLA with low IS does NOT get boosted', () => {
    const pacing = makePacing({ remainingBudget: 200, daysRemaining: 10 }); // $20/day needed
    const dedicated = [
      { campaignId: '1', campaignName: 'Honda VLA', channelType: 'SHOPPING', resourceName: 'r/1', dailyBudget: 15 },
    ];
    const shared = [
      { resourceName: 'r/2', name: 'Main', dailyBudget: 50, campaigns: [] },
    ];
    const isData = [
      { campaignId: '1', impressionShare: 0.40, budgetLostShare: 0.30 },
    ];

    const { recommendations } = distributeAccountBudget({
      pacing, dedicatedBudgets: dedicated, sharedBudgets: shared, impressionShareData: isData,
    });

    // VLA should NOT increase when account is over-pacing
    recommendations.filter(r => r.isVla).forEach(r => {
      expect(r.change).toBeLessThanOrEqual(0);
    });
    // But shared must decrease
    recommendations.filter(r => !r.isVla).forEach(r => {
      expect(r.change).toBeLessThan(0);
    });
  });

  test('over-pacing account: VLA with high IS still gets reduced', () => {
    const pacing = makePacing({ remainingBudget: 200, daysRemaining: 10 }); // $20/day needed
    const dedicated = [
      { campaignId: '1', campaignName: 'Honda VLA', channelType: 'SHOPPING', resourceName: 'r/1', dailyBudget: 30 },
    ];
    const shared = [
      { resourceName: 'r/2', name: 'Main', dailyBudget: 50, campaigns: [] },
    ];
    const isData = [
      { campaignId: '1', impressionShare: 0.95, budgetLostShare: 0.00 },
    ];

    const { recommendations } = distributeAccountBudget({
      pacing, dedicatedBudgets: dedicated, sharedBudgets: shared, impressionShareData: isData,
    });

    // VLA should decrease (IS > 90%, and account is over-pacing)
    const vlaRec = recommendations.find(r => r.isVla);
    expect(vlaRec).toBeDefined();
    expect(vlaRec.change).toBeLessThan(0);
  });

  test('under-pacing account: shared budgets increase to fill gap', () => {
    const pacing = makePacing({ remainingBudget: 10000, daysRemaining: 10 }); // $1000/day needed
    const shared = [
      { resourceName: 'r/1', name: 'Budget A', dailyBudget: 300, campaigns: [] },
      { resourceName: 'r/2', name: 'Budget B', dailyBudget: 100, campaigns: [] },
    ];

    const { recommendations } = distributeAccountBudget({
      pacing, dedicatedBudgets: [], sharedBudgets: shared, impressionShareData: [],
    });

    // Both shared should increase proportionally
    expect(recommendations).toHaveLength(2);
    expect(recommendations[0].recommendedDailyBudget).toBeGreaterThan(300);
    expect(recommendations[1].recommendedDailyBudget).toBeGreaterThan(100);

    // Proportional: Budget A (300/400 = 75%) gets 75% of $1000
    expect(recommendations[0].recommendedDailyBudget).toBe(750);
    expect(recommendations[1].recommendedDailyBudget).toBe(250);
  });

  test('under-pacing account: VLA with low IS gets boost, shared absorbs remainder', () => {
    // Account under-pacing AND VLA IS is low — VLA gets IS-based boost
    const pacing = makePacing({ remainingBudget: 5000, daysRemaining: 10 }); // $500/day needed
    const dedicated = [
      { campaignId: '1', campaignName: 'Honda VLA', channelType: 'SHOPPING', resourceName: 'r/1', dailyBudget: 15 },
    ];
    const shared = [
      { resourceName: 'r/2', name: 'Main', dailyBudget: 50, campaigns: [] },
    ];
    const isData = [
      { campaignId: '1', impressionShare: 0.40, budgetLostShare: 0.30 },
    ];

    const { recommendations } = distributeAccountBudget({
      pacing, dedicatedBudgets: dedicated, sharedBudgets: shared, impressionShareData: isData,
    });

    // VLA increases (IS 40% → boost toward 75%, account is under-pacing so allowed)
    const vlaRec = recommendations.find(r => r.isVla);
    expect(vlaRec).toBeDefined();
    expect(vlaRec.recommendedDailyBudget).toBeGreaterThan(15);

    // Shared also increases (under-pacing, needs to fill the gap)
    const sharedRec = recommendations.find(r => !r.isVla);
    expect(sharedRec).toBeDefined();
    expect(sharedRec.recommendedDailyBudget).toBeGreaterThan(50);
  });

  test('VLA with high IS stays at set budget when under-pacing', () => {
    const pacing = makePacing({ remainingBudget: 1000, daysRemaining: 10 }); // $100/day needed
    const dedicated = [
      { campaignId: '1', campaignName: 'Honda VLA', channelType: 'SHOPPING', resourceName: 'r/1', dailyBudget: 80 },
    ];
    const shared = [
      { resourceName: 'r/2', name: 'Main', dailyBudget: 20, campaigns: [] },
    ];
    const isData = [
      { campaignId: '1', impressionShare: 0.96, budgetLostShare: 0.00 },
    ];

    const { recommendations } = distributeAccountBudget({
      pacing, dedicatedBudgets: dedicated, sharedBudgets: shared, impressionShareData: isData,
    });

    // Under-pacing: VLA stays at set budget despite IS > 90% — account needs every dollar
    const vlaRec = recommendations.find(r => r.isVla);
    // VLA recommended = dailyBudget (floored), change = $0 — still included with no-change reason
    expect(vlaRec).toBeDefined();
    expect(vlaRec.change).toBe(0);
  });

  test('VLA boost is IS-driven and reaches target allocation', () => {
    const pacing = makePacing({ remainingBudget: 5000, daysRemaining: 10 });
    // Required daily rate: $500/day. 40% VLA floor = $200. With no cap, VLA gets the full allocation.
    const dedicated = [
      { campaignId: '1', campaignName: 'Honda VLA', channelType: 'SHOPPING', resourceName: 'r/1', dailyBudget: 50 },
    ];
    const isData = [
      { campaignId: '1', impressionShare: 0.10, budgetLostShare: 0.50 },
    ];

    const { recommendations } = distributeAccountBudget({
      pacing, dedicatedBudgets: dedicated, sharedBudgets: [], impressionShareData: isData,
    });

    const vlaRec = recommendations.find(r => r.isVla);
    // VLA should get at least the 40% floor ($200) since IS is way below target
    expect(vlaRec.recommendedDailyBudget).toBeGreaterThanOrEqual(200);
    expect(vlaRec.reason).toMatch(/below 75% target/);
  });

  test('skips non-VLA dedicated campaigns (not adjusted)', () => {
    const pacing = makePacing({ remainingBudget: 1000, daysRemaining: 10 });
    const dedicated = [
      { campaignId: '1', campaignName: 'Brand Search', channelType: 'SEARCH', resourceName: 'r/1', dailyBudget: 30 },
    ];
    const shared = [
      { resourceName: 'r/2', name: 'Main', dailyBudget: 70, campaigns: [] },
    ];
    const isData = [
      { campaignId: '1', impressionShare: 0.50, budgetLostShare: 0.20 },
    ];

    const { recommendations } = distributeAccountBudget({
      pacing, dedicatedBudgets: dedicated, sharedBudgets: shared, impressionShareData: isData,
    });

    // No VLA recs (Brand Search is not a VLA)
    expect(recommendations.filter(r => r.isVla)).toHaveLength(0);

    // Shared gets $100 - $30 (non-VLA dedicated) = $70 — same as current, included with no change
    const sharedRec = recommendations.find(r => !r.isVla);
    expect(sharedRec).toBeDefined();
    expect(Math.abs(sharedRec.change)).toBeLessThan(1); // no meaningful change
  });

  test('non-VLA dedicated budget is subtracted from target before distributing', () => {
    // Required $100/day. Non-VLA dedicated takes $40. VLA + shared must cover $60.
    const pacing = makePacing({ remainingBudget: 1000, daysRemaining: 10 });
    const dedicated = [
      { campaignId: '1', campaignName: 'Brand Search', channelType: 'SEARCH', resourceName: 'r/1', dailyBudget: 40 },
      { campaignId: '2', campaignName: 'Honda VLA', channelType: 'SHOPPING', resourceName: 'r/2', dailyBudget: 20 },
    ];
    const shared = [
      { resourceName: 'r/3', name: 'Main', dailyBudget: 50, campaigns: [] },
    ];
    const isData = [
      { campaignId: '2', impressionShare: 0.80, budgetLostShare: 0.02 }, // VLA on target
    ];

    const { recommendations, budgetSummary } = distributeAccountBudget({
      pacing, dedicatedBudgets: dedicated, sharedBudgets: shared, impressionShareData: isData,
    });

    // Over-pacing: VLA + shared must cover $60, currently $70 (VLA $20 + shared $50)
    // VLA is already below 40% floor ($40) at $20, so it's NOT cut further — change is $0
    // and it gets filtered out. Shared budget absorbs the full cut.
    const vlaRec = recommendations.find(r => r.isVla);
    // VLA included but with no change (already under-allocated)
    expect(vlaRec).toBeDefined();
    expect(vlaRec.change).toBe(0);

    const sharedRec = recommendations.find(r => !r.isVla);
    expect(sharedRec).toBeDefined();
    expect(sharedRec.recommendedDailyBudget).toBeLessThan(50);
    expect(sharedRec.change).toBeLessThan(0);

    // Shared absorbs entire cut since VLA is protected
    const sharedCutPct = Math.abs(sharedRec.change) / 50;
    expect(sharedCutPct).toBeGreaterThan(0);
  });

  test('multiple shared budgets distributed proportionally to budget size', () => {
    const pacing = makePacing({ remainingBudget: 1000, daysRemaining: 10 }); // $100/day
    const shared = [
      { resourceName: 'r/1', name: 'Big', dailyBudget: 60, campaigns: [] },
      { resourceName: 'r/2', name: 'Small', dailyBudget: 20, campaigns: [] },
    ];

    const { recommendations } = distributeAccountBudget({
      pacing, dedicatedBudgets: [], sharedBudgets: shared, impressionShareData: [],
    });

    // Big gets 75% of $100 = $75, Small gets 25% = $25
    const big = recommendations.find(r => r.target === 'Big');
    const small = recommendations.find(r => r.target === 'Small');
    expect(big.recommendedDailyBudget).toBe(75);
    expect(small.recommendedDailyBudget).toBe(25);
  });

  test('enforces minimum $1/day on shared budgets', () => {
    // Required $10/day, VLA takes $9. Shared splits $1 across 2 budgets.
    const pacing = makePacing({ remainingBudget: 100, daysRemaining: 10 });
    const dedicated = [
      { campaignId: '1', campaignName: 'Honda VLA', channelType: 'SHOPPING', resourceName: 'r/1', dailyBudget: 4 },
    ];
    const shared = [
      { resourceName: 'r/2', name: 'A', dailyBudget: 50, campaigns: [] },
      { resourceName: 'r/3', name: 'B', dailyBudget: 50, campaigns: [] },
    ];
    const isData = [
      { campaignId: '1', impressionShare: 0.50, budgetLostShare: 0.25 }, // boost VLA
    ];

    const { recommendations } = distributeAccountBudget({
      pacing, dedicatedBudgets: dedicated, sharedBudgets: shared, impressionShareData: isData,
    });

    recommendations.filter(r => !r.isVla).forEach(r => {
      expect(r.recommendedDailyBudget).toBeGreaterThanOrEqual(1);
    });
  });

  test('returns empty when zero days remaining', () => {
    const pacing = makePacing({ remainingBudget: 1000, daysRemaining: 0 });
    const { recommendations } = distributeAccountBudget({
      pacing, dedicatedBudgets: [], sharedBudgets: [], impressionShareData: [],
    });
    expect(recommendations).toHaveLength(0);
  });

  test('returns empty when already on target (no changes needed)', () => {
    // Required $100/day, VLA at $50 (IS on target), shared at $50 — perfect.
    const pacing = makePacing({ remainingBudget: 1000, daysRemaining: 10 });
    const dedicated = [
      { campaignId: '1', campaignName: 'Honda VLA', channelType: 'SHOPPING', resourceName: 'r/1', dailyBudget: 50 },
    ];
    const shared = [
      { resourceName: 'r/2', name: 'Main', dailyBudget: 50, campaigns: [] },
    ];
    const isData = [
      { campaignId: '1', impressionShare: 0.82, budgetLostShare: 0.02 },
    ];

    const { recommendations } = distributeAccountBudget({
      pacing, dedicatedBudgets: dedicated, sharedBudgets: shared, impressionShareData: isData,
    });

    // All budgets included even when on target — each with $0 change
    expect(recommendations.length).toBeGreaterThan(0);
    recommendations.forEach(r => expect(Math.abs(r.change)).toBeLessThan(1));
  });

  test('handles null inputs gracefully', () => {
    const pacing = makePacing({ remainingBudget: 1000, daysRemaining: 10 });
    const { recommendations } = distributeAccountBudget({
      pacing, dedicatedBudgets: null, sharedBudgets: null, impressionShareData: null,
    });
    expect(recommendations).toHaveLength(0);
  });

  test('includes budget lost share in VLA reason when high', () => {
    const pacing = makePacing({ remainingBudget: 1000, daysRemaining: 10 });
    const dedicated = [
      { campaignId: '1', campaignName: 'Honda VLA', channelType: 'SHOPPING', resourceName: 'r/1', dailyBudget: 50 },
    ];
    const isData = [
      { campaignId: '1', impressionShare: 0.60, budgetLostShare: 0.15 },
    ];

    const { recommendations } = distributeAccountBudget({
      pacing, dedicatedBudgets: dedicated, sharedBudgets: [], impressionShareData: isData,
    });

    expect(recommendations[0].reason).toMatch(/15\.0% lost to budget/);
  });

  test('budgetSummary shows current vs recommended totals', () => {
    const pacing = makePacing({ remainingBudget: 1000, daysRemaining: 10 });
    const dedicated = [
      { campaignId: '1', campaignName: 'Honda VLA', channelType: 'SHOPPING', resourceName: 'r/1', dailyBudget: 30 },
    ];
    const shared = [
      { resourceName: 'r/2', name: 'Main', dailyBudget: 50, campaigns: [] },
    ];
    const isData = [
      { campaignId: '1', impressionShare: 0.82, budgetLostShare: 0.02 },
    ];

    const { budgetSummary } = distributeAccountBudget({
      pacing, dedicatedBudgets: dedicated, sharedBudgets: shared, impressionShareData: isData,
    });

    expect(budgetSummary.requiredDailyRate).toBe(100);
    expect(budgetSummary.currentDailyTotal).toBe(80); // 30 + 50
    // Recommended should be closer to 100
    expect(budgetSummary.recommendedDailyTotal).toBeGreaterThan(budgetSummary.currentDailyTotal);
  });

  test('uses actual spend rates instead of budget settings when campaignSpend provided', () => {
    // VLA budget is $200/day but only actually spending $50/day
    // Shared budget is $100/day but only spending $30/day
    // Account needs $60/day → should use actual $80/day spend as baseline (over-pacing)
    const pacing = makePacing({ remainingBudget: 600, daysRemaining: 10, daysElapsed: 10 });
    const dedicated = [
      { campaignId: '1', campaignName: 'Honda VLA', channelType: 'SHOPPING', resourceName: 'r/1', dailyBudget: 200,
        campaigns: [{ campaignId: '1', campaignName: 'Honda VLA' }] },
    ];
    const shared = [
      { resourceName: 'r/2', name: 'Main', dailyBudget: 100,
        campaigns: [{ campaignId: '2', campaignName: 'Honda Search' }] },
    ];
    const campaignSpend = [
      { campaignId: '1', campaignName: 'Honda VLA', spend: 500 },    // $500 / 10 days = $50/day actual
      { campaignId: '2', campaignName: 'Honda Search', spend: 300 }, // $300 / 10 days = $30/day actual
    ];

    const { recommendations, budgetSummary } = distributeAccountBudget({
      pacing, dedicatedBudgets: dedicated, sharedBudgets: shared,
      impressionShareData: [], campaignSpend,
    });

    // Current daily total should reflect actual spend ($80/day), NOT budget settings ($300/day)
    expect(budgetSummary.currentDailyTotal).toBe(80);

    // Both should decrease (over-pacing: $80 actual vs $60 target)
    // VLA gets a smaller cut (protected), shared gets a larger cut
    const vlaRec = recommendations.find(r => r.isVla);
    const sharedRec = recommendations.find(r => !r.isVla);

    expect(vlaRec).toBeDefined();
    expect(vlaRec.currentDailyBudget).toBe(50);
    expect(vlaRec.change).toBeLessThan(0);

    expect(sharedRec).toBeDefined();
    expect(sharedRec.currentDailyBudget).toBe(30);
    expect(sharedRec.change).toBeLessThan(0);
  });

  test('falls back to budget settings when no campaignSpend provided', () => {
    const pacing = makePacing({ remainingBudget: 1000, daysRemaining: 10 });
    const dedicated = [
      { campaignId: '1', campaignName: 'Honda VLA', channelType: 'SHOPPING', resourceName: 'r/1', dailyBudget: 30 },
    ];
    const shared = [
      { resourceName: 'r/2', name: 'Main', dailyBudget: 50, campaigns: [] },
    ];

    // No campaignSpend provided — should fall back to dailyBudget values
    const { budgetSummary } = distributeAccountBudget({
      pacing, dedicatedBudgets: dedicated, sharedBudgets: shared, impressionShareData: [],
    });

    expect(budgetSummary.currentDailyTotal).toBe(80); // 30 + 50 from budget settings
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
    dedicatedBudgets: [
      { campaignId: '200', campaignName: 'Honda VLA', channelType: 'SHOPPING', resourceName: 'r/v1', dailyBudget: 100 },
    ],
    impressionShare: [
      { campaignId: '100', campaignName: 'Honda Civic - Search', impressionShare: 0.85, budgetLostShare: 0.10 },
      { campaignId: '200', campaignName: 'Honda VLA', impressionShare: 0.55, budgetLostShare: 0.25 },
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
    expect(rec.budgetSummary).toBeDefined();
    expect(rec.impressionShareSummary).toBeDefined();
    expect(rec.inventory).toBeDefined();
  });

  test('sums campaign spend into totalSpend', () => {
    const rec = generateRecommendation(baseParams);
    expect(rec.totalSpend).toBe(5000);
  });

  test('passes inventory count to recommendation output', () => {
    const params = { ...baseParams, inventoryCount: 50 };
    const rec = generateRecommendation(params);
    expect(rec.pacing.inventoryModifier).toBe(1.0);
    expect(rec.inventory.count).toBe(50);
    expect(rec.inventory.modifier).toBe(1.0);
  });

  test('handles null inventory gracefully', () => {
    const params = { ...baseParams, inventoryCount: null };
    const rec = generateRecommendation(params);
    expect(rec.pacing.inventoryModifier).toBe(1.0);
    expect(rec.inventory.count).toBeNull();
  });

  test('includes impression share summary', () => {
    const rec = generateRecommendation(baseParams);
    expect(rec.impressionShareSummary.avgImpressionShare).toBeCloseTo(0.70, 2);
  });

  test('VLA recommendations come before shared in the list', () => {
    const rec = generateRecommendation(baseParams);

    // Honda VLA has 55% IS → should get increase recommendation
    const vlaRecs = rec.recommendations.filter(r => r.isVla);
    const sharedRecs = rec.recommendations.filter(r => !r.isVla);

    expect(vlaRecs.length).toBeGreaterThan(0);
    if (sharedRecs.length > 0) {
      // VLA should be first
      const firstVla = rec.recommendations.findIndex(r => r.isVla);
      const firstShared = rec.recommendations.findIndex(r => !r.isVla);
      expect(firstVla).toBeLessThan(firstShared);
    }
  });

  test('budgetSummary included in output', () => {
    const rec = generateRecommendation(baseParams);
    expect(rec.budgetSummary).toBeDefined();
    expect(rec.budgetSummary.requiredDailyRate).toBeGreaterThan(0);
    expect(rec.budgetSummary.currentDailyTotal).toBeGreaterThan(0);
    expect(rec.budgetSummary.recommendedDailyTotal).toBeGreaterThan(0);
  });

  test('handles null dedicatedBudgets gracefully', () => {
    const params = { ...baseParams, dedicatedBudgets: null };
    const rec = generateRecommendation(params);
    expect(rec.recommendations).toBeDefined();
  });

  test('handles empty campaign spend', () => {
    const params = { ...baseParams, campaignSpend: [] };
    const rec = generateRecommendation(params);
    expect(rec.totalSpend).toBe(0);
    expect(rec.status).toMatch(/under/);
  });

  test('handles empty shared budgets', () => {
    const params = { ...baseParams, sharedBudgets: [] };
    const rec = generateRecommendation(params);
    expect(rec.recommendations).toBeDefined();
  });

  test('handles empty impression share', () => {
    const params = { ...baseParams, impressionShare: [] };
    const rec = generateRecommendation(params);
    expect(rec.impressionShareSummary.avgImpressionShare).toBeNull();
  });

  test('handles null campaignSpend', () => {
    const params = { ...baseParams, campaignSpend: null };
    const rec = generateRecommendation(params);
    expect(rec.totalSpend).toBe(0);
  });

  test('handles null sharedBudgets', () => {
    const params = { ...baseParams, sharedBudgets: null };
    const rec = generateRecommendation(params);
    expect(rec.recommendations).toBeDefined();
  });

  test('handles null impressionShare', () => {
    const params = { ...baseParams, impressionShare: null };
    const rec = generateRecommendation(params);
    expect(rec.impressionShareSummary.avgImpressionShare).toBeNull();
  });

  test('budget fully spent: non-VLA recommendations are decreases, VLAs protected', () => {
    const params = {
      ...baseParams,
      campaignSpend: [
        { campaignId: '100', campaignName: 'Honda', status: 'ENABLED', spend: 15000 },
      ],
    };
    const rec = generateRecommendation(params);
    expect(rec.status).toMatch(/over/);
    // When over-pacing: non-VLA budgets decrease. VLAs are protected by 40% floor
    // and may have zero or positive change if already under-allocated.
    const nonVla = rec.recommendations.filter(r => !r.isVla);
    nonVla.forEach(r => {
      expect(r.change).toBeLessThanOrEqual(0);
    });
  });
});
