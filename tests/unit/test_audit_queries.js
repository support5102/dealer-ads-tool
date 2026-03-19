/**
 * Unit tests for Phase 9 audit/optimization GAQL query functions in google-ads.js.
 *
 * Tier 2 (unit): uses _queryFn injection with fake data, no real API calls.
 * Data is in REST/camelCase format (what Google Ads REST API returns).
 *
 * Tests: getKeywordPerformance, getCampaignPerformance, getAdCopy, getRecommendations, getAdSchedules
 */

const {
  getKeywordPerformance,
  getCampaignPerformance,
  getAdCopy,
  getRecommendations,
  getAdSchedules,
} = require('../../src/services/google-ads');

/**
 * Creates a restCtx with a fake query function that returns the given rows.
 */
function fakeCtx(rows) {
  return {
    accessToken: 'fake-token',
    developerToken: 'fake-dev',
    customerId: '1234567890',
    loginCustomerId: '9999999999',
    _queryFn: async () => rows,
  };
}

// ===========================================================================
// getKeywordPerformance
// ===========================================================================

describe('getKeywordPerformance', () => {
  const defaultRows = [
    {
      adGroupCriterion: {
        keyword: { text: 'honda civic', matchType: 'EXACT' },
        status: 'ENABLED',
        negative: false,
        cpcBidMicros: 3500000,
      },
      adGroup: { name: 'SD: Civic', id: '1001' },
      campaign: { name: 'Honda Civic - Search', id: '100' },
      metrics: {
        clicks: 42,
        impressions: 580,
        averageCpc: 2100000,
        ctr: 0.0724,
        searchImpressionShare: 0.82,
      },
    },
    {
      adGroupCriterion: {
        keyword: { text: 'ford f-150', matchType: 'PHRASE' },
        status: 'ENABLED',
        negative: false,
        cpcBidMicros: 5000000,
      },
      adGroup: { name: 'SD: F-150', id: '2001' },
      campaign: { name: 'Ford F-150 - Search', id: '200' },
      metrics: {
        clicks: 15,
        impressions: 320,
        averageCpc: 4200000,
        ctr: 0.0469,
        searchImpressionShare: 0.65,
      },
    },
  ];

  test('returns keyword performance with all fields', async () => {
    const results = await getKeywordPerformance(fakeCtx(defaultRows));
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      keyword: 'honda civic',
      matchType: 'EXACT',
      status: 'ENABLED',
      negative: false,
      cpcBid: 3.50,
      adGroupName: 'SD: Civic',
      adGroupId: '1001',
      campaignName: 'Honda Civic - Search',
      campaignId: '100',
      clicks: 42,
      impressions: 580,
      averageCpc: 2.10,
      ctr: 0.0724,
      searchImpressionShare: 0.82,
    });
  });

  test('converts micros to dollars for CPC fields', async () => {
    const results = await getKeywordPerformance(fakeCtx(defaultRows));
    expect(results[1].cpcBid).toBe(5.00);
    expect(results[1].averageCpc).toBe(4.20);
  });

  test('handles missing metrics gracefully', async () => {
    const results = await getKeywordPerformance(fakeCtx([{
      adGroupCriterion: {
        keyword: { text: 'test', matchType: 'EXACT' },
        status: 'ENABLED',
        negative: false,
      },
      adGroup: { name: 'AG1', id: '1' },
      campaign: { name: 'Camp1', id: '1' },
      metrics: {},
    }]));
    expect(results[0].clicks).toBe(0);
    expect(results[0].impressions).toBe(0);
    expect(results[0].averageCpc).toBe(0);
    expect(results[0].ctr).toBe(0);
    expect(results[0].searchImpressionShare).toBeNull();
  });

  test('handles empty rows', async () => {
    const results = await getKeywordPerformance(fakeCtx([]));
    expect(results).toEqual([]);
  });

  test('handles null metrics object', async () => {
    const results = await getKeywordPerformance(fakeCtx([{
      adGroupCriterion: {
        keyword: { text: 'test', matchType: 'EXACT' },
        status: 'ENABLED',
        negative: false,
      },
      adGroup: { name: 'AG1', id: '1' },
      campaign: { name: 'Camp1', id: '1' },
    }]));
    expect(results[0].clicks).toBe(0);
    expect(results[0].cpcBid).toBe(0);
  });

  test('handles negative keywords', async () => {
    const results = await getKeywordPerformance(fakeCtx([{
      adGroupCriterion: {
        keyword: { text: 'cheap', matchType: 'PHRASE' },
        status: 'ENABLED',
        negative: true,
        cpcBidMicros: 0,
      },
      adGroup: { name: 'AG1', id: '1' },
      campaign: { name: 'Camp1', id: '1' },
      metrics: { clicks: 0, impressions: 0 },
    }]));
    expect(results[0].negative).toBe(true);
  });
});

