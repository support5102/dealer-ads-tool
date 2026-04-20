const { listAccountsFromResults } = require('../../src/services/pacing-engine-deps');
const googleAds = require('../../src/services/google-ads');

describe('listAccountsFromResults', () => {
  let origFn;
  beforeEach(() => {
    origFn = googleAds.getAccountLevelDailyBudget;
  });
  afterEach(() => {
    googleAds.getAccountLevelDailyBudget = origFn;
  });

  test('enriches results with currentDailyBudget and bidStrategyType', async () => {
    googleAds.getAccountLevelDailyBudget = async () => ({
      totalDailyBudget: 65.81,
      primaryBidStrategy: 'TARGET_CPA',
    });

    const out = await listAccountsFromResults(
      { accessToken: 't', developerToken: 'd', loginCustomerId: 'm' },
      [{
        customerId: '111-222-3333',
        dealerName: 'Test',
        monthlyBudget: 3000,
        mtdSpend: 1500,
        changeDate: '2026-04-10',
        pacingMode: 'one_click',
        pacingCurveId: 'linear',
      }]
    );

    expect(out).toHaveLength(1);
    expect(out[0].currentDailyBudget).toBe(65.81);
    expect(out[0].bidStrategyType).toBe('TARGET_CPA');
    expect(out[0].lastChangeTimestamp).toBe('2026-04-10T00:00:00Z');
    expect(out[0].goal.pacingMode).toBe('one_click');
    expect(out[0].goal.pacingCurveId).toBe('linear');
  });

  test('defaults bidStrategyType when google returns null', async () => {
    googleAds.getAccountLevelDailyBudget = async () => ({ totalDailyBudget: 50, primaryBidStrategy: null });
    const out = await listAccountsFromResults(
      { accessToken: 't', developerToken: 'd', loginCustomerId: 'm' },
      [{ customerId: '1', dealerName: 'D', monthlyBudget: 1500, mtdSpend: 500, changeDate: null, pacingMode: 'advisory', pacingCurveId: 'linear' }]
    );
    expect(out[0].bidStrategyType).toBe('MAXIMIZE_CLICKS');
    expect(out[0].lastChangeTimestamp).toBeNull();
  });

  test('skips accounts that throw during enrichment (does not break the batch)', async () => {
    let callCount = 0;
    googleAds.getAccountLevelDailyBudget = async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('API quota exceeded');
      return { totalDailyBudget: 75, primaryBidStrategy: 'MANUAL_CPC' };
    };
    const out = await listAccountsFromResults(
      { accessToken: 't', developerToken: 'd', loginCustomerId: 'm' },
      [
        { customerId: '1', dealerName: 'Fails', monthlyBudget: 1500, mtdSpend: 500, changeDate: null, pacingMode: 'one_click', pacingCurveId: 'linear' },
        { customerId: '2', dealerName: 'Works', monthlyBudget: 2000, mtdSpend: 800, changeDate: null, pacingMode: 'one_click', pacingCurveId: 'linear' },
      ]
    );
    expect(out).toHaveLength(1);
    expect(out[0].dealerName).toBe('Works');
  });
});
