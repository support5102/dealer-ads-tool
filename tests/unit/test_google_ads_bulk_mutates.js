const { dismissRecommendations, mutateRemoveAssets } = require('../../src/services/google-ads');

function fakeMutateCtx() {
  const calls = [];
  return {
    accessToken: 'tok',
    developerToken: 'dev',
    customerId: '111',
    loginCustomerId: '999',
    _mutateFn: async (url, body) => {
      calls.push({ url, body });
      return { data: { results: body.operations.map((_, i) => ({ resourceName: `rn-${i}` })) } };
    },
    _calls: calls,
  };
}

describe('dismissRecommendations', () => {
  test('empty array → no calls', async () => {
    const ctx = fakeMutateCtx();
    const result = await dismissRecommendations(ctx, []);
    expect(result.dismissed).toBe(0);
    expect(ctx._calls).toEqual([]);
  });

  test('5 rec resourceNames → one mutate call with 5 operations', async () => {
    const ctx = fakeMutateCtx();
    const recs = ['rn-1', 'rn-2', 'rn-3', 'rn-4', 'rn-5'];
    const result = await dismissRecommendations(ctx, recs);
    expect(result.dismissed).toBe(5);
    expect(ctx._calls).toHaveLength(1);
    expect(ctx._calls[0].url).toMatch(/recommendations:dismiss/);
    expect(ctx._calls[0].body.operations).toHaveLength(5);
    expect(ctx._calls[0].body.operations[0]).toEqual({ resourceName: 'rn-1' });
  });

  test('1500 recs → split into two mutate calls (1000 + 500)', async () => {
    const ctx = fakeMutateCtx();
    const recs = Array.from({ length: 1500 }, (_, i) => `rn-${i}`);
    const result = await dismissRecommendations(ctx, recs);
    expect(result.dismissed).toBe(1500);
    expect(ctx._calls).toHaveLength(2);
    expect(ctx._calls[0].body.operations).toHaveLength(1000);
    expect(ctx._calls[1].body.operations).toHaveLength(500);
  });
});

describe('mutateRemoveAssets', () => {
  test('empty array → no calls', async () => {
    const ctx = fakeMutateCtx();
    const result = await mutateRemoveAssets(ctx, []);
    expect(result.removed).toBe(0);
    expect(ctx._calls).toEqual([]);
  });

  test('mixed asset link types → one mutate per type', async () => {
    const ctx = fakeMutateCtx();
    const assets = [
      'customers/111/customerAssets/AAA',
      'customers/111/campaignAssets/BBB',
      'customers/111/customerAssets/CCC',
      'customers/111/adGroupAdAssetViews/DDD',
    ];
    const result = await mutateRemoveAssets(ctx, assets);
    expect(result.removed).toBe(4);
    const urls = ctx._calls.map(c => c.url);
    expect(urls.some(u => u.includes('customerAssets'))).toBe(true);
    expect(urls.some(u => u.includes('campaignAssets'))).toBe(true);
    expect(urls.some(u => u.includes('adGroupAdAssets'))).toBe(true);
  });

  test('per-type batching: 1500 customerAssets → split into two', async () => {
    const ctx = fakeMutateCtx();
    const assets = Array.from({ length: 1500 }, (_, i) => `customers/111/customerAssets/${i}`);
    const result = await mutateRemoveAssets(ctx, assets);
    expect(result.removed).toBe(1500);
    expect(ctx._calls).toHaveLength(2);
  });
});
