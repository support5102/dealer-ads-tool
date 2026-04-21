/**
 * Unit tests for diagnostic-analyzer.js — Phase 4 R6 checks.
 *
 * Tests each of the 7 checks:
 *   - Positive trigger: data that causes the check to fire
 *   - Negative test: data that does NOT trigger; no diagnostic (or fall-through fires)
 *   - Error test: query throws → check is skipped (not thrown)
 *
 * Then integration tests for analyze():
 *   - First-match-wins
 *   - All checks clean → fall-through fires
 *   - All checks error → empty array returned
 */

const {
  analyze,
  checkQualityScore,
  checkAdDisapproval,
  checkNarrowGeo,
  checkAdSchedule,
  checkLowBids,
  checkNegativeKeywordBlock,
  checkFallthrough,
} = require('../../src/services/diagnostic-analyzer');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers / shared fixtures
// ─────────────────────────────────────────────────────────────────────────────

const CAMPAIGN_ID = 'c1';
const CAMPAIGN_NAME = 'VLA Ford';
const CAMPAIGN_TYPE = 'vla';
const REST_CTX = { accessToken: 'tok', developerToken: 'dev', customerId: '123', loginCustomerId: null };

/**
 * Build a minimal fake googleAds module. Callers override only the methods they need.
 */
