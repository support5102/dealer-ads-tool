/**
 * Tests for google-ads.getVlaDailyMetrics — per-VLA-campaign daily breakdown.
 *
 * Uses restCtx._queryFn injection to stub the two GAQL calls (VLA campaign
 * discovery, then the daily metrics pull) with no network.
 */

const googleAds = require('../../src/services/google-ads');

function ctx(queryFn) {
  return { accessToken: 'x', developerToken: 'x', customerId: '123', loginCustomerId: '999', _queryFn: queryFn };
}

test('breaks metrics out per campaign, summing rows that share a campaign+day, sorted by name', async () => {
  const campaigns = await googleAds.getVlaDailyMetrics(ctx(async (at, dt, cid, query) => {
    if (/advertising_channel_type/.test(query)) {
      return [
        { campaign: { id: 111, name: 'Alpha VLA',     advertisingChannelType: 'PERFORMANCE_MAX', shoppingSetting: {} } },
        { campaign: { id: 333, name: 'Beta Vehicle',  advertisingChannelType: 'PERFORMANCE_MAX', shoppingSetting: {} } },
        { campaign: { id: 222, name: 'Brand Search',  advertisingChannelType: 'SHOPPING', shoppingSetting: {} } }, // not VLA
      ];
    }
    // Daily rows carry campaign.id + name. Two 111/07-02 rows must sum.
    return [
      { campaign: { id: 111, name: 'Alpha VLA' },    segments: { date: '2026-07-02' }, metrics: { clicks: 5, impressions: 100, costMicros: 2_000_000 } },
      { campaign: { id: 111, name: 'Alpha VLA' },    segments: { date: '2026-07-01' }, metrics: { clicks: 3, impressions: 50,  costMicros: 1_000_000 } },
      { campaign: { id: 111, name: 'Alpha VLA' },    segments: { date: '2026-07-02' }, metrics: { clicks: 2, impressions: 40,  costMicros: 500_000 } },
      { campaign: { id: 333, name: 'Beta Vehicle' }, segments: { date: '2026-07-02' }, metrics: { clicks: 10, impressions: 200, costMicros: 4_000_000 } },
    ];
  }));

  expect(campaigns.map(c => c.name)).toEqual(['Alpha VLA', 'Beta Vehicle']); // sorted by name
  expect(campaigns[0]).toEqual({
    campaignId: '111',
    name: 'Alpha VLA',
    days: [
      { date: '2026-07-01', clicks: 3, impressions: 50, cost: 1.00 },
      { date: '2026-07-02', clicks: 7, impressions: 140, cost: 2.50 },
    ],
  });
  expect(campaigns[1]).toEqual({
    campaignId: '333',
    name: 'Beta Vehicle',
    days: [{ date: '2026-07-02', clicks: 10, impressions: 200, cost: 4.00 }],
  });
});

test('returns [] when the account has no VLA campaigns (never runs the metrics query)', async () => {
  let metricsQueried = false;
  const campaigns = await googleAds.getVlaDailyMetrics(ctx(async (at, dt, cid, query) => {
    if (/advertising_channel_type/.test(query)) {
      return [{ campaign: { id: 222, name: 'Brand Search', advertisingChannelType: 'SHOPPING', shoppingSetting: {} } }];
    }
    metricsQueried = true;
    return [{ campaign: { id: 222, name: 'Brand Search' }, segments: { date: '2026-07-01' }, metrics: { clicks: 1, impressions: 1, costMicros: 1 } }];
  }));

  expect(campaigns).toEqual([]);
  expect(metricsQueried).toBe(false);
});

test('reads cost from either costMicros or cost_micros field spelling', async () => {
  const campaigns = await googleAds.getVlaDailyMetrics(ctx(async (at, dt, cid, query) => {
    if (/advertising_channel_type/.test(query)) {
      return [{ campaign: { id: 111, name: 'VLA Inventory', advertisingChannelType: 'SHOPPING', shoppingSetting: { merchantId: 9 } } }];
    }
    return [{ campaign: { id: 111, name: 'VLA Inventory' }, segments: { date: '2026-07-01' }, metrics: { clicks: 1, impressions: 10, cost_micros: 3_500_000 } }];
  }));
  expect(campaigns[0].days[0].cost).toBe(3.5);
});
