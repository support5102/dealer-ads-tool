/**
 * Tests for google-ads.getVlaDailyMetrics — VLA campaign daily aggregation.
 *
 * Uses restCtx._queryFn injection to stub the two GAQL calls (VLA campaign
 * discovery, then the daily metrics pull) with no network.
 */

const googleAds = require('../../src/services/google-ads');

function ctx(queryFn) {
  return { accessToken: 'x', developerToken: 'x', customerId: '123', loginCustomerId: '999', _queryFn: queryFn };
}

test('aggregates daily clicks/impressions/cost across VLA campaigns, sorted ascending', async () => {
  const series = await googleAds.getVlaDailyMetrics(ctx(async (at, dt, cid, query) => {
    if (/advertising_channel_type/.test(query)) {
      return [
        { campaign: { id: 111, name: 'Vehicle PMax', advertisingChannelType: 'PERFORMANCE_MAX', shoppingSetting: {} } },
        { campaign: { id: 222, name: 'Brand Search', advertisingChannelType: 'SHOPPING', shoppingSetting: {} } }, // not VLA
      ];
    }
    // Daily rows (per-campaign-per-day). Two rows share 2026-07-02 → must sum.
    return [
      { segments: { date: '2026-07-02' }, metrics: { clicks: 5, impressions: 100, costMicros: 2_000_000 } },
      { segments: { date: '2026-07-01' }, metrics: { clicks: 3, impressions: 50, costMicros: 1_000_000 } },
      { segments: { date: '2026-07-02' }, metrics: { clicks: 2, impressions: 40, costMicros: 500_000 } },
    ];
  }));

  expect(series.map(d => d.date)).toEqual(['2026-07-01', '2026-07-02']);
  expect(series[0]).toEqual({ date: '2026-07-01', clicks: 3, impressions: 50, cost: 1.00 });
  expect(series[1]).toEqual({ date: '2026-07-02', clicks: 7, impressions: 140, cost: 2.50 });
});

test('returns [] when the account has no VLA campaigns (never runs the metrics query)', async () => {
  let metricsQueried = false;
  const series = await googleAds.getVlaDailyMetrics(ctx(async (at, dt, cid, query) => {
    if (/advertising_channel_type/.test(query)) {
      return [{ campaign: { id: 222, name: 'Brand Search', advertisingChannelType: 'SHOPPING', shoppingSetting: {} } }];
    }
    metricsQueried = true;
    return [{ segments: { date: '2026-07-01' }, metrics: { clicks: 1, impressions: 1, costMicros: 1 } }];
  }));

  expect(series).toEqual([]);
  expect(metricsQueried).toBe(false);
});

test('reads cost from either costMicros or cost_micros field spelling', async () => {
  const series = await googleAds.getVlaDailyMetrics(ctx(async (at, dt, cid, query) => {
    if (/advertising_channel_type/.test(query)) {
      return [{ campaign: { id: 111, name: 'VLA Inventory', advertisingChannelType: 'SHOPPING', shoppingSetting: { merchantId: 9 } } }];
    }
    return [{ segments: { date: '2026-07-01' }, metrics: { clicks: 1, impressions: 10, cost_micros: 3_500_000 } }];
  }));
  expect(series[0].cost).toBe(3.5);
});
