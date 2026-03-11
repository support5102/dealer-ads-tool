/**
 * Unit tests for Change Executor — validates all 10 change types,
 * lookup helpers, dry run mode, and error handling.
 *
 * Uses FakeGoogleAdsClient to verify correct GAQL lookups and mutations
 * without calling the real Google Ads API.
 */

const { applyChange, getCampaignId, getAdGroupId } = require('../../src/services/change-executor');
const { FakeGoogleAdsClient } = require('../fakes/google-ads-fake');

// ---------------------------------------------------------------------------
// getCampaignId
// ---------------------------------------------------------------------------
describe('getCampaignId', () => {
  let client;

  beforeEach(() => {
    client = new FakeGoogleAdsClient();
  });

  test('returns campaign ID for existing campaign', async () => {
    // Arrange — default fake has "Honda Civic - Search" with id 100
    // Act
    const id = await getCampaignId(client, 'Honda Civic - Search');
    // Assert
    expect(id).toBe('100');
  });

  test('returns campaign ID for a different existing campaign', async () => {
    const id = await getCampaignId(client, 'Toyota Trucks');
    expect(id).toBe('200');
  });

  test('throws descriptive error for non-existent campaign', async () => {
    await expect(getCampaignId(client, 'Nonexistent Campaign'))
      .rejects.toThrow('Campaign not found: "Nonexistent Campaign"');
  });
});

// ---------------------------------------------------------------------------
// getAdGroupId
// ---------------------------------------------------------------------------
describe('getAdGroupId', () => {
  let client;

  beforeEach(() => {
    client = new FakeGoogleAdsClient();
  });

  test('returns ad group ID for existing ad group', async () => {
    const id = await getAdGroupId(client, 'Honda Civic - Search', 'Civic Sedans');
    expect(id).toBe('1001');
  });

  test('returns ad group ID for a different existing ad group', async () => {
    const id = await getAdGroupId(client, 'Toyota Trucks', 'Tacoma');
    expect(id).toBe('2001');
  });

  test('throws descriptive error for non-existent ad group', async () => {
    await expect(getAdGroupId(client, 'Honda Civic - Search', 'Nonexistent Group'))
      .rejects.toThrow('Ad group not found: "Nonexistent Group" in "Honda Civic - Search"');
  });

  test('throws when campaign exists but ad group does not belong to it', async () => {
    // "Tacoma" belongs to Toyota Trucks, not Honda Civic
    await expect(getAdGroupId(client, 'Honda Civic - Search', 'Tacoma'))
      .rejects.toThrow('Ad group not found');
  });
});

// ---------------------------------------------------------------------------
// applyChange — dry run
// ---------------------------------------------------------------------------
describe('applyChange — dry run', () => {
  let client;

  beforeEach(() => {
    client = new FakeGoogleAdsClient();
  });

  test('returns description string without executing mutations', async () => {
    const result = await applyChange(client, {
      type: 'pause_campaign',
      campaignName: 'Honda Civic - Search',
    }, true);

    expect(result).toContain('[DRY RUN]');
    expect(result).toContain('pause_campaign');
    expect(result).toContain('Honda Civic - Search');
  });

  test('no mutations are recorded on client during dry run', async () => {
    await applyChange(client, {
      type: 'pause_campaign',
      campaignName: 'Honda Civic - Search',
    }, true);

    expect(client.mutations).toHaveLength(0);
  });

  test('dry run includes ad group name when present', async () => {
    const result = await applyChange(client, {
      type: 'pause_ad_group',
      campaignName: 'Honda Civic - Search',
      adGroupName: 'Civic Sedans',
    }, true);

    expect(result).toContain('[DRY RUN]');
    expect(result).toContain('Civic Sedans');
  });
});

