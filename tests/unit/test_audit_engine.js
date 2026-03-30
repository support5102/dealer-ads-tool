/**
 * Tier 2 Audit Engine Tests — validates all 10 audit checks + runAudit orchestration.
 *
 * Tests: src/services/audit-engine.js
 * Uses: direct function calls with sample data (no fakes needed)
 */

const {
  checkBiddingStrategy,
  checkBroadMatchKeywords,
  checkZeroImpressionKeywords,
  checkDisapprovedAds,
  checkHighCpc,
  checkLowCtrCampaigns,
  checkPendingRecommendations,
  checkMissingAdSchedules,
  checkZeroSpendCampaigns,
  checkNamingConventions,
  checkLowImpressionShare,
  runAudit,
  SEVERITY,
} = require('../../src/services/audit-engine');

// ── Sample data factories ──

function makeCampaign(overrides = {}) {
  return {
    campaignId: '100',
    campaignName: 'Test Dealer - New - F-150',
    status: 'ENABLED',
    channelType: 'SEARCH',
    clicks: 50,
    impressions: 1000,
    conversions: 5,
    cost: 200,
    ctr: 0.05,
    averageCpc: 4.0,
    biddingStrategy: 'MANUAL_CPC',
    ...overrides,
  };
}

function makeKeyword(overrides = {}) {
  return {
    keyword: 'ford f-150',
    matchType: 'EXACT',
    status: 'ENABLED',
    negative: false,
    clicks: 10,
    impressions: 200,
    averageCpc: 3.50,
    ctr: 0.05,
    campaignName: 'Test Dealer - New - F-150',
    adGroupName: 'SD: F-150',
    ...overrides,
  };
}