// ===========================================================================
// getCampaignPerformance
// ===========================================================================

describe('getCampaignPerformance', () => {
  const defaultRows = [
    {
      campaign: { id: '100', name: 'Honda Civic - Search', status: 'ENABLED', advertisingChannelType: 'SEARCH' },
      metrics: {
        clicks: 250, impressions: 4800, conversions: 35, conversionsValue: 12500,
        costMicros: 85000000, ctr: 0.052, averageCpc: 3400000, searchImpressionShare: 0.78,
      },
    },
    {
      campaign: { id: '300', name: 'PMax: VLA Ads - New', status: 'ENABLED', advertisingChannelType: 'PERFORMANCE_MAX' },
      metrics: {
        clicks: 180, impressions: 12000, conversions: 60, conversionsValue: 0,
        costMicros: 120000000, ctr: 0.015, averageCpc: 667000, searchImpressionShare: null,
      },
    },
  ];

  test('returns campaign performance with all fields', async () => {
    const results = await getCampaignPerformance(fakeCtx(defaultRows));
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      campaignId: '100',
      campaignName: 'Honda Civic - Search',
      status: 'ENABLED',
      channelType: 'SEARCH',
      clicks: 250,
      impressions: 4800,
      conversions: 35,
      conversionValue: 12500,
      cost: 85.00,
      ctr: 0.052,
      averageCpc: 3.40,
      searchImpressionShare: 0.78,
    });
  });

  test('handles PMax campaigns with null impression share', async () => {
    const results = await getCampaignPerformance(fakeCtx(defaultRows));
    expect(results[1].channelType).toBe('PERFORMANCE_MAX');
    expect(results[1].searchImpressionShare).toBeNull();
  });

  test('converts cost micros to dollars', async () => {
    const results = await getCampaignPerformance(fakeCtx(defaultRows));
    expect(results[1].cost).toBe(120.00);
    expect(results[1].averageCpc).toBeCloseTo(0.667, 3);
  });

  test('handles missing metrics', async () => {
    const results = await getCampaignPerformance(fakeCtx([{
      campaign: { id: '1', name: 'Test', status: 'PAUSED' },
    }]));
    expect(results[0].clicks).toBe(0);
    expect(results[0].cost).toBe(0);
  });

  test('handles empty rows', async () => {
    const results = await getCampaignPerformance(fakeCtx([]));
    expect(results).toEqual([]);
  });
});

// ===========================================================================
// getAdCopy
// ===========================================================================

describe('getAdCopy', () => {
  const defaultRows = [{
    adGroupAd: {
      ad: {
        id: '5001',
        responsiveSearchAd: {
          headlines: [
            { text: 'New Honda Civic For Sale', pinnedField: 'HEADLINE_1' },
            { text: '2026 Honda Civic', pinnedField: null },
          ],
          descriptions: [
            { text: 'Visit our showroom today.', pinnedField: null },
          ],
        },
        finalUrls: ['https://dealer.com/new/civic'],
      },
      policySummary: {
        approvalStatus: 'APPROVED',
        policyTopicEntries: [],
      },
      status: 'ENABLED',
    },
    adGroup: { name: 'SD: Civic' },
    campaign: { name: 'Honda Civic - Search' },
  }];

  test('returns ad copy with all fields', async () => {
    const results = await getAdCopy(fakeCtx(defaultRows));
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      adId: '5001',
      headlines: [
        { text: 'New Honda Civic For Sale', pinnedField: 'HEADLINE_1' },
        { text: '2026 Honda Civic', pinnedField: null },
      ],
      descriptions: [
        { text: 'Visit our showroom today.', pinnedField: null },
      ],
      finalUrls: ['https://dealer.com/new/civic'],
      approvalStatus: 'APPROVED',
      policyTopics: [],
      status: 'ENABLED',
      adGroupName: 'SD: Civic',
      campaignName: 'Honda Civic - Search',
    });
  });

  test('handles disapproved ads with policy topics', async () => {
    const results = await getAdCopy(fakeCtx([{
      adGroupAd: {
        ad: { id: '5002', responsiveSearchAd: { headlines: [], descriptions: [] }, finalUrls: [] },
        policySummary: {
          approvalStatus: 'DISAPPROVED',
          policyTopicEntries: [{ topic: 'MISLEADING_CONTENT', type: 'PROHIBITED' }],
        },
        status: 'ENABLED',
      },
      adGroup: { name: 'AG1' },
      campaign: { name: 'Camp1' },
    }]));
    expect(results[0].approvalStatus).toBe('DISAPPROVED');
    expect(results[0].policyTopics).toEqual([{ topic: 'MISLEADING_CONTENT', type: 'PROHIBITED' }]);
  });

  test('handles missing RSA data', async () => {
    const results = await getAdCopy(fakeCtx([{
      adGroupAd: { ad: { id: '5003' }, status: 'ENABLED' },
      adGroup: { name: 'AG1' },
      campaign: { name: 'Camp1' },
    }]));
    expect(results[0].headlines).toEqual([]);
    expect(results[0].descriptions).toEqual([]);
    expect(results[0].finalUrls).toEqual([]);
  });

  test('handles empty rows', async () => {
    const results = await getAdCopy(fakeCtx([]));
    expect(results).toEqual([]);
  });
});

