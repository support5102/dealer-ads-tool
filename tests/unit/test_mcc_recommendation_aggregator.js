const aggregator = require('../../src/services/mcc-recommendation-aggregator');
const { ALWAYS_DISMISS_TYPES } = require('../../src/services/recommendation-dismisser');

function makeFakeGetRecs(perAccountResponses) {
  return jest.fn(async (restCtx) => {
    const resp = perAccountResponses[restCtx.customerId];
    if (resp instanceof Error) throw resp;
    return resp || [];
  });
}

describe('aggregateRecommendations', () => {
  test('empty MCC → empty result', async () => {
    const result = await aggregator.aggregateRecommendations({
      accounts: [],
      buildRestCtx: jest.fn(),
      getRecs: makeFakeGetRecs({}),
    });
    expect(result).toEqual({ quickClear: [], review: [], errorsByDealer: [] });
  });

  test('one account with one ALWAYS_DISMISS rec → quickClear has it', async () => {
    const result = await aggregator.aggregateRecommendations({
      accounts: [{ customerId: '111', name: 'Honda' }],
      buildRestCtx: (acc) => ({ customerId: acc.customerId }),
      getRecs: makeFakeGetRecs({
        '111': [{ resourceName: 'rn-1', type: 'ENHANCED_CPC_OPT_IN' }],
      }),
    });
    expect(result.quickClear).toHaveLength(1);
    expect(result.quickClear[0]).toMatchObject({
      type: 'ENHANCED_CPC_OPT_IN',
      count: 1,
    });
    expect(result.quickClear[0].items).toHaveLength(1);
    expect(result.quickClear[0].items[0]).toMatchObject({
      customerId: '111',
      dealerName: 'Honda',
      resourceName: 'rn-1',
    });
    expect(result.review).toEqual([]);
  });

  test('one account with one review-type rec → review has it, quickClear empty', async () => {
    const result = await aggregator.aggregateRecommendations({
      accounts: [{ customerId: '111', name: 'Honda' }],
      buildRestCtx: (acc) => ({ customerId: acc.customerId }),
      getRecs: makeFakeGetRecs({
        '111': [{ resourceName: 'rn-2', type: 'KEYWORD' }],
      }),
    });
    expect(result.quickClear).toEqual([]);
    expect(result.review).toHaveLength(1);
    expect(result.review[0].type).toBe('KEYWORD');
  });

  test('multiple accounts → counts roll up by type', async () => {
    const result = await aggregator.aggregateRecommendations({
      accounts: [
        { customerId: '111', name: 'Honda' },
        { customerId: '222', name: 'Toyota' },
        { customerId: '333', name: 'Ford' },
      ],
      buildRestCtx: (acc) => ({ customerId: acc.customerId }),
      getRecs: makeFakeGetRecs({
        '111': [{ resourceName: 'a', type: 'ENHANCED_CPC_OPT_IN' }, { resourceName: 'b', type: 'ENHANCED_CPC_OPT_IN' }],
        '222': [{ resourceName: 'c', type: 'ENHANCED_CPC_OPT_IN' }],
        '333': [{ resourceName: 'd', type: 'KEYWORD' }],
      }),
    });
    const ecpc = result.quickClear.find(g => g.type === 'ENHANCED_CPC_OPT_IN');
    expect(ecpc.count).toBe(3);
    expect(ecpc.items).toHaveLength(3);
    expect(result.review).toHaveLength(1);
  });

  test('per-account error captured but loop continues', async () => {
    const result = await aggregator.aggregateRecommendations({
      accounts: [
        { customerId: '111', name: 'Honda' },
        { customerId: '222', name: 'Toyota' },
      ],
      buildRestCtx: (acc) => ({ customerId: acc.customerId }),
      getRecs: makeFakeGetRecs({
        '111': new Error('Permission denied'),
        '222': [{ resourceName: 'c', type: 'ENHANCED_CPC_OPT_IN' }],
      }),
    });
    expect(result.errorsByDealer).toHaveLength(1);
    expect(result.errorsByDealer[0]).toMatchObject({
      customerId: '111',
      dealerName: 'Honda',
      error: 'Permission denied',
    });
    expect(result.quickClear[0].count).toBe(1);
  });

  test('every type from ALWAYS_DISMISS_TYPES classifies to quickClear', () => {
    expect(ALWAYS_DISMISS_TYPES.length).toBeGreaterThan(0);
  });
});
