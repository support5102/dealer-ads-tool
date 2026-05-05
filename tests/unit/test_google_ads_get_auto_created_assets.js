/**
 * Unit tests for getAutoCreatedAssets.
 *
 * Uses _queryFn injection to fake the four underlying GAQL queries.
 */

const { getAutoCreatedAssets } = require('../../src/services/google-ads');

function fakeCtx(rowsPerQuery) {
  let callIdx = 0;
  return {
    accessToken: 'tok',
    developerToken: 'dev',
    customerId: '111',
    loginCustomerId: '999',
    _queryFn: async (_t, _d, _cid, query) => {
      const result = rowsPerQuery[callIdx] || [];
      callIdx += 1;
      return result;
    },
  };
}

describe('getAutoCreatedAssets', () => {
  test('empty across all queries → returns empty array', async () => {
    const result = await getAutoCreatedAssets(fakeCtx([[], [], [], []]));
    expect(result).toEqual([]);
  });

  test('customer-level callout → returned with scope=customer, type=CALLOUT', async () => {
    const customerRow = {
      customerAsset: { asset: 'customers/111/assets/42', resourceName: 'customers/111/customerAssets/42~CALLOUT', fieldType: 'CALLOUT' },
      asset: { id: '42', calloutAsset: { calloutText: 'Free Wi-Fi' } },
    };
    const result = await getAutoCreatedAssets(fakeCtx([[customerRow], [], [], []]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      resourceName: 'customers/111/customerAssets/42~CALLOUT',
      type: 'CALLOUT',
      text: 'Free Wi-Fi',
      scope: 'customer',
    });
  });

  test('campaign-level sitelink → scope=campaign, type=SITELINK', async () => {
    const campaignRow = {
      campaignAsset: { asset: 'customers/111/assets/43', resourceName: 'customers/111/campaignAssets/X~SITELINK', fieldType: 'SITELINK' },
      asset: { id: '43', sitelinkAsset: { linkText: 'View specials' } },
    };
    const result = await getAutoCreatedAssets(fakeCtx([[], [campaignRow], [], []]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      resourceName: 'customers/111/campaignAssets/X~SITELINK',
      type: 'SITELINK',
      text: 'View specials',
      scope: 'campaign',
    });
  });

  test('ad-group-level structured snippet → scope=ad_group, type=STRUCTURED_SNIPPET', async () => {
    const agRow = {
      adGroupAsset: { asset: 'customers/111/assets/44', resourceName: 'customers/111/adGroupAssets/X~Y~STRUCTURED_SNIPPET', fieldType: 'STRUCTURED_SNIPPET' },
      asset: { id: '44', structuredSnippetAsset: { header: 'Models' } },
    };
    const result = await getAutoCreatedAssets(fakeCtx([[], [], [agRow], []]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'STRUCTURED_SNIPPET',
      text: 'Models',
      scope: 'ad_group',
    });
  });

  test('RSA headline (ad_group_ad_asset_view) → scope=ad_group_ad, type=HEADLINE', async () => {
    const adAssetRow = {
      adGroupAdAssetView: {
        resourceName: 'customers/111/adGroupAdAssetViews/X~Y~Z~HEADLINE',
        fieldType: 'HEADLINE',
        automaticallyCreated: true,
      },
      asset: { id: '45', textAsset: { text: 'Best Honda Deals' } },
    };
    const result = await getAutoCreatedAssets(fakeCtx([[], [], [], [adAssetRow]]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'HEADLINE',
      text: 'Best Honda Deals',
      scope: 'ad_group_ad',
    });
  });

  test('RSA description (ad_group_ad_asset_view) → type=DESCRIPTION', async () => {
    const adAssetRow = {
      adGroupAdAssetView: {
        resourceName: 'customers/111/adGroupAdAssetViews/X~Y~Z~DESCRIPTION',
        fieldType: 'DESCRIPTION',
        automaticallyCreated: true,
      },
      asset: { id: '46', textAsset: { text: 'Visit us today' } },
    };
    const result = await getAutoCreatedAssets(fakeCtx([[], [], [], [adAssetRow]]));
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('DESCRIPTION');
  });

  test('mixed across all four queries → flat array preserves order', async () => {
    const customerRow = { customerAsset: { asset: 'customers/111/assets/1', resourceName: 'rn1', fieldType: 'CALLOUT' }, asset: { id: '1', calloutAsset: { calloutText: 'A' } } };
    const campaignRow = { campaignAsset: { asset: 'customers/111/assets/2', resourceName: 'rn2', fieldType: 'SITELINK' }, asset: { id: '2', sitelinkAsset: { linkText: 'B' } } };
    const result = await getAutoCreatedAssets(fakeCtx([[customerRow], [campaignRow], [], []]));
    expect(result).toHaveLength(2);
    expect(result.map(r => r.text)).toEqual(['A', 'B']);
  });

  test('underlying query throws → returns empty array, error logged', async () => {
    const errCtx = {
      accessToken: 'tok', developerToken: 'dev', customerId: '111', loginCustomerId: '999',
      _queryFn: async () => { throw new Error('API error'); },
    };
    const result = await getAutoCreatedAssets(errCtx);
    expect(result).toEqual([]);
  });
});