// ===========================================================================
// getRecommendations
// ===========================================================================

describe('getRecommendations', () => {
  test('returns recommendation data', async () => {
    const results = await getRecommendations(fakeCtx([{
      recommendation: {
        resourceName: 'customers/123/recommendations/rec1',
        type: 'ENHANCED_CPC_OPT_IN',
        campaign: 'customers/123/campaigns/100',
        adGroup: null,
      },
    }]));
    expect(results).toEqual([{
      resourceName: 'customers/123/recommendations/rec1',
      type: 'ENHANCED_CPC_OPT_IN',
      campaignResourceName: 'customers/123/campaigns/100',
      adGroupResourceName: null,
    }]);
  });

  test('handles multiple recommendations', async () => {
    const results = await getRecommendations(fakeCtx([
      { recommendation: { resourceName: 'r1', type: 'KEYWORD', campaign: 'c1' } },
      { recommendation: { resourceName: 'r2', type: 'TARGET_CPA_OPT_IN', campaign: 'c2' } },
    ]));
    expect(results).toHaveLength(2);
  });

  test('returns empty array on API error (non-fatal)', async () => {
    const ctx = {
      ...fakeCtx([]),
      _queryFn: async () => { throw new Error('API error'); },
    };
    const results = await getRecommendations(ctx);
    expect(results).toEqual([]);
  });

  test('handles empty rows', async () => {
    const results = await getRecommendations(fakeCtx([]));
    expect(results).toEqual([]);
  });
});

// ===========================================================================
// getAdSchedules
// ===========================================================================

describe('getAdSchedules', () => {
  const defaultRows = [
    {
      campaignCriterion: {
        adSchedule: { dayOfWeek: 'MONDAY', startHour: 8, startMinute: 30, endHour: 19, endMinute: 0 },
      },
      campaign: { name: 'Honda Civic - Search', id: '100' },
    },
    {
      campaignCriterion: {
        adSchedule: { dayOfWeek: 'SATURDAY', startHour: 8, startMinute: 30, endHour: 20, endMinute: 30 },
      },
      campaign: { name: 'Honda Civic - Search', id: '100' },
    },
  ];

  test('returns ad schedule data', async () => {
    const results = await getAdSchedules(fakeCtx(defaultRows));
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      campaignName: 'Honda Civic - Search',
      campaignId: '100',
      dayOfWeek: 'MONDAY',
      startHour: 8,
      startMinute: 30,
      endHour: 19,
      endMinute: 0,
    });
  });

  test('handles Saturday extended hours', async () => {
    const results = await getAdSchedules(fakeCtx(defaultRows));
    expect(results[1].dayOfWeek).toBe('SATURDAY');
    expect(results[1].endHour).toBe(20);
    expect(results[1].endMinute).toBe(30);
  });

  test('returns empty array on API error (non-fatal)', async () => {
    const ctx = {
      ...fakeCtx([]),
      _queryFn: async () => { throw new Error('Not authorized'); },
    };
    const results = await getAdSchedules(ctx);
    expect(results).toEqual([]);
  });

  test('handles empty rows', async () => {
    const results = await getAdSchedules(fakeCtx([]));
    expect(results).toEqual([]);
  });

  test('handles missing schedule fields with defaults', async () => {
    const results = await getAdSchedules(fakeCtx([{
      campaignCriterion: { adSchedule: {} },
      campaign: { name: 'Test', id: '1' },
    }]));
    expect(results[0].dayOfWeek).toBe('');
    expect(results[0].startHour).toBe(0);
    expect(results[0].endHour).toBe(0);
  });
});
