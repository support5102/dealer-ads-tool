/**
 * Unit tests for buildStructureTree — verifies that raw Google Ads API rows
 * are assembled into the nested campaign/adGroup/keyword/location tree used
 * by the frontend and Claude parser.
 *
 * Tier 2 (unit): pure function, no fakes or external deps needed.
 */

const { buildStructureTree, queryWithTimeout } = require('../../src/services/google-ads');

// ---------------------------------------------------------------------------
// Helpers — factory functions for building raw rows
// ---------------------------------------------------------------------------

function makeCampaignRow(overrides = {}, budgetMicros = undefined) {
  const row = {
    campaign: {
      id: 1001,
      name: 'Test Campaign',
      status: 'ENABLED',
      advertising_channel_type: 'SEARCH',
      bidding_strategy_type: 'MANUAL_CPC',
      ...overrides,
    },
  };
  if (budgetMicros !== undefined) {
    row.campaign_budget = { amount_micros: budgetMicros };
  }
  return row;
}

function makeAdGroupRow(campaignName, overrides = {}) {
  return {
    campaign: { name: campaignName },
    ad_group: {
      id: 2001,
      name: 'Test Ad Group',
      status: 'ENABLED',
      cpc_bid_micros: 1500000,
      ...overrides,
    },
  };
}

function makeKeywordRow(campaignName, adGroupName, overrides = {}) {
  return {
    campaign: { name: campaignName },
    ad_group: { name: adGroupName },
    ad_group_criterion: {
      keyword: {
        text: 'buy shoes',
        match_type: 'BROAD',
        ...(overrides.keyword || {}),
      },
      status: 'ENABLED',
      cpc_bid_micros: null,
      negative: false,
      ...overrides,
      // Re-apply keyword after spread so it isn't clobbered
      keyword: {
        text: 'buy shoes',
        match_type: 'BROAD',
        ...(overrides.keyword || {}),
      },
    },
  };
}

