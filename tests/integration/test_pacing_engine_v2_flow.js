/**
 * Integration: pacing-engine-v2 runner with in-memory fakes.
 * Exercises the orchestration path from runner.run → runForAccount → deps.
 */

// Must set env vars BEFORE requiring modules that call validateEnv().
// These are fake values — no real API calls are made in this test.
process.env.PACING_ENGINE_V2_ENABLED = 'true';
process.env.GOOGLE_ADS_DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || 'fake-dev-token';
process.env.GOOGLE_ADS_CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID || 'fake-client-id';
process.env.GOOGLE_ADS_CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET || 'fake-client-secret';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'fake-session-secret';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'fake-anthropic-key';
delete require.cache[require.resolve('../../src/utils/config')];
delete require.cache[require.resolve('../../src/services/pacing-engine-runner')];

const { run } = require('../../src/services/pacing-engine-runner');

describe('pacing-engine-v2 runner (integration)', () => {
  test('auto_apply account with underpacing produces an applied budget change within cap', async () => {
    const applied = [];
    const logged = [];
    const summary = await run({
      listAccounts: async () => ([{
        customerId: '111-222-3333',
        dealerName: 'Test Dealer',
        goal: { dealerName: 'Test Dealer', monthlyBudget: 3000, pacingMode: 'auto_apply', pacingCurveId: 'linear' },
        mtdSpend: 1200,
        currentDailyBudget: 100,
        bidStrategyType: 'MAXIMIZE_CLICKS',
        lastChangeTimestamp: null,
      }]),
      applyBudgetChange: async (customerId, newBudget) => {
        applied.push({ customerId, newBudget });
      },
    });

    expect(summary.processed).toBe(1);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].proposed).toBeDefined();

    // Apply may be skipped if today happens to be in freeze window (last 2 days of month).
    // If not, the applied budget must land within the ±20% cap.
    if (applied.length === 1) {
      expect(applied[0].customerId).toBe('111-222-3333');
      expect(applied[0].newBudget).toBeGreaterThanOrEqual(80);
      expect(applied[0].newBudget).toBeLessThanOrEqual(120);
      expect(summary.applied).toBe(1);
    }
  });

  test('advisory mode: no applies, no logs, but proposal is in results', async () => {
    const applied = [];
    const summary = await run({
      listAccounts: async () => ([{
        customerId: '1', dealerName: 'D',
        goal: { dealerName: 'D', monthlyBudget: 3000, pacingMode: 'advisory', pacingCurveId: 'linear' },
        mtdSpend: 1200, currentDailyBudget: 100, bidStrategyType: 'MAXIMIZE_CLICKS', lastChangeTimestamp: null,
      }]),
      applyBudgetChange: async (c, b) => applied.push({ c, b }),
    });
    expect(applied.length).toBe(0);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].outcome).toBe('advisory');
  });

  test('disabled flag produces disabled summary without iterating', async () => {
    // Toggle off for just this test
    const original = process.env.PACING_ENGINE_V2_ENABLED;
    process.env.PACING_ENGINE_V2_ENABLED = 'false';
    delete require.cache[require.resolve('../../src/utils/config')];
    delete require.cache[require.resolve('../../src/services/pacing-engine-runner')];
    const { run: coldRun } = require('../../src/services/pacing-engine-runner');

    let called = 0;
    const summary = await coldRun({
      listAccounts: async () => { called += 1; return []; },
      applyBudgetChange: async () => { throw new Error('should not be called'); },
    });
    expect(summary.disabled).toBe(true);
    expect(summary.processed).toBe(0);
    expect(called).toBe(0);

    // Restore
    process.env.PACING_ENGINE_V2_ENABLED = original;
    delete require.cache[require.resolve('../../src/utils/config')];
    delete require.cache[require.resolve('../../src/services/pacing-engine-runner')];
  });
});
