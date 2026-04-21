/**
 * Unit tests: Phase 5 flag-gated delegation inside generateRecommendation.
 *
 * Tests the four delegation scenarios:
 *   1. Flag OFF → V1 shape returned (sync)
 *   2. Flag ON + currentDailyBudget present → V2 shape returned (async, source: 'pacing_engine_v2')
 *   3. Flag ON + currentDailyBudget missing → falls back to V1
 *   4. Flag check throws (missing required env var) → falls back to V1, no exception propagated
 *
 * Uses module-cache-clear pattern (same as test_pacing_engine_v2_flow.js).
 */

// ── Required env vars so validateEnv() doesn't throw in the V1 path ──────────
process.env.GOOGLE_ADS_DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || 'fake-dev-token';
process.env.GOOGLE_ADS_CLIENT_ID       = process.env.GOOGLE_ADS_CLIENT_ID       || 'fake-client-id';
process.env.GOOGLE_ADS_CLIENT_SECRET   = process.env.GOOGLE_ADS_CLIENT_SECRET   || 'fake-client-secret';
process.env.SESSION_SECRET             = process.env.SESSION_SECRET             || 'fake-session-secret';
process.env.ANTHROPIC_API_KEY          = process.env.ANTHROPIC_API_KEY          || 'fake-anthropic-key';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Clears module cache for budget-recommender + config, then re-requires
 * generateRecommendation under whatever PACING_ENGINE_V2_ENABLED value is
 * currently set.
 */
function freshGenerateRecommendation() {
  delete require.cache[require.resolve('../../src/utils/config')];
  delete require.cache[require.resolve('../../src/services/budget-recommender')];
  return require('../../src/services/budget-recommender').generateRecommendation;
}

/**
 * Minimal valid params for V1 path (no currentDailyBudget).
 * Day 21 of a 30-day month — well within range for V1 to produce a normal result.
 */
function v1Params() {
  return {
    goal: {
      dealerName: 'Test Dealer',
      monthlyBudget: 6000,
      pacingMode: 'advisory',
      pacingCurveId: 'linear',
      baselineInventory: null,
    },
    campaignSpend: [
      { campaignId: '1', campaignName: 'Test Dealer Brand', status: 'ENABLED', spend: 1500 },
      { campaignId: '2', campaignName: 'Test Dealer VLA',   status: 'ENABLED', spend: 1500 },
    ],
    sharedBudgets: [],
    dedicatedBudgets: [],
    impressionShare: [],
    inventoryCount: null,
    year: 2026,
    month: 4,
    currentDay: 21,
    dayWeights: null,
    dailyBreakdown: null,
    changeDate: null,
    excludeCampaigns: [],
    geoTargets: null,
    budgetSplit: null,
  };
}

/**
 * V2-capable params (same base, plus currentDailyBudget + other V2 fields).
 */
function v2Params() {
  return {
    ...v1Params(),
    currentDailyBudget: 200,
    bidStrategyType: 'MAXIMIZE_CLICKS',
    inventory: { newVinCount: 18, baselineRolling90Day: 22, tier: 'healthy' },
    restCtx: null,  // no diagnostics in unit tests
  };
}

// ── Test 1: Flag OFF → V1 shape ───────────────────────────────────────────────

describe('generateRecommendation delegation — flag OFF', () => {
  let generateRecommendation;

  beforeAll(() => {
    process.env.PACING_ENGINE_V2_ENABLED = 'false';
    generateRecommendation = freshGenerateRecommendation();
  });

  afterAll(() => {
    delete process.env.PACING_ENGINE_V2_ENABLED;
  });

  test('returns V1 shape (has recommendations, totalSpend, pacing, status)', async () => {
    const result = await generateRecommendation(v1Params());
    // V1 shape must have these top-level fields
    expect(result).toHaveProperty('dealerName', 'Test Dealer');
    expect(result).toHaveProperty('totalSpend');
    expect(result).toHaveProperty('pacing');
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('recommendations');
    // Must NOT have V2 source field
    expect(result.source).toBeUndefined();
  });

  test('V1 path works even when currentDailyBudget is provided (flag is the gating criterion)', async () => {
    const result = await generateRecommendation({ ...v1Params(), currentDailyBudget: 200 });
    expect(result).toHaveProperty('recommendations');
    expect(result.source).toBeUndefined();
  });
});

// ── Test 2: Flag ON + currentDailyBudget present → V2 shape ──────────────────

