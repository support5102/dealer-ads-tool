const aggregator = require('../../src/services/mcc-auto-asset-aggregator');

function makeFakeGetAssets(perAccount) {
  return jest.fn(async (restCtx) => {
    const resp = perAccount[restCtx.customerId];
    if (resp instanceof Error) throw resp;
    return resp || [];
  });
}

const HEADLINE_A = { resourceName: 'rn-h-1', type: 'HEADLINE', text: 'Best deals', scope: 'ad_group_ad' };
const HEADLINE_B = { resourceName: 'rn-h-2', type: 'HEADLINE', text: 'Visit us', scope: 'ad_group_ad' };
const CALLOUT_X  = { resourceName: 'rn-c-1', type: 'CALLOUT',  text: 'Free Wi-Fi', scope: 'customer' };

describe('aggregateAutoAssets', () => {
  test('empty MCC → empty result', async () => {
    const result = await aggregator.aggregateAutoAssets({
      accounts: [],
      buildRestCtx: jest.fn(),
      getAssets: makeFakeGetAssets({}),
    });
    expect(result).toEqual({ types: {}, errorsByDealer: [] });
  });

  test('one account, one headline → types.HEADLINE has it', async () => {
    const result = await aggregator.aggregateAutoAssets({
      accounts: [{ customerId: '111', name: 'Honda' }],
      buildRestCtx: (acc) => ({ customerId: acc.customerId }),
      getAssets: makeFakeGetAssets({ '111': [HEADLINE_A] }),
    });
    expect(result.types.HEADLINE).toBeDefined();
    expect(result.types.HEADLINE.count).toBe(1);
    expect(result.types.HEADLINE.dealers).toBe(1);
    expect(result.types.HEADLINE.items[0]).toMatchObject({
      resourceName: 'rn-h-1',
      text: 'Best deals',
      customerId: '111',
      dealerName: 'Honda',
      scope: 'ad_group_ad',
    });
  });

  test('two accounts contribute HEADLINE → count rolls up, dealers=2', async () => {
    const result = await aggregator.aggregateAutoAssets({
      accounts: [
        { customerId: '111', name: 'Honda' },
        { customerId: '222', name: 'Toyota' },
      ],
      buildRestCtx: (acc) => ({ customerId: acc.customerId }),
      getAssets: makeFakeGetAssets({
        '111': [HEADLINE_A],
        '222': [HEADLINE_B],
      }),
    });
    expect(result.types.HEADLINE.count).toBe(2);
    expect(result.types.HEADLINE.dealers).toBe(2);
  });

  test('mixed types → grouped separately', async () => {
    const result = await aggregator.aggregateAutoAssets({
      accounts: [{ customerId: '111', name: 'Honda' }],
      buildRestCtx: (acc) => ({ customerId: acc.customerId }),
      getAssets: makeFakeGetAssets({
        '111': [HEADLINE_A, HEADLINE_B, CALLOUT_X],
      }),
    });
    expect(result.types.HEADLINE.count).toBe(2);
    expect(result.types.CALLOUT.count).toBe(1);
  });

  test('zero-count types not included', async () => {
    const result = await aggregator.aggregateAutoAssets({
      accounts: [{ customerId: '111', name: 'Honda' }],
      buildRestCtx: (acc) => ({ customerId: acc.customerId }),
      getAssets: makeFakeGetAssets({ '111': [HEADLINE_A] }),
    });
    expect(result.types.SITELINK).toBeUndefined();
    expect(result.types.DESCRIPTION).toBeUndefined();
  });

  test('per-account error captured', async () => {
    const result = await aggregator.aggregateAutoAssets({
      accounts: [
        { customerId: '111', name: 'Honda' },
        { customerId: '222', name: 'Toyota' },
      ],
      buildRestCtx: (acc) => ({ customerId: acc.customerId }),
      getAssets: makeFakeGetAssets({
        '111': new Error('Auth failed'),
        '222': [HEADLINE_A],
      }),
    });
    expect(result.errorsByDealer).toHaveLength(1);
    expect(result.errorsByDealer[0]).toMatchObject({ customerId: '111', error: 'Auth failed' });
    expect(result.types.HEADLINE.count).toBe(1);
  });
});