// ---------------------------------------------------------------------------
// applyChange — pause_campaign
// ---------------------------------------------------------------------------
describe('applyChange — pause_campaign', () => {
  let client;

  beforeEach(() => {
    client = new FakeGoogleAdsClient();
  });

  test('pause_campaign with valid name pauses the campaign', async () => {
    // Arrange
    const change = { type: 'pause_campaign', campaignName: 'Honda Civic - Search' };

    // Act
    const result = await applyChange(client, change, false);

    // Assert
    expect(result).toBe('Paused campaign: Honda Civic - Search');
    expect(client.mutations).toHaveLength(1);
    expect(client.mutations[0].type).toBe('campaigns.update');
    expect(client.mutations[0].data).toEqual([{
      resource_name: 'customers/1234567890/campaigns/100',
      status: 'PAUSED',
    }]);
  });

  test('pause_campaign with missing campaign throws descriptive error', async () => {
    const change = { type: 'pause_campaign', campaignName: 'Does Not Exist' };

    await expect(applyChange(client, change, false))
      .rejects.toThrow('Campaign not found: "Does Not Exist"');
    expect(client.mutations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyChange — enable_campaign
// ---------------------------------------------------------------------------
describe('applyChange — enable_campaign', () => {
  let client;

  beforeEach(() => {
    client = new FakeGoogleAdsClient();
  });

  test('enable_campaign with valid name enables the campaign', async () => {
    const change = { type: 'enable_campaign', campaignName: 'Toyota Trucks' };

    const result = await applyChange(client, change, false);

    expect(result).toBe('Enabled campaign: Toyota Trucks');
    expect(client.mutations).toHaveLength(1);
    expect(client.mutations[0].type).toBe('campaigns.update');
    expect(client.mutations[0].data).toEqual([{
      resource_name: 'customers/1234567890/campaigns/200',
      status: 'ENABLED',
    }]);
  });
});

// ---------------------------------------------------------------------------
// applyChange — update_budget
// ---------------------------------------------------------------------------
describe('applyChange — update_budget', () => {
  let client;

  beforeEach(() => {
    client = new FakeGoogleAdsClient();
  });

  test('update_budget looks up budget resource and converts dollars to micros', async () => {
    const change = {
      type: 'update_budget',
      campaignName: 'Honda Civic - Search',
      details: { newBudget: '75' },
    };

    const result = await applyChange(client, change, false);

    expect(result).toBe('Updated budget for "Honda Civic - Search" to $75/day');
    expect(client.mutations).toHaveLength(1);
    expect(client.mutations[0].type).toBe('campaignBudgets.update');
    expect(client.mutations[0].data).toEqual([{
      resource_name: 'customers/1234567890/campaignBudgets/9001',
      amount_micros: 75_000_000,
    }]);
  });

  test('update_budget handles decimal budget amounts', async () => {
    const change = {
      type: 'update_budget',
      campaignName: 'Honda Civic - Search',
      details: { newBudget: '49.99' },
    };

    const result = await applyChange(client, change, false);

    expect(result).toContain('$49.99/day');
    const budgetMutation = client.mutations.find(m => m.type === 'campaignBudgets.update');
    expect(budgetMutation.data[0].amount_micros).toBe(49_990_000);
  });

  test('update_budget with missing campaign throws', async () => {
    const change = {
      type: 'update_budget',
      campaignName: 'Ghost Campaign',
      details: { newBudget: '50' },
    };

    await expect(applyChange(client, change, false))
      .rejects.toThrow('Campaign not found');
  });
});

// ---------------------------------------------------------------------------
// applyChange — pause_ad_group
// ---------------------------------------------------------------------------
describe('applyChange — pause_ad_group', () => {
  let client;

  beforeEach(() => {
    client = new FakeGoogleAdsClient();
  });

  test('pause_ad_group with valid names pauses the ad group', async () => {
    const change = {
      type: 'pause_ad_group',
      campaignName: 'Honda Civic - Search',
      adGroupName: 'Civic Sedans',
    };

    const result = await applyChange(client, change, false);

    expect(result).toBe('Paused ad group: Civic Sedans in Honda Civic - Search');
    // pause_ad_group validates campaign exists first, producing a campaign query,
    // then looks up the ad group, so we only check the mutation itself
    const agMutation = client.mutations.find(m => m.type === 'adGroups.update');
    expect(agMutation).toBeDefined();
    expect(agMutation.data).toEqual([{
      resource_name: 'customers/1234567890/adGroups/1001',
      status: 'PAUSED',
    }]);
  });

  test('pause_ad_group with missing campaign throws', async () => {
    const change = {
      type: 'pause_ad_group',
      campaignName: 'Ghost Campaign',
      adGroupName: 'Civic Sedans',
    };

    await expect(applyChange(client, change, false))
      .rejects.toThrow('Campaign not found');
  });

  test('pause_ad_group with missing ad group throws', async () => {
    const change = {
      type: 'pause_ad_group',
      campaignName: 'Honda Civic - Search',
      adGroupName: 'Nonexistent Group',
    };

    await expect(applyChange(client, change, false))
      .rejects.toThrow('Ad group not found');
  });
});

// ---------------------------------------------------------------------------
// applyChange — enable_ad_group
// ---------------------------------------------------------------------------
describe('applyChange — enable_ad_group', () => {
  let client;

  beforeEach(() => {
    client = new FakeGoogleAdsClient();
  });

  test('enable_ad_group with valid names enables the ad group', async () => {
    const change = {
      type: 'enable_ad_group',
      campaignName: 'Honda Civic - Search',
      adGroupName: 'Civic Coupes',
    };

    const result = await applyChange(client, change, false);

    expect(result).toBe('Enabled ad group: Civic Coupes in Honda Civic - Search');
    expect(client.mutations).toHaveLength(1);
    expect(client.mutations[0].type).toBe('adGroups.update');
    expect(client.mutations[0].data).toEqual([{
      resource_name: 'customers/1234567890/adGroups/1002',
      status: 'ENABLED',
    }]);
  });

  test('enable_ad_group with missing ad group throws', async () => {
    const change = {
      type: 'enable_ad_group',
      campaignName: 'Honda Civic - Search',
      adGroupName: 'Nonexistent Group',
    };

    await expect(applyChange(client, change, false))
      .rejects.toThrow('Ad group not found');
    expect(client.mutations).toHaveLength(0);
  });

  test('enable_ad_group with missing campaign throws', async () => {
    const change = {
      type: 'enable_ad_group',
      campaignName: 'Ghost Campaign',
      adGroupName: 'Civic Coupes',
    };

    await expect(applyChange(client, change, false))
      .rejects.toThrow('Ad group not found');
    expect(client.mutations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyChange — pause_keyword
// ---------------------------------------------------------------------------
describe('applyChange — pause_keyword', () => {
  let client;

  beforeEach(() => {
    client = new FakeGoogleAdsClient();
  });

  test('pause_keyword queries by keyword text and match type, then pauses', async () => {
    const change = {
      type: 'pause_keyword',
      campaignName: 'Honda Civic - Search',
      details: { keyword: 'honda civic', matchType: 'EXACT' },
    };

    const result = await applyChange(client, change, false);

    expect(result).toBe('Paused keyword: [EXACT] "honda civic"');
    expect(client.mutations).toHaveLength(1);
    expect(client.mutations[0].type).toBe('adGroupCriteria.update');
    expect(client.mutations[0].data).toEqual([{
      resource_name: 'customers/1234567890/adGroupCriteria/1001~5001',
      status: 'PAUSED',
    }]);
  });

  test('pause_keyword with BROAD match type finds correct keyword', async () => {
    const change = {
      type: 'pause_keyword',
      campaignName: 'Honda Civic - Search',
      details: { keyword: 'buy civic', matchType: 'BROAD' },
    };

    const result = await applyChange(client, change, false);

    expect(result).toBe('Paused keyword: [BROAD] "buy civic"');
    expect(client.mutations[0].data[0].resource_name)
      .toBe('customers/1234567890/adGroupCriteria/1001~5002');
  });

  test('pause_keyword with non-existent keyword throws', async () => {
    const change = {
      type: 'pause_keyword',
      campaignName: 'Honda Civic - Search',
      details: { keyword: 'nonexistent keyword', matchType: 'EXACT' },
    };

    await expect(applyChange(client, change, false))
      .rejects.toThrow('Keyword not found: nonexistent keyword');
  });
});

// ---------------------------------------------------------------------------
// applyChange — add_keyword
// ---------------------------------------------------------------------------
describe('applyChange — add_keyword', () => {
  let client;

  beforeEach(() => {
    client = new FakeGoogleAdsClient();
  });

  test('add_keyword creates keyword with text, match type, and ad group resource', async () => {
    const change = {
      type: 'add_keyword',
      campaignName: 'Honda Civic - Search',
      adGroupName: 'Civic Sedans',
      details: { keyword: 'new honda civic', matchType: 'PHRASE' },
    };

    const result = await applyChange(client, change, false);

    expect(result).toBe('Added keyword [PHRASE] "new honda civic" to Civic Sedans');
    expect(client.mutations).toHaveLength(1);
    expect(client.mutations[0].type).toBe('adGroupCriteria.create');
    expect(client.mutations[0].data).toEqual([{
      ad_group: 'customers/1234567890/adGroups/1001',
      status: 'ENABLED',
      keyword: {
        text: 'new honda civic',
        match_type: 'PHRASE',
      },
    }]);
  });

  test('add_keyword defaults match type to BROAD when not specified', async () => {
    const change = {
      type: 'add_keyword',
      campaignName: 'Honda Civic - Search',
      adGroupName: 'Civic Sedans',
      details: { keyword: 'civic deals' },
    };

    const result = await applyChange(client, change, false);

    expect(result).toContain('[BROAD]');
    expect(client.mutations[0].data[0].keyword.match_type).toBe('BROAD');
  });

  test('add_keyword includes cpc_bid_micros when cpcBid is provided', async () => {
    const change = {
      type: 'add_keyword',
      campaignName: 'Honda Civic - Search',
      adGroupName: 'Civic Sedans',
      details: { keyword: 'cheap civic', matchType: 'EXACT', cpcBid: '2.50' },
    };

    const result = await applyChange(client, change, false);

    expect(result).toContain('Added keyword');
    const created = client.mutations[0].data[0];
    expect(created.cpc_bid_micros).toBe(2_500_000);
  });

  test('add_keyword omits cpc_bid_micros when cpcBid is not provided', async () => {
    const change = {
      type: 'add_keyword',
      campaignName: 'Honda Civic - Search',
      adGroupName: 'Civic Sedans',
      details: { keyword: 'civic reviews', matchType: 'BROAD' },
    };

    await applyChange(client, change, false);

    const created = client.mutations[0].data[0];
    expect(created).not.toHaveProperty('cpc_bid_micros');
  });

  test('add_keyword with missing ad group throws', async () => {
    const change = {
      type: 'add_keyword',
      campaignName: 'Honda Civic - Search',
      adGroupName: 'Nonexistent Group',
      details: { keyword: 'test', matchType: 'EXACT' },
    };

    await expect(applyChange(client, change, false))
      .rejects.toThrow('Ad group not found');
  });
});

// ---------------------------------------------------------------------------
// applyChange — add_negative_keyword
// ---------------------------------------------------------------------------
describe('applyChange — add_negative_keyword', () => {
  let client;

  beforeEach(() => {
    client = new FakeGoogleAdsClient();
  });

  test('add_negative_keyword creates campaign-level negative keyword', async () => {
    const change = {
      type: 'add_negative_keyword',
      campaignName: 'Honda Civic - Search',
      details: { keyword: 'free', matchType: 'BROAD' },
    };

    const result = await applyChange(client, change, false);

    expect(result).toBe('Added negative keyword [BROAD] "free" to Honda Civic - Search');
    expect(client.mutations).toHaveLength(1);
    expect(client.mutations[0].type).toBe('campaignCriteria.create');
    expect(client.mutations[0].data).toEqual([{
      campaign: 'customers/1234567890/campaigns/100',
      negative: true,
      keyword: {
        text: 'free',
        match_type: 'BROAD',
      },
    }]);
  });

  test('add_negative_keyword defaults match type to EXACT when not specified', async () => {
    const change = {
      type: 'add_negative_keyword',
      campaignName: 'Honda Civic - Search',
      details: { keyword: 'junk' },
    };

    const result = await applyChange(client, change, false);

    expect(result).toContain('[EXACT]');
    expect(client.mutations[0].data[0].keyword.match_type).toBe('EXACT');
  });
});

// ---------------------------------------------------------------------------
// applyChange — exclude_radius
// ---------------------------------------------------------------------------
describe('applyChange — exclude_radius', () => {
  let client;

  beforeEach(() => {
    client = new FakeGoogleAdsClient();
  });

  test('exclude_radius creates negative proximity criterion with correct geo data', async () => {
    const change = {
      type: 'exclude_radius',
      campaignName: 'Honda Civic - Search',
      details: { lat: 37.7749, lng: -122.4194, radius: 10 },
    };

    const result = await applyChange(client, change, false);

    expect(result).toBe('Excluded 10mi radius from Honda Civic - Search');
    expect(client.mutations).toHaveLength(1);
    expect(client.mutations[0].type).toBe('campaignCriteria.create');

    const criterion = client.mutations[0].data[0];
    expect(criterion.campaign).toBe('customers/1234567890/campaigns/100');
    expect(criterion.negative).toBe(true);
    expect(criterion.proximity.geo_point.latitude_in_micro_degrees).toBe(37_774_900);
    expect(criterion.proximity.geo_point.longitude_in_micro_degrees).toBe(-122_419_400);
    expect(criterion.proximity.radius).toBe(10);
    expect(criterion.proximity.radius_units).toBe('MILES');
  });

  test('exclude_radius uses custom units when specified', async () => {
    const change = {
      type: 'exclude_radius',
      campaignName: 'Honda Civic - Search',
      details: { lat: 40.0, lng: -74.0, radius: 25, units: 'KILOMETERS' },
    };

    await applyChange(client, change, false);

    const criterion = client.mutations[0].data[0];
    expect(criterion.proximity.radius_units).toBe('KILOMETERS');
  });

  test('exclude_radius with missing campaign throws', async () => {
    const change = {
      type: 'exclude_radius',
      campaignName: 'Ghost Campaign',
      details: { lat: 37.0, lng: -122.0, radius: 5 },
    };

    await expect(applyChange(client, change, false))
      .rejects.toThrow('Campaign not found');
  });
});

// ---------------------------------------------------------------------------
// applyChange — add_radius
// ---------------------------------------------------------------------------
describe('applyChange — add_radius', () => {
  let client;

  beforeEach(() => {
    client = new FakeGoogleAdsClient();
  });

  test('add_radius creates positive proximity criterion with correct geo data', async () => {
    const change = {
      type: 'add_radius',
      campaignName: 'Toyota Trucks',
      details: { lat: 34.0522, lng: -118.2437, radius: 15 },
    };

    const result = await applyChange(client, change, false);

    expect(result).toBe('Added 15mi radius targeting to Toyota Trucks');
    expect(client.mutations).toHaveLength(1);
    expect(client.mutations[0].type).toBe('campaignCriteria.create');

    const criterion = client.mutations[0].data[0];
    expect(criterion.campaign).toBe('customers/1234567890/campaigns/200');
    expect(criterion.negative).toBe(false);
    expect(criterion.proximity.geo_point.latitude_in_micro_degrees).toBe(34_052_200);
    expect(criterion.proximity.geo_point.longitude_in_micro_degrees).toBe(-118_243_700);
    expect(criterion.proximity.radius).toBe(15);
    expect(criterion.proximity.radius_units).toBe('MILES');
  });

  test('add_radius uses custom units when specified', async () => {
    const change = {
      type: 'add_radius',
      campaignName: 'Toyota Trucks',
      details: { lat: 34.0, lng: -118.0, radius: 30, units: 'KILOMETERS' },
    };

    await applyChange(client, change, false);

    const criterion = client.mutations[0].data[0];
    expect(criterion.proximity.radius_units).toBe('KILOMETERS');
  });
});

// ---------------------------------------------------------------------------
// applyChange — error cases
// ---------------------------------------------------------------------------
describe('applyChange — error cases', () => {
  let client;

  beforeEach(() => {
    client = new FakeGoogleAdsClient();
  });

  test('unknown change type throws descriptive error listing supported types', async () => {
    const change = {
      type: 'delete_campaign',
      campaignName: 'Honda Civic - Search',
    };

    await expect(applyChange(client, change, false))
      .rejects.toThrow('Unknown change type: "delete_campaign"');

    // Verify the error message lists supported types
    await expect(applyChange(client, change, false))
      .rejects.toThrow('Supported:');
  });

  test('unknown change type records no mutations', async () => {
    const change = { type: 'invalid_type', campaignName: 'Honda Civic - Search' };

    try {
      await applyChange(client, change, false);
    } catch (e) {
      // expected
    }

    expect(client.mutations).toHaveLength(0);
  });

  test('missing campaign in pause_campaign throws before any mutation', async () => {
    const change = { type: 'pause_campaign', campaignName: 'Nonexistent' };

    await expect(applyChange(client, change, false))
      .rejects.toThrow('Campaign not found');
    expect(client.mutations).toHaveLength(0);
  });

  test('missing campaign in enable_campaign throws', async () => {
    const change = { type: 'enable_campaign', campaignName: 'Nonexistent' };

    await expect(applyChange(client, change, false))
      .rejects.toThrow('Campaign not found');
  });

  test('missing campaign in add_negative_keyword throws', async () => {
    const change = {
      type: 'add_negative_keyword',
      campaignName: 'Nonexistent',
      details: { keyword: 'test', matchType: 'EXACT' },
    };

    await expect(applyChange(client, change, false))
      .rejects.toThrow('Campaign not found');
  });
});