function makeAd(overrides = {}) {
  return {
    adId: '1001',
    headlines: [{ text: 'Buy F-150', pinnedField: null }],
    descriptions: [{ text: 'Great deals', pinnedField: null }],
    finalUrls: ['https://dealer.com/new-f150'],
    approvalStatus: 'APPROVED',
    policyTopics: [],
    status: 'ENABLED',
    adGroupName: 'SD: F-150',
    campaignName: 'Test Dealer - New - F-150',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// Check 1: Bidding Strategy
// ─────────────────────────────────────────────────────────────
describe('checkBiddingStrategy', () => {
  test('passes when all Search campaigns use Manual CPC', () => {
    const campaigns = [
      makeCampaign({ biddingStrategy: 'MANUAL_CPC' }),
      makeCampaign({ campaignId: '200', biddingStrategy: 'MANUAL_CPC' }),
    ];
    expect(checkBiddingStrategy(campaigns)).toEqual([]);
  });

  test('flags Search campaign using Target CPA', () => {
    const campaigns = [makeCampaign({ biddingStrategy: 'TARGET_CPA' })];
    const results = checkBiddingStrategy(campaigns);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe(SEVERITY.CRITICAL);
    expect(results[0].checkId).toBe('bidding_not_manual_cpc');
    expect(results[0].details.currentStrategy).toBe('TARGET_CPA');
  });

  test('ignores paused campaigns', () => {
    const campaigns = [makeCampaign({ status: 'PAUSED', biddingStrategy: 'TARGET_CPA' })];
    expect(checkBiddingStrategy(campaigns)).toEqual([]);
  });

  test('ignores PMax campaigns (they use Maximize Conversions by design)', () => {
    const campaigns = [makeCampaign({ channelType: 'PERFORMANCE_MAX', biddingStrategy: 'MAXIMIZE_CONVERSIONS' })];
    expect(checkBiddingStrategy(campaigns)).toEqual([]);
  });

  test('flags multiple non-Manual-CPC campaigns', () => {
    const campaigns = [
      makeCampaign({ campaignId: '100', biddingStrategy: 'TARGET_CPA' }),
      makeCampaign({ campaignId: '200', biddingStrategy: 'MAXIMIZE_CLICKS', campaignName: 'Another Campaign' }),
    ];
    expect(checkBiddingStrategy(campaigns)).toHaveLength(2);
  });

  test('flags Enhanced CPC enabled on Manual CPC campaign', () => {
    const campaigns = [makeCampaign({ biddingStrategy: 'MANUAL_CPC', ecpcEnabled: true })];
    const results = checkBiddingStrategy(campaigns);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe(SEVERITY.WARNING);
    expect(results[0].checkId).toBe('ecpc_enabled');
  });

  test('passes when Manual CPC with ECPC disabled', () => {
    const campaigns = [makeCampaign({ biddingStrategy: 'MANUAL_CPC', ecpcEnabled: false })];
    expect(checkBiddingStrategy(campaigns)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Check 2: Broad Match Keywords
// ─────────────────────────────────────────────────────────────
describe('checkBroadMatchKeywords', () => {
  test('passes when no Broad match keywords exist', () => {
    const keywords = [
      makeKeyword({ matchType: 'EXACT' }),
      makeKeyword({ matchType: 'PHRASE' }),
    ];
    expect(checkBroadMatchKeywords(keywords)).toEqual([]);
  });

  test('flags Broad match keywords', () => {
    const keywords = [
      makeKeyword({ matchType: 'BROAD', keyword: 'ford trucks' }),
      makeKeyword({ matchType: 'BROAD', keyword: 'ford f150' }),
    ];
    const results = checkBroadMatchKeywords(keywords);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe(SEVERITY.CRITICAL);
    expect(results[0].details.count).toBe(2);
  });

  test('ignores Broad match negative keywords', () => {
    const keywords = [makeKeyword({ matchType: 'BROAD', negative: true })];
    expect(checkBroadMatchKeywords(keywords)).toEqual([]);
  });

  test('ignores paused Broad match keywords', () => {
    const keywords = [makeKeyword({ matchType: 'BROAD', status: 'PAUSED' })];
    expect(checkBroadMatchKeywords(keywords)).toEqual([]);
  });

  test('groups Broad keywords by campaign in details', () => {
    const keywords = [
      makeKeyword({ matchType: 'BROAD', keyword: 'ford trucks', campaignName: 'Campaign A' }),
      makeKeyword({ matchType: 'BROAD', keyword: 'ford deals', campaignName: 'Campaign B' }),
    ];
    const results = checkBroadMatchKeywords(keywords);
    expect(results[0].details.byCampaign['Campaign A']).toContain('ford trucks');
    expect(results[0].details.byCampaign['Campaign B']).toContain('ford deals');
  });
});

// ─────────────────────────────────────────────────────────────
// Check 3: Zero Impression Keywords
// ─────────────────────────────────────────────────────────────
describe('checkZeroImpressionKeywords', () => {
  test('passes when few keywords have zero impressions', () => {
    const keywords = [
      makeKeyword({ impressions: 0 }),
      makeKeyword({ impressions: 0 }),
    ];
    // Threshold is >5
    expect(checkZeroImpressionKeywords(keywords)).toEqual([]);
  });

  test('flags when many keywords have zero impressions', () => {
    const keywords = Array.from({ length: 8 }, (_, i) =>
      makeKeyword({ keyword: `kw-${i}`, impressions: 0 })
    );
    const results = checkZeroImpressionKeywords(keywords);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe(SEVERITY.WARNING);
    expect(results[0].details.count).toBe(8);
    expect(results[0].details.sample.length).toBeLessThanOrEqual(10);
  });

  test('ignores negative keywords with zero impressions', () => {
    const keywords = Array.from({ length: 8 }, () =>
      makeKeyword({ impressions: 0, negative: true })
    );
    expect(checkZeroImpressionKeywords(keywords)).toEqual([]);
  });

  test('ignores paused keywords', () => {
    const keywords = Array.from({ length: 8 }, () =>
      makeKeyword({ impressions: 0, status: 'PAUSED' })
    );
    expect(checkZeroImpressionKeywords(keywords)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Check 4: Disapproved Ads
// ─────────────────────────────────────────────────────────────
describe('checkDisapprovedAds', () => {
  test('passes when all ads are approved', () => {
    const ads = [makeAd({ approvalStatus: 'APPROVED' })];
    expect(checkDisapprovedAds(ads)).toEqual([]);
  });

  test('flags disapproved ads as critical', () => {
    const ads = [makeAd({ approvalStatus: 'DISAPPROVED', policyTopics: [{ topic: 'Misleading', type: 'CRITICAL' }] })];
    const results = checkDisapprovedAds(ads);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe(SEVERITY.CRITICAL);
    expect(results[0].checkId).toBe('disapproved_ads');
    expect(results[0].details.count).toBe(1);
  });

  test('flags limited approval ads as warning', () => {
    const ads = [makeAd({ approvalStatus: 'APPROVED_LIMITED' })];
    const results = checkDisapprovedAds(ads);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe(SEVERITY.WARNING);
    expect(results[0].checkId).toBe('limited_ads');
  });

  test('flags both disapproved and limited separately', () => {
    const ads = [
      makeAd({ adId: '1', approvalStatus: 'DISAPPROVED' }),
      makeAd({ adId: '2', approvalStatus: 'APPROVED_LIMITED' }),
    ];
    const results = checkDisapprovedAds(ads);
    expect(results).toHaveLength(2);
    expect(results[0].checkId).toBe('disapproved_ads');
    expect(results[1].checkId).toBe('limited_ads');
  });

  test('caps sample at 5 ads', () => {
    const ads = Array.from({ length: 10 }, (_, i) =>
      makeAd({ adId: String(i), approvalStatus: 'DISAPPROVED' })
    );
    const results = checkDisapprovedAds(ads);
    expect(results[0].details.ads).toHaveLength(5);
  });
});

// ─────────────────────────────────────────────────────────────
// Check 5: High CPC
// ─────────────────────────────────────────────────────────────
describe('checkHighCpc', () => {
  test('passes when all CPCs are normal', () => {
    const keywords = [makeKeyword({ averageCpc: 5.00, clicks: 10 })];
    expect(checkHighCpc(keywords)).toEqual([]);
  });

  test('flags keywords above $15 CPC ceiling', () => {
    const keywords = [makeKeyword({ averageCpc: 18.00, clicks: 5 })];
    const results = checkHighCpc(keywords);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe(SEVERITY.WARNING);
    expect(results[0].details.keywords[0].averageCpc).toBe(18);
  });

  test('ignores keywords with 0 clicks (no CPC data)', () => {
    const keywords = [makeKeyword({ averageCpc: 20.00, clicks: 0 })];
    expect(checkHighCpc(keywords)).toEqual([]);
  });

  test('ignores negative keywords', () => {
    const keywords = [makeKeyword({ averageCpc: 20.00, clicks: 5, negative: true })];
    expect(checkHighCpc(keywords)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Check 6: Low CTR Campaigns
// ─────────────────────────────────────────────────────────────
describe('checkLowCtrCampaigns', () => {
  test('passes when CTR is healthy', () => {
    const campaigns = [makeCampaign({ ctr: 0.05, impressions: 500 })];
    expect(checkLowCtrCampaigns(campaigns)).toEqual([]);
  });

  test('flags Search campaigns below 2% CTR', () => {
    const campaigns = [makeCampaign({ ctr: 0.01, impressions: 500 })];
    const results = checkLowCtrCampaigns(campaigns);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe(SEVERITY.WARNING);
  });

  test('ignores campaigns with low impressions (not enough data)', () => {
    const campaigns = [makeCampaign({ ctr: 0.005, impressions: 50 })];
    expect(checkLowCtrCampaigns(campaigns)).toEqual([]);
  });

  test('ignores PMax campaigns', () => {
    const campaigns = [makeCampaign({ channelType: 'PERFORMANCE_MAX', ctr: 0.005, impressions: 500 })];
    expect(checkLowCtrCampaigns(campaigns)).toEqual([]);
  });

  test('ignores paused campaigns', () => {
    const campaigns = [makeCampaign({ status: 'PAUSED', ctr: 0.005, impressions: 500 })];
    expect(checkLowCtrCampaigns(campaigns)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Check 7: Pending Recommendations
// ─────────────────────────────────────────────────────────────
describe('checkPendingRecommendations', () => {
  test('passes when fewer than 10 recommendations', () => {
    const recs = Array.from({ length: 5 }, () => ({ type: 'KEYWORD', resourceName: 'x' }));
    expect(checkPendingRecommendations(recs)).toEqual([]);
  });

  test('flags when more than 10 recommendations pending', () => {
    const recs = Array.from({ length: 15 }, (_, i) => ({
      type: i < 10 ? 'KEYWORD' : 'AD_SUGGESTION',
      resourceName: `rec-${i}`,
    }));
    const results = checkPendingRecommendations(recs);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe(SEVERITY.WARNING);
    expect(results[0].details.count).toBe(15);
    expect(results[0].details.types).toContain('KEYWORD');
    expect(results[0].details.types).toContain('AD_SUGGESTION');
  });

  test('passes on empty array', () => {
    expect(checkPendingRecommendations([])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Check 8: Missing Ad Schedules
// ─────────────────────────────────────────────────────────────
describe('checkMissingAdSchedules', () => {
  test('passes when all Search campaigns have schedules', () => {
    const campaigns = [makeCampaign({ campaignId: '100' })];
    const schedules = [{ campaignId: '100', dayOfWeek: 'MONDAY', startHour: 8, endHour: 20 }];
    expect(checkMissingAdSchedules(campaigns, schedules)).toEqual([]);
  });

  test('flags when some campaigns lack schedules (mixed state)', () => {
    const campaigns = [
      makeCampaign({ campaignId: '100' }),
      makeCampaign({ campaignId: '200', campaignName: 'Unscheduled' }),
    ];
    const schedules = [{ campaignId: '100', dayOfWeek: 'MONDAY', startHour: 8, endHour: 20 }];
    const results = checkMissingAdSchedules(campaigns, schedules);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe(SEVERITY.INFO);
    expect(results[0].details.count).toBe(1);
  });

  test('does not flag when NO campaigns have schedules (intentional 24/7)', () => {
    const campaigns = [makeCampaign({ campaignId: '100' })];
    expect(checkMissingAdSchedules(campaigns, [])).toEqual([]);
  });

  test('ignores paused campaigns', () => {
    const campaigns = [
      makeCampaign({ campaignId: '100' }),
      makeCampaign({ campaignId: '200', status: 'PAUSED' }),
    ];
    const schedules = [{ campaignId: '100', dayOfWeek: 'MONDAY', startHour: 8, endHour: 20 }];
    expect(checkMissingAdSchedules(campaigns, schedules)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Check 9: Zero Spend Campaigns
// ─────────────────────────────────────────────────────────────
describe('checkZeroSpendCampaigns', () => {
  test('passes when all enabled campaigns have spend', () => {
    const campaigns = [makeCampaign({ cost: 100, impressions: 500 })];
    expect(checkZeroSpendCampaigns(campaigns)).toEqual([]);
  });

  test('flags enabled campaigns with zero spend and impressions', () => {
    const campaigns = [makeCampaign({ cost: 0, impressions: 0 })];
    const results = checkZeroSpendCampaigns(campaigns);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe(SEVERITY.WARNING);
    expect(results[0].checkId).toBe('zero_spend_campaigns');
  });

  test('does not flag campaigns with impressions but zero cost (free clicks unlikely but possible)', () => {
    const campaigns = [makeCampaign({ cost: 0, impressions: 100 })];
    expect(checkZeroSpendCampaigns(campaigns)).toEqual([]);
  });

  test('ignores paused campaigns', () => {
    const campaigns = [makeCampaign({ status: 'PAUSED', cost: 0, impressions: 0 })];
    expect(checkZeroSpendCampaigns(campaigns)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Check 10: Naming Conventions
// ─────────────────────────────────────────────────────────────
describe('checkNamingConventions', () => {
  test('passes when names follow conventions', () => {
    const campaigns = [
      makeCampaign({ campaignName: 'Dealer Name - New - F-150', channelType: 'SEARCH' }),
      makeCampaign({ campaignName: 'PMax: VLA Ads - New', channelType: 'PERFORMANCE_MAX' }),
    ];
    expect(checkNamingConventions(campaigns)).toEqual([]);
  });

  test('flags PMax campaign without "PMax:" prefix', () => {
    const campaigns = [
      makeCampaign({ campaignName: 'Performance Max VLA', channelType: 'PERFORMANCE_MAX' }),
    ];
    const results = checkNamingConventions(campaigns);
    expect(results).toHaveLength(1);
    expect(results[0].details.violations[0].issue).toMatch(/PMax/);
  });

  test('flags Search campaign without dash separator', () => {
    const campaigns = [
      makeCampaign({ campaignName: 'DealerName F150', channelType: 'SEARCH' }),
    ];
    const results = checkNamingConventions(campaigns);
    expect(results).toHaveLength(1);
    expect(results[0].details.violations[0].issue).toMatch(/separator/);
  });

  test('ignores paused campaigns', () => {
    const campaigns = [
      makeCampaign({ campaignName: 'BadName', channelType: 'SEARCH', status: 'PAUSED' }),
    ];
    expect(checkNamingConventions(campaigns)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Check 11: Low Impression Share
// ─────────────────────────────────────────────────────────────
describe('checkLowImpressionShare', () => {
  test('passes when IS is above 75%', () => {
    const campaigns = [makeCampaign({ searchImpressionShare: 0.85, impressions: 500 })];
    expect(checkLowImpressionShare(campaigns)).toEqual([]);
  });

  test('flags campaigns below 75% IS as warning', () => {
    const campaigns = [makeCampaign({ searchImpressionShare: 0.60, impressions: 500 })];
    const results = checkLowImpressionShare(campaigns);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe(SEVERITY.WARNING);
    expect(results[0].checkId).toBe('low_impression_share_warning');
  });

  test('flags campaigns below 50% IS as critical', () => {
    const campaigns = [makeCampaign({ searchImpressionShare: 0.35, impressions: 500 })];
    const results = checkLowImpressionShare(campaigns);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe(SEVERITY.CRITICAL);
    expect(results[0].checkId).toBe('low_impression_share_critical');
  });

  test('ignores campaigns with null impression share', () => {
    const campaigns = [makeCampaign({ searchImpressionShare: null, impressions: 500 })];
    expect(checkLowImpressionShare(campaigns)).toEqual([]);
  });

  test('ignores campaigns with too few impressions', () => {
    const campaigns = [makeCampaign({ searchImpressionShare: 0.30, impressions: 50 })];
    expect(checkLowImpressionShare(campaigns)).toEqual([]);
  });

  test('ignores PMax campaigns', () => {
    const campaigns = [makeCampaign({ channelType: 'PERFORMANCE_MAX', searchImpressionShare: 0.30, impressions: 500 })];
    expect(checkLowImpressionShare(campaigns)).toEqual([]);
  });

  test('separates critical and warning findings', () => {
    const campaigns = [
      makeCampaign({ campaignId: '1', searchImpressionShare: 0.40, impressions: 500 }), // critical
      makeCampaign({ campaignId: '2', searchImpressionShare: 0.65, impressions: 500, campaignName: 'Campaign B' }), // warning
    ];
    const results = checkLowImpressionShare(campaigns);
    expect(results).toHaveLength(2);
    expect(results.find(r => r.checkId === 'low_impression_share_critical')).toBeDefined();
    expect(results.find(r => r.checkId === 'low_impression_share_warning')).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────
// runAudit orchestration
// ─────────────────────────────────────────────────────────────
jest.mock('../../src/services/google-ads');
const googleAds = require('../../src/services/google-ads');

describe('runAudit', () => {

  const mockRestCtx = {
    accessToken: 'test-token',
    developerToken: 'dev-token',
    customerId: '1234567890',
    loginCustomerId: '9999999999',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    googleAds.getKeywordPerformance.mockResolvedValue([
      makeKeyword({ matchType: 'EXACT', impressions: 100, clicks: 10 }),
    ]);
    googleAds.getCampaignPerformance.mockResolvedValue([
      makeCampaign({ biddingStrategy: 'MANUAL_CPC', ctr: 0.05 }),
    ]);
    googleAds.getAdCopy.mockResolvedValue([makeAd()]);
    googleAds.getRecommendations.mockResolvedValue([]);
    googleAds.getAdSchedules.mockResolvedValue([]);
    googleAds.getAdGroupAdCounts.mockResolvedValue([]);
  });

  test('returns audit result with all fields', async () => {
    const result = await runAudit(mockRestCtx);

    expect(result.accountId).toBe('1234567890');
    expect(result.ranAt).toBeDefined();
    expect(result.findings).toBeInstanceOf(Array);
    expect(result.summary).toHaveProperty('total');
    expect(result.summary).toHaveProperty('critical');
    expect(result.summary).toHaveProperty('warning');
    expect(result.summary).toHaveProperty('info');
    expect(result.checksRun).toBeInstanceOf(Array);
    expect(result.checksRun.length).toBe(14);
  });

  test('fetches all data in parallel', async () => {
    await runAudit(mockRestCtx);

    expect(googleAds.getKeywordPerformance).toHaveBeenCalledTimes(1);
    expect(googleAds.getCampaignPerformance).toHaveBeenCalledTimes(1);
    expect(googleAds.getAdCopy).toHaveBeenCalledTimes(1);
    expect(googleAds.getRecommendations).toHaveBeenCalledTimes(1);
    expect(googleAds.getAdSchedules).toHaveBeenCalledTimes(1);
  });

  test('detects issues when present', async () => {
    googleAds.getCampaignPerformance.mockResolvedValue([
      makeCampaign({ biddingStrategy: 'TARGET_CPA' }),
    ]);
    googleAds.getKeywordPerformance.mockResolvedValue([
      makeKeyword({ matchType: 'BROAD' }),
    ]);

    const result = await runAudit(mockRestCtx);
    expect(result.summary.critical).toBeGreaterThanOrEqual(2);
  });

  test('counts severity levels correctly', async () => {
    googleAds.getCampaignPerformance.mockResolvedValue([
      makeCampaign({ biddingStrategy: 'TARGET_CPA' }), // critical
      makeCampaign({ campaignId: '200', ctr: 0.01, impressions: 500, biddingStrategy: 'MANUAL_CPC' }), // warning (low CTR)
    ]);
    googleAds.getAdCopy.mockResolvedValue([
      makeAd({ approvalStatus: 'DISAPPROVED' }), // critical
    ]);

    const result = await runAudit(mockRestCtx);
    expect(result.summary.critical).toBeGreaterThanOrEqual(2);
    expect(result.summary.warning).toBeGreaterThanOrEqual(1);
  });

  test('handles keyword query failure gracefully', async () => {
    googleAds.getKeywordPerformance.mockRejectedValue(new Error('GAQL timeout'));

    const result = await runAudit(mockRestCtx);
    // Should still return results (campaign checks still run)
    expect(result.findings).toBeInstanceOf(Array);
    expect(result.summary).toBeDefined();
    // Should have a system warning about the query failure
    const sysWarning = result.findings.find(f => f.checkId === 'query_error');
    expect(sysWarning).toBeDefined();
  });

  test('handles ad query failure gracefully', async () => {
    googleAds.getAdCopy.mockRejectedValue(new Error('permission denied'));

    const result = await runAudit(mockRestCtx);
    expect(result.findings).toBeInstanceOf(Array);
    // Should not crash, just skip ad checks with empty data
  });

  test('handles campaign query failure gracefully', async () => {
    googleAds.getCampaignPerformance.mockRejectedValue(new Error('quota exceeded'));

    const result = await runAudit(mockRestCtx);
    expect(result.findings).toBeInstanceOf(Array);
    const sysWarning = result.findings.find(f => f.checkId === 'query_error_campaigns');
    expect(sysWarning).toBeDefined();
    // Should not expose raw error message
    expect(sysWarning.message).not.toContain('quota exceeded');
  });

  test('runs only selected checks when options.checks is provided', async () => {
    const result = await runAudit(mockRestCtx, { checks: ['bidding_strategy', 'broad_match'] });

    expect(result.checksRun).toEqual(['bidding_strategy', 'broad_match']);
  });

  test('returns clean audit for healthy account (no critical findings)', async () => {
    const result = await runAudit(mockRestCtx);

    expect(result.summary.critical).toBe(0);
    // Ad copy checks may produce info/warning findings from mock data
    expect(result.findings.every(f => f.severity !== 'critical')).toBe(true);
  });
});