describe('generateRecommendation delegation — flag ON, budget present', () => {
  let generateRecommendation;

  beforeAll(() => {
    process.env.PACING_ENGINE_V2_ENABLED = 'true';
    generateRecommendation = freshGenerateRecommendation();
  });

  afterAll(() => {
    delete process.env.PACING_ENGINE_V2_ENABLED;
  });

  test('returns a Promise', () => {
    const result = generateRecommendation(v2Params());
    expect(result).toBeInstanceOf(Promise);
    return result; // let Jest await / catch errors
  });

  test('returns V2 shape (source: pacing_engine_v2, has pacing/inventory/recommendation/rationale/diagnostics)', async () => {
    const result = await generateRecommendation(v2Params());
    expect(result.source).toBe('pacing_engine_v2');
    expect(result).toHaveProperty('pacing');
    expect(result).toHaveProperty('inventory');
    expect(result).toHaveProperty('recommendation');
    expect(result).toHaveProperty('rationale');
    expect(result).toHaveProperty('diagnostics');
    expect(result).toHaveProperty('dealerName', 'Test Dealer');
  });

  test('recommendation object has action, direction, confidence', async () => {
    const result = await generateRecommendation(v2Params());
    expect(result.recommendation).toHaveProperty('action');
    expect(result.recommendation).toHaveProperty('direction');
    expect(result.recommendation).toHaveProperty('confidence');
  });

  test('rationale is a non-empty array of strings', async () => {
    const result = await generateRecommendation(v2Params());
    expect(Array.isArray(result.rationale)).toBe(true);
    expect(result.rationale.length).toBeGreaterThan(0);
    expect(typeof result.rationale[0]).toBe('string');
  });
});

// ── Test 3: Flag ON + currentDailyBudget missing → falls back to V1 ──────────

describe('generateRecommendation delegation — flag ON, budget missing', () => {
  let generateRecommendation;

  beforeAll(() => {
    process.env.PACING_ENGINE_V2_ENABLED = 'true';
    generateRecommendation = freshGenerateRecommendation();
  });

  afterAll(() => {
    delete process.env.PACING_ENGINE_V2_ENABLED;
  });

  test('falls back to V1 when currentDailyBudget is null', async () => {
    const params = { ...v2Params(), currentDailyBudget: null };
    const result = await generateRecommendation(params);
    // V1 shape
    expect(result).toHaveProperty('recommendations');
    expect(result.source).toBeUndefined();
  });

  test('falls back to V1 when currentDailyBudget is undefined', async () => {
    const params = v1Params(); // no currentDailyBudget at all
    const result = await generateRecommendation(params);
    expect(result).toHaveProperty('recommendations');
    expect(result.source).toBeUndefined();
  });
});

// ── Test 4: Flag check throws → falls back to V1, no exception propagated ─────
//
// Strategy: keep PACING_ENGINE_V2_ENABLED=true so the delegation path is
// entered, but make validateEnv() throw by removing a required env var AT
// CALL TIME (validateEnv reads process.env dynamically, not at require-time).
// V1 doesn't call validateEnv, so it runs fine after the catch.

describe('generateRecommendation delegation — flag check throws', () => {
  let generateRecommendation;
  let originalDevToken;

  beforeAll(() => {
    process.env.PACING_ENGINE_V2_ENABLED = 'true';
    originalDevToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;

    delete require.cache[require.resolve('../../src/utils/config')];
    delete require.cache[require.resolve('../../src/services/budget-recommender')];
    generateRecommendation = require('../../src/services/budget-recommender').generateRecommendation;
  });

  afterAll(() => {
    // Ensure env is fully restored for later suites
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = originalDevToken;
    delete process.env.PACING_ENGINE_V2_ENABLED;
    delete require.cache[require.resolve('../../src/utils/config')];
    delete require.cache[require.resolve('../../src/services/budget-recommender')];
  });

  test('does not throw — falls back to V1 shape gracefully', async () => {
    // Remove the required token so validateEnv() throws inside the delegation try-block.
    // V1 doesn't call validateEnv so the fallback still produces a valid result.
    delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    try {
      const result = await generateRecommendation(v2Params());
      // Should have fallen back to V1
      expect(result).toHaveProperty('recommendations');
      expect(result.source).toBeUndefined();
    } finally {
      // Always restore so afterAll and other tests see the full env
      process.env.GOOGLE_ADS_DEVELOPER_TOKEN = originalDevToken;
    }
  });

  test('no exception propagates out of generateRecommendation when validateEnv throws', async () => {
    delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    try {
      // May return a plain object (V1) or a Promise (if V2 path entered before throw).
      // Either way it must not throw.
      const resultOrPromise = generateRecommendation(v2Params());
      const result = await Promise.resolve(resultOrPromise);
      expect(result).toBeDefined();
    } finally {
      process.env.GOOGLE_ADS_DEVELOPER_TOKEN = originalDevToken;
    }
  });
});
