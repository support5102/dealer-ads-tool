/**
 * Unit tests for recommender-v2.js — Phase 3 recommender core.
 *
 * Tests:
 *   - run() happy paths (overpacing, underpacing, on-pace/hold)
 *   - R1 direction invariant (critical)
 *   - R3 IS classifier
 *   - R4 shared-budget binding check
 *   - R5 campaign-weight reshaper
 *   - R7 rationale composer
 */

const {
  run,
  enforceDirectionInvariant,
  classifyByImpressionShare,
  checkSharedBudgetBinding,
  reshapeCampaignAllocation,
  composeRationale,
  IS_TARGETS,
} = require('../../src/services/recommender-v2');

// ── Shared test helpers ───────────────────────────────────────────────────────

/**
 * Returns a valid base params object for run(). Override specific fields as needed.
 */
function baseParams(overrides = {}) {
  return {
    goal: {
      dealerName: 'Test Dealer',
      monthlyBudget: 6000,
      pacingMode: 'advisory',
      pacingCurveId: 'linear',
    },
    campaignSpend: [
      { campaignId: '1', campaignName: 'Test Dealer Brand', status: 'ENABLED', spend: 300 },
      { campaignId: '2', campaignName: 'Test Dealer Regional', status: 'ENABLED', spend: 500 },
      { campaignId: '3', campaignName: 'Test Dealer VLA', status: 'ENABLED', spend: 700 },
    ],
    sharedBudgets: [],
    impressionShare: {},
    inventory: { newVinCount: 18, baselineRolling90Day: 22, tier: 'healthy' },
    currentDailyBudget: 213.33,   // ~$6000/28 days
    bidStrategyType: 'MAXIMIZE_CLICKS',
    lastChangeTimestamp: null,
    year: 2026,
    month: 4,    // April = 30 days
    currentDay: 21,  // 9 days remaining
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// run() — happy paths
// ─────────────────────────────────────────────────────────────────────────────

describe('run() — happy paths', () => {
  test('overpacing dealer: returns decrease recommendation', async () => {
    // Day 21 of April (30 days). Linear curve target at day 21 = 70% = $4200.
    // MTD spend = $4800 → significantly overpacing.
    const params = baseParams({
      goal: { dealerName: 'Overpacing Dealer', monthlyBudget: 6000, pacingMode: 'advisory', pacingCurveId: 'linear' },
      // Total spend sums to $4800
      campaignSpend: [
        { campaignId: '1', campaignName: 'Test Brand', status: 'ENABLED', spend: 1600 },
        { campaignId: '2', campaignName: 'Test Regional', status: 'ENABLED', spend: 1600 },
        { campaignId: '3', campaignName: 'Test VLA', status: 'ENABLED', spend: 1600 },
      ],
      currentDailyBudget: 213.33,
    });

    const result = await run(params);

    expect(result.dealerName).toBe('Overpacing Dealer');
    expect(result.source).toBe('pacing_engine_v2');
    expect(result.recommendation.direction).toBe('decrease');
    expect(result.recommendation.action).toBe('reduce_daily_budget');
    expect(result.recommendation.newDailyBudget).toBeLessThan(213.33);
    expect(result.recommendation.change).toBeLessThan(0);
    expect(result.pacing.pacePercent).toBeGreaterThan(100);
    expect(result.diagnostics).toEqual([]);
    expect(result.rationale).not.toHaveLength(0);
  });

  test('underpacing dealer: returns increase recommendation', async () => {
    // Day 21 of April. Linear curve target = $4200. MTD spend = $2800 → underpacing.
    const params = baseParams({
      goal: { dealerName: 'Underpacing Dealer', monthlyBudget: 6000, pacingMode: 'advisory', pacingCurveId: 'linear' },
      campaignSpend: [
        { campaignId: '1', campaignName: 'Test Brand', status: 'ENABLED', spend: 900 },
        { campaignId: '2', campaignName: 'Test Regional', status: 'ENABLED', spend: 900 },
        { campaignId: '3', campaignName: 'Test VLA', status: 'ENABLED', spend: 1000 },
      ],
      currentDailyBudget: 133.33,
    });

    const result = await run(params);

    expect(result.recommendation.direction).toBe('increase');
    expect(result.recommendation.action).toBe('increase_daily_budget');
    expect(result.recommendation.newDailyBudget).toBeGreaterThan(133.33);
    expect(result.recommendation.change).toBeGreaterThan(0);
    expect(result.pacing.pacePercent).toBeLessThan(100);
  });

  test('on-pace dealer (dead zone): returns hold', async () => {
    // Day 15 of April. Linear curve target = 50% = $3000. MTD spend = $3000 → exactly on pace.
    const params = baseParams({
      goal: { dealerName: 'On Pace Dealer', monthlyBudget: 6000, pacingMode: 'advisory', pacingCurveId: 'linear' },
      campaignSpend: [
        { campaignId: '1', campaignName: 'Test Brand', status: 'ENABLED', spend: 1000 },
        { campaignId: '2', campaignName: 'Test Regional', status: 'ENABLED', spend: 1000 },
        { campaignId: '3', campaignName: 'Test VLA', status: 'ENABLED', spend: 1000 },
      ],
      currentDailyBudget: 200,
      currentDay: 15,
    });

    const result = await run(params);

    expect(result.recommendation.action).toBe('hold');
    expect(result.recommendation.direction).toBe('hold');
    expect(result.recommendation.newDailyBudget).toBeNull();
  });

  test('result always has required output shape fields', async () => {
    const result = await run(baseParams());

    expect(result).toHaveProperty('dealerName');
    expect(result).toHaveProperty('pacing');
    expect(result).toHaveProperty('pacing.mtdSpend');
    expect(result).toHaveProperty('pacing.monthlyBudget');
    expect(result).toHaveProperty('pacing.curveTarget');
    expect(result).toHaveProperty('pacing.pacePercent');
    expect(result).toHaveProperty('pacing.curveId');
    expect(result).toHaveProperty('pacing.daysRemaining');
    expect(result).toHaveProperty('recommendation');
    expect(result).toHaveProperty('recommendation.action');
    expect(result).toHaveProperty('recommendation.direction');
    expect(result).toHaveProperty('recommendation.confidence');
    expect(result).toHaveProperty('rationale');
    expect(result).toHaveProperty('diagnostics');
    expect(result).toHaveProperty('clampedBy');
    expect(result).toHaveProperty('source', 'pacing_engine_v2');
    expect(Array.isArray(result.diagnostics)).toBe(true);
    expect(Array.isArray(result.rationale)).toBe(true);
  });

  test('inventory null when not provided', async () => {
    const params = baseParams({ inventory: null });
    const result = await run(params);
    expect(result.inventory).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R1 — Direction invariant (CRITICAL)
// ─────────────────────────────────────────────────────────────────────────────

describe('R1 — enforceDirectionInvariant()', () => {
  // Helper: build a fake "not skipped" AdjustmentResult
  function notSkipped(newDailyBudget, clampedBy = null) {
    return {
      skipped: false,
      reason: null,
      newDailyBudget,
      variance: null,
      curveTarget: null,
      clampedBy,
    };
  }

  function skipped(reason) {
    return {
      skipped: true,
      reason,
      newDailyBudget: null,
      variance: null,
      curveTarget: null,
      clampedBy: null,
    };
  }

  const currentDailyBudget = 100;

  test('overpacing + engine returns increase → enforced to hold', () => {
    const proposed = notSkipped(120);   // increase from $100 to $120
    const result = enforceDirectionInvariant({ variance: 0.10, proposed, currentDailyBudget });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('direction_invariant_overpacing');
    expect(result.newDailyBudget).toBeNull();
  });

  test('underpacing + engine returns decrease → enforced to hold', () => {
    const proposed = notSkipped(80);    // decrease from $100 to $80
    const result = enforceDirectionInvariant({ variance: -0.10, proposed, currentDailyBudget });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('direction_invariant_underpacing');
    expect(result.newDailyBudget).toBeNull();
  });

  test('overpacing + engine returns decrease → pass through (correct direction)', () => {
    const proposed = notSkipped(80);    // decrease from $100 to $80
    const result = enforceDirectionInvariant({ variance: 0.10, proposed, currentDailyBudget });
    expect(result.skipped).toBe(false);
    expect(result.newDailyBudget).toBe(80);
  });

  test('underpacing + engine returns increase → pass through (correct direction)', () => {
    const proposed = notSkipped(120);   // increase from $100 to $120
    const result = enforceDirectionInvariant({ variance: -0.10, proposed, currentDailyBudget });
    expect(result.skipped).toBe(false);
    expect(result.newDailyBudget).toBe(120);
  });

  test('on-pace (dead zone, already skipped) + any engine output → pass through', () => {
    const proposed = skipped('dead_zone:on_pace_within_2pct');
    const result = enforceDirectionInvariant({ variance: 0.005, proposed, currentDailyBudget });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('dead_zone:on_pace_within_2pct');
  });

  test('zero variance + engine returns same budget → pass through', () => {
    const proposed = notSkipped(100);   // no change
    const result = enforceDirectionInvariant({ variance: 0, proposed, currentDailyBudget });
    expect(result.skipped).toBe(false);
    expect(result.newDailyBudget).toBe(100);
  });

  test('overpacing + engine returns exact same budget (no change) → pass through', () => {
    const proposed = notSkipped(100);   // no change — neither increase nor decrease
    const result = enforceDirectionInvariant({ variance: 0.10, proposed, currentDailyBudget });
    // Not strictly an increase (100 == 100), so should pass through
    expect(result.skipped).toBe(false);
    expect(result.newDailyBudget).toBe(100);
  });

  test('underpacing + engine returns exact same budget (no change) → pass through', () => {
    const proposed = notSkipped(100);   // no change
    const result = enforceDirectionInvariant({ variance: -0.10, proposed, currentDailyBudget });
    expect(result.skipped).toBe(false);
    expect(result.newDailyBudget).toBe(100);
  });

  test('skipped proposal always passes through regardless of variance', () => {
    // Already-skipped proposals don't need direction enforcement
    const proposal = skipped('cooldown:24h_recent_change');
    const resultOver = enforceDirectionInvariant({ variance: 0.15, proposed: proposal, currentDailyBudget });
    const resultUnder = enforceDirectionInvariant({ variance: -0.15, proposed: proposal, currentDailyBudget });
    expect(resultOver.reason).toBe('cooldown:24h_recent_change');
    expect(resultUnder.reason).toBe('cooldown:24h_recent_change');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R3 — IS target classifier
// ─────────────────────────────────────────────────────────────────────────────

describe('R3 — classifyByImpressionShare()', () => {
  function campaign(id, name) {
    return { campaignId: String(id), campaignName: name };
  }

  test('brand at 95% IS → in_band (target ≥ 90)', () => {
    const campaigns = [campaign('1', 'Alan Jay Ford Brand')];
    const impressionShare = { '1': { is: 95 } };
    const results = classifyByImpressionShare({ campaigns, impressionShare });
    expect(results[0].status).toBe('in_band');
    expect(results[0].type).toBe('brand');
    expect(results[0].is).toBe(95);
  });

  test('brand at 85% IS → below_band', () => {
    const campaigns = [campaign('1', 'Test Brand')];
    const impressionShare = { '1': { is: 85 } };
    const results = classifyByImpressionShare({ campaigns, impressionShare });
    expect(results[0].status).toBe('below_band');
    expect(results[0].deficit).toBe(5); // 90 - 85 = 5
  });

  test('VLA at 75% IS → below_band (target ≥ 80)', () => {
    const campaigns = [campaign('2', 'Alan Jay Ford VLA')];
    const impressionShare = { '2': { is: 75 } };
    const results = classifyByImpressionShare({ campaigns, impressionShare });
    expect(results[0].status).toBe('below_band');
    expect(results[0].type).toBe('vla');
    expect(results[0].deficit).toBe(5); // 80 - 75 = 5
  });

  test('VLA at 80% IS → in_band (exactly at floor)', () => {
    const campaigns = [campaign('2', 'Test VLA')];
    const impressionShare = { '2': { is: 80 } };
    const results = classifyByImpressionShare({ campaigns, impressionShare });
    expect(results[0].status).toBe('in_band');
  });

  test('model-keyword at 95% IS → above_band (cap 90)', () => {
    const campaigns = [campaign('3', 'Alan Jay Ford - New - Escape')];
    const impressionShare = { '3': { is: 95 } };
    const results = classifyByImpressionShare({ campaigns, impressionShare });
    expect(results[0].status).toBe('above_band');
    expect(results[0].surplus).toBe(5);
  });

  test('model-keyword at 80% IS → in_band (75–90 band)', () => {
    const campaigns = [campaign('3', 'Alan Jay Ford - New - Civic')];
    const impressionShare = { '3': { is: 80 } };
    const results = classifyByImpressionShare({ campaigns, impressionShare });
    expect(results[0].status).toBe('in_band');
  });

  test('competitor at 30% IS → in_band (30–50 band)', () => {
    const campaigns = [campaign('4', 'Test Competitor Conquest')];
    const impressionShare = { '4': { is: 30 } };
    const results = classifyByImpressionShare({ campaigns, impressionShare });
    expect(results[0].status).toBe('in_band');
    expect(results[0].type).toBe('comp');
  });

  test('competitor at 25% IS → below_band', () => {
    const campaigns = [campaign('4', 'Test Comp Competitor')];
    const impressionShare = { '4': { is: 25 } };
    const results = classifyByImpressionShare({ campaigns, impressionShare });
    expect(results[0].status).toBe('below_band');
  });

  test('competitor at 55% IS → above_band (cap 50)', () => {
    const campaigns = [campaign('4', 'Test Comp Competitor')];
    const impressionShare = { '4': { is: 55 } };
    const results = classifyByImpressionShare({ campaigns, impressionShare });
    expect(results[0].status).toBe('above_band');
  });

  test('service campaign at any IS → no_target', () => {
    const campaigns = [campaign('5', 'Test Dealer Service Parts')];
    const impressionShare = { '5': { is: 40 } };
    const results = classifyByImpressionShare({ campaigns, impressionShare });
    expect(results[0].status).toBe('no_target');
    expect(results[0].type).toBe('service');
  });

  test('general campaign at 60% IS → in_band (target ≥ 50)', () => {
    const campaigns = [campaign('6', 'Test Dealer General Generic')];
    const impressionShare = { '6': { is: 60 } };
    const results = classifyByImpressionShare({ campaigns, impressionShare });
    expect(results[0].status).toBe('in_band');
  });

  test('regional campaign at 35% IS → in_band (30–50 band)', () => {
    const campaigns = [campaign('7', 'Test Dealer Regional Area')];
    const impressionShare = { '7': { is: 35 } };
    const results = classifyByImpressionShare({ campaigns, impressionShare });
    expect(results[0].status).toBe('in_band');
  });

  test('missing IS data for campaign → no_target', () => {
    const campaigns = [campaign('1', 'Test Brand')];
    const impressionShare = {};  // no data
    const results = classifyByImpressionShare({ campaigns, impressionShare });
    expect(results[0].status).toBe('no_target');
  });

  test('processes multiple campaigns independently', () => {
    const campaigns = [
      campaign('1', 'Test Brand'),
      campaign('2', 'Test VLA'),
      campaign('3', 'Test Service'),
    ];
    const impressionShare = {
      '1': { is: 95 },
      '2': { is: 68 },
      '3': { is: 40 },
    };
    const results = classifyByImpressionShare({ campaigns, impressionShare });
    expect(results).toHaveLength(3);
    expect(results[0].status).toBe('in_band');   // brand 95% ≥ 90
    expect(results[1].status).toBe('below_band');// vla 68% < 80
    expect(results[2].status).toBe('no_target'); // service
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R4 — Shared-budget binding check
// ─────────────────────────────────────────────────────────────────────────────

describe('R4 — checkSharedBudgetBinding()', () => {
  function budget(resourceName, name, dailyBudget) {
    return { resourceName, name, dailyBudget, campaigns: [] };
  }

  test('budget ceiling $300, trailing avg $150 → not binding (300 > 1.5 × 150 = 225)', () => {
    const sharedBudgets = [budget('budget/1', 'Brand Budget', 300)];
    const trailingDailyAvgByBudget = { 'budget/1': 150 };
    const results = checkSharedBudgetBinding({ sharedBudgets, trailingDailyAvgByBudget });
    expect(results[0].binding).toBe(false);
    expect(results[0].reason).toBe('budget_headroom_1.5x');
  });

  test('budget ceiling $300, trailing avg $250 → binding (300 < 1.5 × 250 = 375)', () => {
    const sharedBudgets = [budget('budget/2', 'VLA Budget', 300)];
    const trailingDailyAvgByBudget = { 'budget/2': 250 };
    const results = checkSharedBudgetBinding({ sharedBudgets, trailingDailyAvgByBudget });
    expect(results[0].binding).toBe(true);
    expect(results[0].reason).toBeNull();
  });

  test('budget ceiling $300, trailing avg $200 → binding (300 is NOT > 1.5 × 200 = 300; condition is strictly greater)', () => {
    // 1.5 × $200 = $300. dailyBudget ($300) is NOT > $300, so it IS binding.
    const sharedBudgets = [budget('budget/3', 'Equal Budget', 300)];
    const trailingDailyAvgByBudget = { 'budget/3': 200 };
    const results = checkSharedBudgetBinding({ sharedBudgets, trailingDailyAvgByBudget });
    expect(results[0].binding).toBe(true);
  });

  test('returns correct fields on each result', () => {
    const sharedBudgets = [budget('budget/1', 'Test Budget', 500)];
    const trailingDailyAvgByBudget = { 'budget/1': 100 };
    const results = checkSharedBudgetBinding({ sharedBudgets, trailingDailyAvgByBudget });
    expect(results[0]).toMatchObject({
      resourceName: 'budget/1',
      name: 'Test Budget',
      dailyBudget: 500,
      trailingAvg: 100,
      binding: false,
      reason: 'budget_headroom_1.5x',
    });
  });

  test('zero trailing avg → not binding (anything > 0 is > 1.5 × 0)', () => {
    const sharedBudgets = [budget('budget/1', 'Zero Avg', 50)];
    const trailingDailyAvgByBudget = { 'budget/1': 0 };
    const results = checkSharedBudgetBinding({ sharedBudgets, trailingDailyAvgByBudget });
    // 50 > 1.5 * 0 = 0 → not binding
    expect(results[0].binding).toBe(false);
  });

  test('missing trailing avg for budget → treated as 0 (not binding)', () => {
    const sharedBudgets = [budget('budget/X', 'No Avg', 100)];
    const trailingDailyAvgByBudget = {};
    const results = checkSharedBudgetBinding({ sharedBudgets, trailingDailyAvgByBudget });
    expect(results[0].binding).toBe(false);
  });

  test('empty sharedBudgets → empty array', () => {
    const results = checkSharedBudgetBinding({ sharedBudgets: [], trailingDailyAvgByBudget: {} });
    expect(results).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R5 — Campaign-weight reshaper
// ─────────────────────────────────────────────────────────────────────────────

describe('R5 — reshapeCampaignAllocation()', () => {
  // Mixed campaign set to match spec requirement
  const campaigns = [
    { campaignId: '1', campaignName: 'Test Dealer Brand',      spend: 500 },
    { campaignId: '2', campaignName: 'Test Dealer Regional',   spend: 400 },
    { campaignId: '3', campaignName: 'Test Dealer VLA',        spend: 700 },
    { campaignId: '4', campaignName: 'Test Dealer - New - Civic', spend: 300 },  // model_keyword
    { campaignId: '5', campaignName: 'Test Dealer General',    spend: 200 },
  ];

  test('decrease $40 with healthy inventory — regional takes bigger cut than VLA', () => {
    const result = reshapeCampaignAllocation({
      totalDelta: -40,
      campaigns,
      inventoryTier: 'healthy',
    });

    const regional = result.find(c => c.campaignId === '2');
    const vla = result.find(c => c.campaignId === '3');

    // With healthy inventory, cut weights are CUT_WEIGHTS unmodified:
    // regional=1.0, vla=0.15 → regional should absorb more
    expect(regional.deltaDollars).toBeLessThan(vla.deltaDollars);  // both negative; regional more negative
    expect(regional.deltaDollars).toBeLessThan(0);
    expect(vla.deltaDollars).toBeLessThan(0);
  });

  test('decrease $40 with critical inventory — VLA takes much bigger cut (weight 0.15 × 3.0 = 0.45)', () => {
    const healthyResult = reshapeCampaignAllocation({
      totalDelta: -40,
      campaigns,
      inventoryTier: 'healthy',
    });
    const criticalResult = reshapeCampaignAllocation({
      totalDelta: -40,
      campaigns,
      inventoryTier: 'critical',
    });

    const vlaHealthy = healthyResult.find(c => c.campaignId === '3');
    const vlaCritical = criticalResult.find(c => c.campaignId === '3');

    // With critical inventory, VLA absorbs MORE of the cut
    expect(vlaCritical.deltaDollars).toBeLessThan(vlaHealthy.deltaDollars);
  });

  test('increase $100 with critical inventory — VLA gets zero', () => {
    const result = reshapeCampaignAllocation({
      totalDelta: 100,
      campaigns,
      inventoryTier: 'critical',
    });

    const vla = result.find(c => c.campaignId === '3');
    const modelKeyword = result.find(c => c.campaignId === '4');

    expect(vla.deltaDollars).toBe(0);
    expect(modelKeyword.deltaDollars).toBe(0);

    // All budget goes to non-VLA/non-model-keyword
    const totalDelta = result.reduce((sum, c) => sum + c.deltaDollars, 0);
    expect(Math.abs(totalDelta - 100)).toBeLessThanOrEqual(0.02); // ±$0.02 rounding
  });

  test('deltas sum to totalDelta within ±$0.01 rounding', () => {
    const result = reshapeCampaignAllocation({
      totalDelta: -40,
      campaigns,
      inventoryTier: 'healthy',
    });

    const total = result.reduce((sum, c) => sum + c.deltaDollars, 0);
    expect(Math.abs(total - (-40))).toBeLessThanOrEqual(0.01);
  });

  test('increase deltas sum to totalDelta within ±$0.01 rounding', () => {
    const result = reshapeCampaignAllocation({
      totalDelta: 100,
      campaigns,
      inventoryTier: 'healthy',
    });

    const total = result.reduce((sum, c) => sum + c.deltaDollars, 0);
    expect(Math.abs(total - 100)).toBeLessThanOrEqual(0.01);
  });

  test('output shape includes required fields', () => {
    const result = reshapeCampaignAllocation({
      totalDelta: -20,
      campaigns: [{ campaignId: '1', campaignName: 'Test Brand', spend: 300 }],
      inventoryTier: 'healthy',
    });

    expect(result[0]).toHaveProperty('campaignId');
    expect(result[0]).toHaveProperty('campaignName');
    expect(result[0]).toHaveProperty('type');
    expect(result[0]).toHaveProperty('currentSpend');
    expect(result[0]).toHaveProperty('deltaDollars');
    expect(result[0]).toHaveProperty('deltaPct');
    expect(result[0]).toHaveProperty('newSpend');
  });

  test('empty campaigns → empty array', () => {
    const result = reshapeCampaignAllocation({
      totalDelta: -50,
      campaigns: [],
      inventoryTier: 'healthy',
    });
    expect(result).toEqual([]);
  });

  test('increase $100 with very_low inventory — VLA weight reduced (factor 0.2)', () => {
    const healthyResult = reshapeCampaignAllocation({
      totalDelta: 100,
      campaigns,
      inventoryTier: 'healthy',
    });
    const veryLowResult = reshapeCampaignAllocation({
      totalDelta: 100,
      campaigns,
      inventoryTier: 'very_low',
    });

    const vlaHealthy = healthyResult.find(c => c.campaignId === '3');
    const vlaVeryLow = veryLowResult.find(c => c.campaignId === '3');

    // very_low inventory → VLA gets less of the increase
    expect(vlaVeryLow.deltaDollars).toBeLessThan(vlaHealthy.deltaDollars);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R7 — Rationale composer
// ─────────────────────────────────────────────────────────────────────────────

describe('R7 — composeRationale()', () => {
  const basePacing = {
    mtdSpend: 4463.68,
    monthlyBudget: 6000,
    curveTarget: 4116,
    pacePercent: 108.4,
    daysRemaining: 9,
  };

  const baseRecommendation = {
    action: 'reduce_daily_budget',
    direction: 'decrease',
    newDailyBudget: 170.70,
    change: -42.30,
    changePct: -19.85,
    confidence: 'high',
  };

  test('produces non-empty array for any non-skipped proposal', () => {
    const lines = composeRationale({
      pacing: basePacing,
      inventory: null,
      recommendation: baseRecommendation,
      isAssessments: [],
      sharedBudgetBindings: [],
      clampedBy: null,
    });
    expect(lines.length).toBeGreaterThan(0);
  });

  test('first line contains the current pacing percentage', () => {
    const lines = composeRationale({
      pacing: basePacing,
      inventory: null,
      recommendation: baseRecommendation,
      isAssessments: [],
      sharedBudgetBindings: [],
      clampedBy: null,
    });
    expect(lines[0]).toContain('108.4%');
  });

  test('first line contains days remaining', () => {
    const lines = composeRationale({
      pacing: basePacing,
      inventory: null,
      recommendation: baseRecommendation,
      isAssessments: [],
      sharedBudgetBindings: [],
      clampedBy: null,
    });
    expect(lines[0]).toContain('9 days');
  });

  test('mentions inventory tier when inventory provided (healthy)', () => {
    const lines = composeRationale({
      pacing: basePacing,
      inventory: { newVinCount: 18, baseline: 22, tier: 'healthy' },
      recommendation: baseRecommendation,
      isAssessments: [],
      sharedBudgetBindings: [],
      clampedBy: null,
    });
    const inventoryLine = lines.find(l => l.toLowerCase().includes('inventory'));
    expect(inventoryLine).toBeDefined();
    expect(inventoryLine).toContain('healthy');
    expect(inventoryLine).toContain('18');
  });

  test('mentions inventory tier when inventory provided (critical)', () => {
    const lines = composeRationale({
      pacing: basePacing,
      inventory: { newVinCount: 2, baseline: 20, tier: 'critical' },
      recommendation: baseRecommendation,
      isAssessments: [],
      sharedBudgetBindings: [],
      clampedBy: null,
    });
    const inventoryLine = lines.find(l => l.toLowerCase().includes('inventory'));
    expect(inventoryLine).toBeDefined();
    expect(inventoryLine.toLowerCase()).toContain('critical');
  });

  test('mentions clampedBy when max_increase clamp occurred', () => {
    const lines = composeRationale({
      pacing: { ...basePacing, pacePercent: 70 },
      inventory: null,
      recommendation: { ...baseRecommendation, direction: 'increase', action: 'increase_daily_budget', change: 42, changePct: 19.85 },
      isAssessments: [],
      sharedBudgetBindings: [],
      clampedBy: 'max_increase',
    });
    const clampLine = lines.find(l => l.includes('20%') || l.includes('single-step'));
    expect(clampLine).toBeDefined();
  });

  test('mentions clampedBy when floor clamp occurred', () => {
    const lines = composeRationale({
      pacing: basePacing,
      inventory: null,
      recommendation: baseRecommendation,
      isAssessments: [],
      sharedBudgetBindings: [],
      clampedBy: 'floor',
    });
    const clampLine = lines.find(l => l.toLowerCase().includes('floor'));
    expect(clampLine).toBeDefined();
  });

  test('no clamp line when clampedBy is null', () => {
    const lines = composeRationale({
      pacing: basePacing,
      inventory: null,
      recommendation: baseRecommendation,
      isAssessments: [],
      sharedBudgetBindings: [],
      clampedBy: null,
    });
    const clampLine = lines.find(l => l.toLowerCase().includes('clamp') || l.toLowerCase().includes('floor') || l.toLowerCase().includes('ceiling'));
    expect(clampLine).toBeUndefined();
  });

  test('includes IS issue line for below-band campaign', () => {
    const isAssessments = [
      {
        campaignId: '2',
        campaignName: 'Alan Jay Ford VLA',
        type: 'vla',
        is: 68,
        status: 'below_band',
        deficit: 12,
      },
    ];
    const lines = composeRationale({
      pacing: basePacing,
      inventory: null,
      recommendation: baseRecommendation,
      isAssessments,
      sharedBudgetBindings: [],
      clampedBy: null,
    });
    const isLine = lines.find(l => l.includes('Alan Jay Ford VLA'));
    expect(isLine).toBeDefined();
    expect(isLine).toContain('68%');
    expect(isLine).toContain('80%');
  });

  test('no IS line for in-band or no-target campaigns', () => {
    const isAssessments = [
      { campaignId: '1', campaignName: 'Test Brand', type: 'brand', is: 94, status: 'in_band' },
      { campaignId: '2', campaignName: 'Test Service', type: 'service', is: null, status: 'no_target' },
    ];
    const lines = composeRationale({
      pacing: basePacing,
      inventory: null,
      recommendation: baseRecommendation,
      isAssessments,
      sharedBudgetBindings: [],
      clampedBy: null,
    });
    // Should not contain IS-warning lines for these
    const isWarningLine = lines.find(l => l.includes('Test Brand') || l.includes('Test Service'));
    expect(isWarningLine).toBeUndefined();
  });

  test('includes shared-budget non-binding line', () => {
    const sharedBudgetBindings = [
      { resourceName: 'budget/1', name: 'Brand Budget', dailyBudget: 200, trailingAvg: 95, binding: false, reason: 'budget_headroom_1.5x' },
    ];
    const lines = composeRationale({
      pacing: basePacing,
      inventory: null,
      recommendation: baseRecommendation,
      isAssessments: [],
      sharedBudgetBindings,
      clampedBy: null,
    });
    const budgetLine = lines.find(l => l.includes('Brand Budget'));
    expect(budgetLine).toBeDefined();
    expect(budgetLine.toLowerCase()).toContain('not binding');
  });

  test('no budget line for binding shared budgets', () => {
    const sharedBudgetBindings = [
      { resourceName: 'budget/1', name: 'VLA Budget', dailyBudget: 300, trailingAvg: 250, binding: true, reason: null },
    ];
    const lines = composeRationale({
      pacing: basePacing,
      inventory: null,
      recommendation: baseRecommendation,
      isAssessments: [],
      sharedBudgetBindings,
      clampedBy: null,
    });
    const budgetLine = lines.find(l => l.includes('VLA Budget'));
    expect(budgetLine).toBeUndefined();
  });

  test('hold action → no-change sentence instead of budget sentence', () => {
    const lines = composeRationale({
      pacing: { ...basePacing, pacePercent: 100.5 },
      inventory: null,
      recommendation: {
        action: 'hold',
        direction: 'hold',
        newDailyBudget: null,
        change: 0,
        changePct: 0,
        confidence: 'low',
      },
      isAssessments: [],
      sharedBudgetBindings: [],
      clampedBy: null,
    });
    const holdLine = lines.find(l => l.toLowerCase().includes('no budget change') || l.toLowerCase().includes('on pace'));
    expect(holdLine).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IS_TARGETS constant — spot check
// ─────────────────────────────────────────────────────────────────────────────

describe('IS_TARGETS constant', () => {
  test('brand has min=90, max=null', () => {
    expect(IS_TARGETS.brand).toEqual({ min: 90, max: null });
  });

  test('vla has min=80, max=null', () => {
    expect(IS_TARGETS.vla).toEqual({ min: 80, max: null });
  });

  test('model_keyword has min=75, max=90', () => {
    expect(IS_TARGETS.model_keyword).toEqual({ min: 75, max: 90 });
  });

  test('general has min=50, max=null', () => {
    expect(IS_TARGETS.general).toEqual({ min: 50, max: null });
  });

  test('comp has min=30, max=50', () => {
    expect(IS_TARGETS.comp).toEqual({ min: 30, max: 50 });
  });

  test('regional has min=30, max=50', () => {
    expect(IS_TARGETS.regional).toEqual({ min: 30, max: 50 });
  });

  test('service is null (no target)', () => {
    expect(IS_TARGETS.service).toBeNull();
  });
});