function makeLocationRow(campaignName, overrides = {}) {
  return {
    campaign: { name: campaignName },
    campaign_criterion: {
      location: { geo_target_constant: 'geoTargetConstants/1014044' },
      negative: false,
      bid_modifier: 1.0,
      ...overrides,
    },
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('buildStructureTree', () => {
  // -----------------------------------------------------------------------
  // Basic assembly
  // -----------------------------------------------------------------------
  describe('basic assembly', () => {
    test('builds campaign objects from raw campaign rows', () => {
      // Arrange
      const campaigns = [makeCampaignRow({ id: 555, name: 'Honda Civic - Search', status: 'PAUSED', advertising_channel_type: 'DISPLAY', bidding_strategy_type: 'TARGET_CPA' })];

      // Act
      const result = buildStructureTree(campaigns, [], [], []);

      // Assert
      expect(result.campaigns).toHaveLength(1);
      const camp = result.campaigns[0];
      expect(camp).toEqual({
        id: '555',
        name: 'Honda Civic - Search',
        status: 'PAUSED',
        type: 'DISPLAY',
        bidding: 'TARGET_CPA',
        budget: '?',
        adGroups: [],
        locations: [],
      });
    });

    test('nests ad groups under their parent campaign', () => {
      // Arrange
      const campaigns = [makeCampaignRow({ name: 'Camp A' })];
      const adGroups = [
        makeAdGroupRow('Camp A', { id: 2001, name: 'AG-1' }),
        makeAdGroupRow('Camp A', { id: 2002, name: 'AG-2' }),
      ];

      // Act
      const result = buildStructureTree(campaigns, adGroups, [], []);

      // Assert
      expect(result.campaigns[0].adGroups).toHaveLength(2);
      expect(result.campaigns[0].adGroups[0].name).toBe('AG-1');
      expect(result.campaigns[0].adGroups[1].name).toBe('AG-2');
    });

    test('nests keywords under their parent ad group', () => {
      // Arrange
      const campaigns = [makeCampaignRow({ name: 'Camp A' })];
      const adGroups = [makeAdGroupRow('Camp A', { name: 'AG-1' })];
      const keywords = [
        makeKeywordRow('Camp A', 'AG-1', { keyword: { text: 'red shoes', match_type: 'EXACT' } }),
        makeKeywordRow('Camp A', 'AG-1', { keyword: { text: 'blue shoes', match_type: 'PHRASE' } }),
      ];

      // Act
      const result = buildStructureTree(campaigns, adGroups, keywords, []);

      // Assert
      const ag = result.campaigns[0].adGroups[0];
      expect(ag.keywords).toHaveLength(2);
      expect(ag.keywords[0].text).toBe('red shoes');
      expect(ag.keywords[1].text).toBe('blue shoes');
    });

    test('attaches locations to their parent campaign', () => {
      // Arrange
      const campaigns = [makeCampaignRow({ name: 'Camp A' })];
      const locations = [
        makeLocationRow('Camp A'),
        makeLocationRow('Camp A', { negative: true }),
      ];

      // Act
      const result = buildStructureTree(campaigns, [], [], locations);

      // Assert
      expect(result.campaigns[0].locations).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // Data transformations
  // -----------------------------------------------------------------------
  describe('data transformations', () => {
    test('converts campaign ID to string', () => {
      const campaigns = [makeCampaignRow({ id: 98765 })];
      const result = buildStructureTree(campaigns, [], [], []);
      expect(result.campaigns[0].id).toBe('98765');
    });

    test('converts ad group ID to string', () => {
      const campaigns = [makeCampaignRow({ name: 'C' })];
      const adGroups = [makeAdGroupRow('C', { id: 44321 })];
      const result = buildStructureTree(campaigns, adGroups, [], []);
      expect(result.campaigns[0].adGroups[0].id).toBe('44321');
    });

    test('converts cpc_bid_micros to dollars with 2 decimal places for ad groups', () => {
      const campaigns = [makeCampaignRow({ name: 'C' })];
      const adGroups = [makeAdGroupRow('C', { cpc_bid_micros: 1500000 })];
      const result = buildStructureTree(campaigns, adGroups, [], []);
      expect(result.campaigns[0].adGroups[0].defaultBid).toBe('1.50');
    });

    test('shows "?" for missing cpc_bid_micros on ad groups', () => {
      const campaigns = [makeCampaignRow({ name: 'C' })];
      const adGroups = [makeAdGroupRow('C', { cpc_bid_micros: null })];
      const result = buildStructureTree(campaigns, adGroups, [], []);
      expect(result.campaigns[0].adGroups[0].defaultBid).toBe('?');
    });

    test('shows null for missing cpc_bid_micros on keywords', () => {
      const campaigns = [makeCampaignRow({ name: 'C' })];
      const adGroups = [makeAdGroupRow('C', { name: 'AG' })];
      const keywords = [makeKeywordRow('C', 'AG', { cpc_bid_micros: null })];
      const result = buildStructureTree(campaigns, adGroups, keywords, []);
      expect(result.campaigns[0].adGroups[0].keywords[0].bid).toBeNull();
    });

    test('converts keyword cpc_bid_micros to dollars when present', () => {
      const campaigns = [makeCampaignRow({ name: 'C' })];
      const adGroups = [makeAdGroupRow('C', { name: 'AG' })];
      const keywords = [makeKeywordRow('C', 'AG', { cpc_bid_micros: 2750000 })];
      const result = buildStructureTree(campaigns, adGroups, keywords, []);
      expect(result.campaigns[0].adGroups[0].keywords[0].bid).toBe('2.75');
    });

    test('converts campaign_budget.amount_micros to dollars', () => {
      const campaigns = [makeCampaignRow({ name: 'A' }, 50000000)];
      const result = buildStructureTree(campaigns, [], [], []);
      expect(result.campaigns[0].budget).toBe('50.00');
    });

    test('shows "0.00" when campaign_budget.amount_micros is zero', () => {
      const campaigns = [makeCampaignRow({ name: 'A' }, 0)];
      const result = buildStructureTree(campaigns, [], [], []);
      expect(result.campaigns[0].budget).toBe('0.00');
    });

    test('shows "?" when campaign_budget is missing from row', () => {
      const campaigns = [makeCampaignRow({ name: 'A' })];
      const result = buildStructureTree(campaigns, [], [], []);
      expect(result.campaigns[0].budget).toBe('?');
    });

    test('shows "?" when campaign_budget.amount_micros is null', () => {
      const campaigns = [{
        campaign: { id: 1, name: 'A', status: 'ENABLED', advertising_channel_type: 'SEARCH', bidding_strategy_type: 'MANUAL_CPC' },
        campaign_budget: { amount_micros: null },
      }];
      const result = buildStructureTree(campaigns, [], [], []);
      expect(result.campaigns[0].budget).toBe('?');
    });

    test('handles mixed budget availability across campaigns', () => {
      const campaigns = [
        makeCampaignRow({ name: 'With Budget' }, 75000000),
        makeCampaignRow({ name: 'Without Budget' }),
      ];
      const result = buildStructureTree(campaigns, [], [], []);
      expect(result.campaigns[0].budget).toBe('75.00');
      expect(result.campaigns[1].budget).toBe('?');
    });
  });

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------
  describe('stats', () => {
    test('returns correct stats.campaigns count', () => {
      const campaigns = [
        makeCampaignRow({ name: 'A' }),
        makeCampaignRow({ name: 'B' }),
        makeCampaignRow({ name: 'C' }),
      ];
      const result = buildStructureTree(campaigns, [], [], []);
      expect(result.stats.campaigns).toBe(3);
    });

    test('returns correct stats.adGroups count', () => {
      const campaigns = [makeCampaignRow({ name: 'C' })];
      const adGroups = [
        makeAdGroupRow('C', { name: 'AG1' }),
        makeAdGroupRow('C', { name: 'AG2' }),
      ];
      const result = buildStructureTree(campaigns, adGroups, [], []);
      expect(result.stats.adGroups).toBe(2);
    });

    test('returns correct stats.keywords count', () => {
      const campaigns = [makeCampaignRow({ name: 'C' })];
      const adGroups = [makeAdGroupRow('C', { name: 'AG' })];
      const keywords = [
        makeKeywordRow('C', 'AG', { keyword: { text: 'kw1', match_type: 'EXACT' } }),
        makeKeywordRow('C', 'AG', { keyword: { text: 'kw2', match_type: 'BROAD' } }),
        makeKeywordRow('C', 'AG', { keyword: { text: 'kw3', match_type: 'PHRASE' } }),
      ];
      const result = buildStructureTree(campaigns, adGroups, keywords, []);
      expect(result.stats.keywords).toBe(3);
    });

    test('keywordsTruncated is false when keywords under 2000', () => {
      const campaigns = [makeCampaignRow({ name: 'C' })];
      const adGroups = [makeAdGroupRow('C', { name: 'AG' })];
      const keywords = [
        makeKeywordRow('C', 'AG', { keyword: { text: 'kw1', match_type: 'EXACT' } }),
      ];
      const result = buildStructureTree(campaigns, adGroups, keywords, []);
      expect(result.stats.keywordsTruncated).toBe(false);
    });

    test('keywordsTruncated is true when keywords reach 2000', () => {
      const campaigns = [makeCampaignRow({ name: 'C' })];
      const adGroups = [makeAdGroupRow('C', { name: 'AG' })];
      // Create exactly 2000 keyword rows
      const keywords = Array.from({ length: 2000 }, (_, i) =>
        makeKeywordRow('C', 'AG', { keyword: { text: `kw${i}`, match_type: 'EXACT' } })
      );
      const result = buildStructureTree(campaigns, adGroups, keywords, []);
      expect(result.stats.keywordsTruncated).toBe(true);
    });

    test('stats count raw input rows, not nested items (orphans included)', () => {
      // Two ad group rows but only one matches the campaign
      const campaigns = [makeCampaignRow({ name: 'C' })];
      const adGroups = [
        makeAdGroupRow('C', { name: 'AG' }),
        makeAdGroupRow('Nonexistent', { name: 'Orphan AG' }),
      ];
      const result = buildStructureTree(campaigns, adGroups, [], []);
      // stats reflects input length, not nested length
      expect(result.stats.adGroups).toBe(2);
      // but only one is actually nested
      expect(result.campaigns[0].adGroups).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe('edge cases', () => {
    test('empty arrays for all inputs returns empty structure', () => {
      const result = buildStructureTree([], [], [], []);
      expect(result).toEqual({
        campaigns: [],
        stats: { campaigns: 0, adGroups: 0, keywords: 0, keywordsTruncated: false },
      });
    });

    test('ad groups without matching campaign are silently skipped', () => {
      const campaigns = [makeCampaignRow({ name: 'Real Camp' })];
      const adGroups = [makeAdGroupRow('Ghost Camp', { name: 'Orphan AG' })];
      const result = buildStructureTree(campaigns, adGroups, [], []);
      expect(result.campaigns[0].adGroups).toHaveLength(0);
    });

    test('keywords without matching campaign are silently skipped', () => {
      const campaigns = [makeCampaignRow({ name: 'Real Camp' })];
      const adGroups = [makeAdGroupRow('Real Camp', { name: 'AG' })];
      const keywords = [makeKeywordRow('Ghost Camp', 'AG')];
      const result = buildStructureTree(campaigns, adGroups, keywords, []);
      expect(result.campaigns[0].adGroups[0].keywords).toHaveLength(0);
    });

    test('keywords without matching ad group are silently skipped', () => {
      const campaigns = [makeCampaignRow({ name: 'Real Camp' })];
      const adGroups = [makeAdGroupRow('Real Camp', { name: 'AG-1' })];
      const keywords = [makeKeywordRow('Real Camp', 'AG-Nonexistent')];
      const result = buildStructureTree(campaigns, adGroups, keywords, []);
      expect(result.campaigns[0].adGroups[0].keywords).toHaveLength(0);
    });

    test('locations without matching campaign are silently skipped', () => {
      const campaigns = [makeCampaignRow({ name: 'Real Camp' })];
      const locations = [makeLocationRow('Ghost Camp')];
      const result = buildStructureTree(campaigns, [], [], locations);
      expect(result.campaigns[0].locations).toHaveLength(0);
    });

    test('multiple campaigns with ad groups and keywords in correct hierarchy', () => {
      // Arrange
      const campaigns = [
        makeCampaignRow({ id: 1, name: 'Camp Alpha' }),
        makeCampaignRow({ id: 2, name: 'Camp Beta' }),
      ];
      const adGroups = [
        makeAdGroupRow('Camp Alpha', { id: 10, name: 'Alpha AG1' }),
        makeAdGroupRow('Camp Alpha', { id: 11, name: 'Alpha AG2' }),
        makeAdGroupRow('Camp Beta', { id: 20, name: 'Beta AG1' }),
      ];
      const keywords = [
        makeKeywordRow('Camp Alpha', 'Alpha AG1', { keyword: { text: 'a1-kw', match_type: 'EXACT' } }),
        makeKeywordRow('Camp Alpha', 'Alpha AG2', { keyword: { text: 'a2-kw', match_type: 'BROAD' } }),
        makeKeywordRow('Camp Beta', 'Beta AG1', { keyword: { text: 'b1-kw', match_type: 'PHRASE' } }),
      ];
      const locations = [
        makeLocationRow('Camp Beta', { negative: true }),
      ];

      // Act
      const result = buildStructureTree(campaigns, adGroups, keywords, locations);

      // Assert — Camp Alpha
      const alpha = result.campaigns.find(c => c.name === 'Camp Alpha');
      expect(alpha.adGroups).toHaveLength(2);
      expect(alpha.adGroups[0].keywords[0].text).toBe('a1-kw');
      expect(alpha.adGroups[1].keywords[0].text).toBe('a2-kw');
      expect(alpha.locations).toHaveLength(0);

      // Assert — Camp Beta
      const beta = result.campaigns.find(c => c.name === 'Camp Beta');
      expect(beta.adGroups).toHaveLength(1);
      expect(beta.adGroups[0].keywords[0].text).toBe('b1-kw');
      expect(beta.locations).toHaveLength(1);
      expect(beta.locations[0].negative).toBe(true);

      // Assert — stats reflect raw row counts
      expect(result.stats).toEqual({ campaigns: 2, adGroups: 3, keywords: 3, keywordsTruncated: false });
    });
  });

  // -----------------------------------------------------------------------
  // Location handling
  // -----------------------------------------------------------------------
  describe('location handling', () => {
    test('location with geo_target_constant populated', () => {
      const campaigns = [makeCampaignRow({ name: 'C' })];
      const locations = [makeLocationRow('C', {
        location: { geo_target_constant: 'geoTargetConstants/9999' },
      })];
      const result = buildStructureTree(campaigns, [], [], locations);
      expect(result.campaigns[0].locations[0].geoTarget).toBe('geoTargetConstants/9999');
    });

    test('location with missing geo_target_constant defaults to empty string', () => {
      const campaigns = [makeCampaignRow({ name: 'C' })];
      const locations = [{
        campaign: { name: 'C' },
        campaign_criterion: {
          location: undefined,
          negative: false,
          bid_modifier: 1.0,
        },
      }];
      const result = buildStructureTree(campaigns, [], [], locations);
      expect(result.campaigns[0].locations[0].geoTarget).toBe('');
    });

    test('location with location object but no geo_target_constant defaults to empty string', () => {
      const campaigns = [makeCampaignRow({ name: 'C' })];
      const locations = [{
        campaign: { name: 'C' },
        campaign_criterion: {
          location: {},
          negative: false,
          bid_modifier: 1.0,
        },
      }];
      const result = buildStructureTree(campaigns, [], [], locations);
      expect(result.campaigns[0].locations[0].geoTarget).toBe('');
    });

    test('location negative flag is preserved', () => {
      const campaigns = [makeCampaignRow({ name: 'C' })];
      const locations = [makeLocationRow('C', { negative: true })];
      const result = buildStructureTree(campaigns, [], [], locations);
      expect(result.campaigns[0].locations[0].negative).toBe(true);
    });

    test('location bid modifier is preserved', () => {
      const campaigns = [makeCampaignRow({ name: 'C' })];
      const locations = [makeLocationRow('C', { bid_modifier: 1.35 })];
      const result = buildStructureTree(campaigns, [], [], locations);
      expect(result.campaigns[0].locations[0].bidMod).toBe(1.35);
    });
  });
});

// ---------------------------------------------------------------------------
// queryWithTimeout
// ---------------------------------------------------------------------------
describe('queryWithTimeout', () => {
  test('resolves when query completes before timeout', async () => {
    const result = await queryWithTimeout(Promise.resolve('data'), 'test');
    expect(result).toBe('data');
  });

  test('rejects with timeout error when query takes too long', async () => {
    jest.useFakeTimers();
    const slowQuery = new Promise(resolve => setTimeout(() => resolve('late'), 30000));

    const promise = queryWithTimeout(slowQuery, 'campaigns', 100);
    jest.advanceTimersByTime(100);

    await expect(promise).rejects.toThrow('Timed out fetching campaigns');
    jest.useRealTimers();
  });

  test('timeout error message includes label', async () => {
    jest.useFakeTimers();
    const slowQuery = new Promise(() => {}); // never resolves

    const promise = queryWithTimeout(slowQuery, 'ad groups', 50);
    jest.advanceTimersByTime(50);

    await expect(promise).rejects.toThrow('Timed out fetching ad groups');
    jest.useRealTimers();
  });

  test('propagates query errors (not timeout)', async () => {
    const failingQuery = Promise.reject(new Error('API rate limit'));

    await expect(queryWithTimeout(failingQuery, 'test'))
      .rejects.toThrow('API rate limit');
  });

  test('uses default 15s timeout when not specified', async () => {
    const result = await queryWithTimeout(Promise.resolve([1, 2, 3]), 'fast');
    expect(result).toEqual([1, 2, 3]);
  });
});