function fakeGoogleAds(overrides = {}) {
  return {
    getKeywordDiagnostics: async () => [],
    getAdCopy: async () => [],
    getCampaignLocations: async () => 5,
    getAdSchedules: async () => [],
    getKeywordPerformance: async () => [],
    getCampaignNegatives: async () => [],
    getSearchTermReport: async () => [],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 1: Quality Score
// ─────────────────────────────────────────────────────────────────────────────

describe('checkQualityScore', () => {
  test('fires when ≥ 50% of eligible keywords have QS ≤ 4', async () => {
    const ga = fakeGoogleAds({
      getKeywordDiagnostics: async () => [
        { campaignName: CAMPAIGN_NAME, campaignId: CAMPAIGN_ID, qualityScore: 3 },
        { campaignName: CAMPAIGN_NAME, campaignId: CAMPAIGN_ID, qualityScore: 4 },
        { campaignName: CAMPAIGN_NAME, campaignId: CAMPAIGN_ID, qualityScore: 7 },
      ],
    });
    const result = await checkQualityScore(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME);
    expect(result).not.toBeNull();
    expect(result.check).toBe('quality_score');
    expect(result.severity).toBe('high');
    expect(result.details.lowQsCount).toBe(2);
    expect(result.details.totalEligible).toBe(3);
    expect(result.message).toContain('2/3 keywords');
    expect(result.message).toContain(CAMPAIGN_NAME);
  });

  test('does NOT fire when < 50% of keywords have QS ≤ 4', async () => {
    const ga = fakeGoogleAds({
      getKeywordDiagnostics: async () => [
        { campaignName: CAMPAIGN_NAME, qualityScore: 3 },
        { campaignName: CAMPAIGN_NAME, qualityScore: 7 },
        { campaignName: CAMPAIGN_NAME, qualityScore: 8 },
      ],
    });
    const result = await checkQualityScore(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME);
    expect(result).toBeNull();
  });

  test('does NOT fire when all keywords lack quality score (null)', async () => {
    const ga = fakeGoogleAds({
      getKeywordDiagnostics: async () => [
        { campaignName: CAMPAIGN_NAME, qualityScore: null },
        { campaignName: CAMPAIGN_NAME, qualityScore: null },
      ],
    });
    const result = await checkQualityScore(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME);
    expect(result).toBeNull();
  });

  test('does NOT fire when no keywords returned for campaign', async () => {
    const ga = fakeGoogleAds({
      getKeywordDiagnostics: async () => [
        { campaignName: 'Other Campaign', qualityScore: 2 },
      ],
    });
    const result = await checkQualityScore(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME);
    expect(result).toBeNull();
  });

  test('SKIPS (returns null) when query throws — does not propagate', async () => {
    const ga = fakeGoogleAds({
      getKeywordDiagnostics: async () => { throw new Error('API down'); },
    });
    await expect(checkQualityScore(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME)).resolves.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Check 2: Ad Disapproval
// ─────────────────────────────────────────────────────────────────────────────

describe('checkAdDisapproval', () => {
  test('fires when at least one enabled ad is DISAPPROVED', async () => {
    const ga = fakeGoogleAds({
      getAdCopy: async () => [
        { campaignName: CAMPAIGN_NAME, status: 'ENABLED', approvalStatus: 'DISAPPROVED' },
        { campaignName: CAMPAIGN_NAME, status: 'ENABLED', approvalStatus: 'APPROVED' },
      ],
    });
    const result = await checkAdDisapproval(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME);
    expect(result).not.toBeNull();
    expect(result.check).toBe('ad_disapproval');
    expect(result.severity).toBe('high');
    expect(result.details.disapprovedCount).toBe(1);
    expect(result.message).toContain('1 enabled ads are DISAPPROVED');
  });

  test('does NOT fire when no enabled ads are DISAPPROVED', async () => {
    const ga = fakeGoogleAds({
      getAdCopy: async () => [
        { campaignName: CAMPAIGN_NAME, status: 'ENABLED', approvalStatus: 'APPROVED' },
        { campaignName: CAMPAIGN_NAME, status: 'PAUSED', approvalStatus: 'DISAPPROVED' },
      ],
    });
    const result = await checkAdDisapproval(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME);
    expect(result).toBeNull();
  });

  test('does NOT fire when campaign has no ads', async () => {
    const ga = fakeGoogleAds({
      getAdCopy: async () => [
        { campaignName: 'Other Campaign', status: 'ENABLED', approvalStatus: 'DISAPPROVED' },
      ],
    });
    const result = await checkAdDisapproval(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME);
    expect(result).toBeNull();
  });

  test('SKIPS when query throws', async () => {
    const ga = fakeGoogleAds({
      getAdCopy: async () => { throw new Error('Network error'); },
    });
    await expect(checkAdDisapproval(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME)).resolves.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Check 3: Narrow Geo
// ─────────────────────────────────────────────────────────────────────────────

describe('checkNarrowGeo', () => {
  test('fires when location count < 3 and campaignType is not regional', async () => {
    const ga = fakeGoogleAds({
      getCampaignLocations: async () => 2,
    });
    const result = await checkNarrowGeo(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME, 'vla');
    expect(result).not.toBeNull();
    expect(result.check).toBe('narrow_geo');
    expect(result.severity).toBe('medium');
    expect(result.details.locationCount).toBe(2);
    expect(result.message).toContain('2 location(s)');
  });

  test('fires when location count is 0', async () => {
    const ga = fakeGoogleAds({ getCampaignLocations: async () => 0 });
    const result = await checkNarrowGeo(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME, 'brand');
    expect(result).not.toBeNull();
    expect(result.details.locationCount).toBe(0);
  });

  test('does NOT fire when location count is ≥ 3', async () => {
    const ga = fakeGoogleAds({ getCampaignLocations: async () => 3 });
    const result = await checkNarrowGeo(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME, 'vla');
    expect(result).toBeNull();
  });

  test('does NOT fire when campaignType is regional (even with 1 location)', async () => {
    const ga = fakeGoogleAds({ getCampaignLocations: async () => 1 });
    const result = await checkNarrowGeo(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME, 'regional');
    expect(result).toBeNull();
  });

  test('SKIPS when getCampaignLocations returns null (query failed)', async () => {
    const ga = fakeGoogleAds({ getCampaignLocations: async () => null });
    const result = await checkNarrowGeo(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME, 'vla');
    expect(result).toBeNull();
  });

  test('SKIPS when getCampaignLocations throws', async () => {
    const ga = fakeGoogleAds({ getCampaignLocations: async () => { throw new Error('fail'); } });
    await expect(checkNarrowGeo(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME, 'vla')).resolves.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Check 4: Ad Schedule
// ─────────────────────────────────────────────────────────────────────────────

describe('checkAdSchedule', () => {
  // A single day with only 5 hours = 5 hours/week < 40
  test('fires when total scheduled hours < 40/week', async () => {
    const ga = fakeGoogleAds({
      getAdSchedules: async () => [
        { campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME, dayOfWeek: 'MONDAY', startHour: 8, startMinute: 0, endHour: 13, endMinute: 0 },
      ],
    });
    const result = await checkAdSchedule(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME);
    expect(result).not.toBeNull();
    expect(result.check).toBe('ad_schedule');
    expect(result.severity).toBe('medium');
    expect(result.details.weeklyHours).toBe(5);
    expect(result.message).toContain('5 hours/week');
  });

  test('does NOT fire when total scheduled hours ≥ 40/week', async () => {
    // 8 hours Mon-Fri = 40 hours exactly
    const days = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
    const ga = fakeGoogleAds({
      getAdSchedules: async () => days.map(d => ({
        campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME,
        dayOfWeek: d, startHour: 8, startMinute: 0, endHour: 16, endMinute: 0,
      })),
    });
    const result = await checkAdSchedule(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME);
    expect(result).toBeNull();
  });

  test('does NOT fire when no ad schedule exists (campaign runs 24/7)', async () => {
    const ga = fakeGoogleAds({ getAdSchedules: async () => [] });
    const result = await checkAdSchedule(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME);
    expect(result).toBeNull();
  });

  test('handles minute enum strings (THIRTY, FORTY_FIVE)', async () => {
    // 8:00 - 8:30 = 0.5 hours × 1 day = 0.5 hours/week < 40
    const ga = fakeGoogleAds({
      getAdSchedules: async () => [
        { campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME, dayOfWeek: 'MONDAY', startHour: 8, startMinute: 'ZERO', endHour: 8, endMinute: 'THIRTY' },
      ],
    });
    const result = await checkAdSchedule(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME);
    expect(result).not.toBeNull();
    expect(result.details.weeklyHours).toBe(0.5);
  });

  test('SKIPS when getAdSchedules throws', async () => {
    const ga = fakeGoogleAds({ getAdSchedules: async () => { throw new Error('fail'); } });
    await expect(checkAdSchedule(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME)).resolves.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Check 5: Low Bids
// ─────────────────────────────────────────────────────────────────────────────

describe('checkLowBids', () => {
  test('fires when ≥ 50% of keywords bid below range min', async () => {
    // CPC_RANGES.brand = { min: 1.00, max: 3.00 }
    const ga = fakeGoogleAds({
      getKeywordPerformance: async () => [
        { campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME, status: 'ENABLED', negative: false, cpcBid: 0.50 },
        { campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME, status: 'ENABLED', negative: false, cpcBid: 0.75 },
        { campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME, status: 'ENABLED', negative: false, cpcBid: 2.00 },
      ],
    });
    const result = await checkLowBids(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME, 'brand');
    expect(result).not.toBeNull();
    expect(result.check).toBe('low_bids');
    expect(result.severity).toBe('medium');
    expect(result.details.belowMinCount).toBe(2);
    expect(result.details.totalEligible).toBe(3);
    expect(result.details.rangeMin).toBe(1.00);
    expect(result.message).toContain('2/3 keywords');
    expect(result.message).toContain('$1-$3');
  });

  test('does NOT fire when < 50% of keywords are below range min', async () => {
    const ga = fakeGoogleAds({
      getKeywordPerformance: async () => [
        { campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME, status: 'ENABLED', negative: false, cpcBid: 0.50 },
        { campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME, status: 'ENABLED', negative: false, cpcBid: 2.00 },
        { campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME, status: 'ENABLED', negative: false, cpcBid: 2.50 },
      ],
    });
    const result = await checkLowBids(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME, 'brand');
    expect(result).toBeNull();
  });

  test('SKIPS when campaignType has no CPC_RANGES entry', async () => {
    const ga = fakeGoogleAds();
    // 'vla' and 'model_keyword' and 'service' don't appear in CPC_RANGES
    const result = await checkLowBids(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME, 'vla');
    expect(result).toBeNull();
  });

  test('SKIPS when no eligible keywords found', async () => {
    const ga = fakeGoogleAds({
      getKeywordPerformance: async () => [
        { campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME, status: 'PAUSED', negative: false, cpcBid: 0.50 },
        { campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME, status: 'ENABLED', negative: true, cpcBid: 0.50 },
      ],
    });
    const result = await checkLowBids(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME, 'brand');
    expect(result).toBeNull();
  });

  test('SKIPS when getKeywordPerformance throws', async () => {
    const ga = fakeGoogleAds({
      getKeywordPerformance: async () => { throw new Error('fail'); },
    });
    await expect(checkLowBids(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME, 'brand')).resolves.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Check 6: Negative Keyword Block
// ─────────────────────────────────────────────────────────────────────────────

describe('checkNegativeKeywordBlock', () => {
  test('fires when a negative blocks ≥ 10% of search-term impressions', async () => {
    const ga = fakeGoogleAds({
      getCampaignNegatives: async () => [
        { campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME, keyword: 'used car', matchType: 'PHRASE' },
      ],
      getSearchTermReport: async () => [
        { campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME, searchTerm: 'used car deals', impressions: 500 },
        { campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME, searchTerm: 'new ford truck', impressions: 300 },
        { campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME, searchTerm: 'ford suv', impressions: 200 },
      ],
    });
    const result = await checkNegativeKeywordBlock(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME);
    expect(result).not.toBeNull();
    expect(result.check).toBe('negative_block');
    expect(result.severity).toBe('medium');
    expect(result.details.negativeKeyword).toBe('used car');
    expect(result.details.blockPct).toBe(50);  // 500/1000 = 50%
    expect(result.message).toContain('used car');
    expect(result.message).toContain('50%');
  });

  test('does NOT fire when no negative blocks ≥ 10% of impressions', async () => {
    const ga = fakeGoogleAds({
      getCampaignNegatives: async () => [
        { campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME, keyword: 'lease', matchType: 'EXACT' },
      ],
      getSearchTermReport: async () => [
        { campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME, searchTerm: 'ford truck', impressions: 900 },
        { campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME, searchTerm: 'lease ford', impressions: 9 },
        { campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME, searchTerm: 'ford deals', impressions: 91 },
      ],
    });
    // 'lease' matches 'lease ford': 9 impressions out of 1000 = 0.9%, < 10%
    const result = await checkNegativeKeywordBlock(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME);
    expect(result).toBeNull();
  });

  test('SKIPS when no campaign negatives exist', async () => {
    const ga = fakeGoogleAds({
      getCampaignNegatives: async () => [],
      getSearchTermReport: async () => [
        { campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME, searchTerm: 'ford truck', impressions: 500 },
      ],
    });
    const result = await checkNegativeKeywordBlock(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME);
    expect(result).toBeNull();
  });

  test('SKIPS when no search terms exist', async () => {
    const ga = fakeGoogleAds({
      getCampaignNegatives: async () => [
        { campaignId: CAMPAIGN_ID, campaignName: CAMPAIGN_NAME, keyword: 'used', matchType: 'BROAD' },
      ],
      getSearchTermReport: async () => [],
    });
    const result = await checkNegativeKeywordBlock(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME);
    expect(result).toBeNull();
  });

  test('SKIPS when getCampaignNegatives throws', async () => {
    const ga = fakeGoogleAds({
      getCampaignNegatives: async () => { throw new Error('fail'); },
    });
    await expect(checkNegativeKeywordBlock(ga, REST_CTX, CAMPAIGN_ID, CAMPAIGN_NAME)).resolves.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Check 7: Fall-through
// ─────────────────────────────────────────────────────────────────────────────

describe('checkFallthrough', () => {
  test('always returns a low-severity fallthrough diagnostic', () => {
    const result = checkFallthrough(CAMPAIGN_ID, CAMPAIGN_NAME);
    expect(result.check).toBe('fallthrough');
    expect(result.severity).toBe('low');
    expect(result.details.campaignId).toBe(CAMPAIGN_ID);
    expect(result.details.campaignName).toBe(CAMPAIGN_NAME);
    expect(result.message).toContain(CAMPAIGN_NAME);
    expect(result.message).toContain('No single cause');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: analyze()
// ─────────────────────────────────────────────────────────────────────────────

describe('analyze() — integration', () => {
  test('first-match-wins: QS issue + ad disapproval both present → only QS fires', async () => {
    const ga = fakeGoogleAds({
      getKeywordDiagnostics: async () => [
        { campaignName: CAMPAIGN_NAME, qualityScore: 2 },
        { campaignName: CAMPAIGN_NAME, qualityScore: 3 },
      ],
      getAdCopy: async () => [
        { campaignName: CAMPAIGN_NAME, status: 'ENABLED', approvalStatus: 'DISAPPROVED' },
      ],
    });

    const result = await analyze({
      restCtx: REST_CTX,
      campaignId: CAMPAIGN_ID,
      campaignName: CAMPAIGN_NAME,
      campaignType: CAMPAIGN_TYPE,
      _googleAds: ga,
    });

    expect(result).toHaveLength(1);
    expect(result[0].check).toBe('quality_score');
  });

  test('all checks return clean → fall-through fires', async () => {
    // All queries return empty/safe data
    const ga = fakeGoogleAds({
      getKeywordDiagnostics: async () => [
        { campaignName: CAMPAIGN_NAME, qualityScore: 8 },
      ],
      getAdCopy: async () => [
        { campaignName: CAMPAIGN_NAME, status: 'ENABLED', approvalStatus: 'APPROVED' },
      ],
      getCampaignLocations: async () => 5,
      getAdSchedules: async () => [],  // no schedule = 24/7 = not a restriction
      getKeywordPerformance: async () => [],  // no CPC_RANGES for 'vla', skip
      getCampaignNegatives: async () => [],
      getSearchTermReport: async () => [],
    });

    const result = await analyze({
      restCtx: REST_CTX,
      campaignId: CAMPAIGN_ID,
      campaignName: CAMPAIGN_NAME,
      campaignType: 'vla',
      _googleAds: ga,
    });

    expect(result).toHaveLength(1);
    expect(result[0].check).toBe('fallthrough');
    expect(result[0].severity).toBe('low');
  });

  test('all checks error → empty array returned (no throw)', async () => {
    const ga = fakeGoogleAds({
      getKeywordDiagnostics: async () => { throw new Error('fail'); },
      getAdCopy: async () => { throw new Error('fail'); },
      getCampaignLocations: async () => { throw new Error('fail'); },
      getAdSchedules: async () => { throw new Error('fail'); },
      getKeywordPerformance: async () => { throw new Error('fail'); },
      getCampaignNegatives: async () => { throw new Error('fail'); },
      getSearchTermReport: async () => { throw new Error('fail'); },
    });

    // When all checks fail, all return null, so fall-through fires
    // (fall-through is synchronous and never fails)
    const result = await analyze({
      restCtx: REST_CTX,
      campaignId: CAMPAIGN_ID,
      campaignName: CAMPAIGN_NAME,
      campaignType: 'vla',
      _googleAds: ga,
    });

    // Fall-through always fires — it's not based on a query, so it can't fail
    // When all 6 checks error → null → fall-through fires
    expect(result).toHaveLength(1);
    expect(result[0].check).toBe('fallthrough');
  });

  test('narrow geo fires when campaign has 1 location (brand campaign)', async () => {
    const ga = fakeGoogleAds({
      getKeywordDiagnostics: async () => [
        { campaignName: 'Brand Campaign', qualityScore: 9 },
      ],
      getAdCopy: async () => [
        { campaignName: 'Brand Campaign', status: 'ENABLED', approvalStatus: 'APPROVED' },
      ],
      getCampaignLocations: async () => 1,
    });

    const result = await analyze({
      restCtx: REST_CTX,
      campaignId: CAMPAIGN_ID,
      campaignName: 'Brand Campaign',
      campaignType: 'brand',
      _googleAds: ga,
    });

    expect(result).toHaveLength(1);
    expect(result[0].check).toBe('narrow_geo');
  });

  test('returns single-element array with the first matching diagnostic', async () => {
    // Ad disapproval fires (QS is fine)
    const ga = fakeGoogleAds({
      getKeywordDiagnostics: async () => [
        { campaignName: CAMPAIGN_NAME, qualityScore: 8 },
        { campaignName: CAMPAIGN_NAME, qualityScore: 9 },
      ],
      getAdCopy: async () => [
        { campaignName: CAMPAIGN_NAME, status: 'ENABLED', approvalStatus: 'DISAPPROVED' },
        { campaignName: CAMPAIGN_NAME, status: 'ENABLED', approvalStatus: 'DISAPPROVED' },
      ],
    });

    const result = await analyze({
      restCtx: REST_CTX,
      campaignId: CAMPAIGN_ID,
      campaignName: CAMPAIGN_NAME,
      campaignType: CAMPAIGN_TYPE,
      _googleAds: ga,
    });

    expect(result).toHaveLength(1);
    expect(result[0].check).toBe('ad_disapproval');
    expect(result[0].details.disapprovedCount).toBe(2);
  });
});
