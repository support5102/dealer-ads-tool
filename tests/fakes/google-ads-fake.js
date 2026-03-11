/**
 * Fake Google Ads Client — in-memory test double for google-ads-api.
 *
 * Used by: tests/unit/test_change_executor.js, tests/unit/test_structure_builder.js
 *
 * Mimics the real Google Ads API customer client interface:
 * - client.query(gaql) → returns rows
 * - client.campaigns.update([...]) → records mutation
 * - client.adGroups.update([...]) → records mutation
 * - client.adGroupCriteria.update([...]) → records mutation
 * - client.adGroupCriteria.create([...]) → records mutation
 * - client.campaignCriteria.create([...]) → records mutation
 * - client.campaignBudgets.update([...]) → records mutation
 * - client.credentials.customer_id → returns customer ID
 */

class FakeGoogleAdsClient {
  constructor(options = {}) {
    this.credentials = { customer_id: options.customerId || '1234567890' };

    // Default test data — can be overridden via options
    this._campaigns = options.campaigns || [
      { campaign: { id: '100', name: 'Honda Civic - Search', status: 'ENABLED', advertising_channel_type: 'SEARCH', bidding_strategy_type: 'MANUAL_CPC' }, campaign_budget: { amount_micros: 50000000 } },
      { campaign: { id: '200', name: 'Toyota Trucks', status: 'PAUSED', advertising_channel_type: 'SEARCH', bidding_strategy_type: 'MAXIMIZE_CLICKS' }, campaign_budget: { amount_micros: 100000000 } },
    ];

    this._adGroups = options.adGroups || [
      { ad_group: { id: '1001', name: 'Civic Sedans', status: 'ENABLED', cpc_bid_micros: 1500000 }, campaign: { name: 'Honda Civic - Search' } },
      { ad_group: { id: '1002', name: 'Civic Coupes', status: 'PAUSED', cpc_bid_micros: 2000000 }, campaign: { name: 'Honda Civic - Search' } },
      { ad_group: { id: '2001', name: 'Tacoma', status: 'ENABLED', cpc_bid_micros: 1000000 }, campaign: { name: 'Toyota Trucks' } },
    ];

    this._keywords = options.keywords || [
      { ad_group_criterion: { keyword: { text: 'honda civic', match_type: 'EXACT' }, status: 'ENABLED', cpc_bid_micros: 1200000, negative: false, resource_name: 'customers/1234567890/adGroupCriteria/1001~5001' }, ad_group: { name: 'Civic Sedans' }, campaign: { name: 'Honda Civic - Search' } },
      { ad_group_criterion: { keyword: { text: 'buy civic', match_type: 'BROAD' }, status: 'ENABLED', cpc_bid_micros: null, negative: false, resource_name: 'customers/1234567890/adGroupCriteria/1001~5002' }, ad_group: { name: 'Civic Sedans' }, campaign: { name: 'Honda Civic - Search' } },
    ];

    this._locations = options.locations || [];

    this._budgets = options.budgets || [
      { campaign_budget: { resource_name: 'customers/1234567890/campaignBudgets/9001', amount_micros: 50000000 }, campaign: { id: '100' } },
      { campaign_budget: { resource_name: 'customers/1234567890/campaignBudgets/9002', amount_micros: 100000000 }, campaign: { id: '200' } },
    ];

    // Track all mutations for assertions
    this.mutations = [];

    // Sub-resource APIs
    this.campaigns = { update: (data) => this._recordMutation('campaigns.update', data) };
    this.adGroups = { update: (data) => this._recordMutation('adGroups.update', data) };
    this.adGroupCriteria = {
      update: (data) => this._recordMutation('adGroupCriteria.update', data),
      create: (data) => this._recordMutation('adGroupCriteria.create', data),
    };
    this.campaignCriteria = { create: (data) => this._recordMutation('campaignCriteria.create', data) };
    this.campaignBudgets = { update: (data) => this._recordMutation('campaignBudgets.update', data) };
  }

  /**
   * Simulates GAQL query execution. Returns matching fake data based on query patterns.
   */
  async query(gaql) {
    const q = gaql.toLowerCase().trim();

    // Campaign lookup by name
    if (q.includes('from campaign') && q.includes('campaign.name =')) {
      const nameMatch = gaql.match(/campaign\.name\s*=\s*'([^']+)'/i);
      if (nameMatch) {
        return this._campaigns.filter(r => r.campaign.name === nameMatch[1]);
      }
    }

    // Campaign lookup by ID (for budget queries)
    if (q.includes('campaign_budget') && q.includes('campaign.id =')) {
      const idMatch = gaql.match(/campaign\.id\s*=\s*(\d+)/i);
      if (idMatch) {
        return this._budgets.filter(r => String(r.campaign.id) === idMatch[1]);
      }
      return [];
    }

    // All campaigns
    if (q.includes('from campaign') && !q.includes('campaign.name =')) {
      return this._campaigns;
    }

    // Keyword lookup (must be checked before ad_group — 'from ad_group_criterion' contains 'from ad_group')
    if (q.includes('from ad_group_criterion') && q.includes('keyword.text =')) {
      const kwMatch = gaql.match(/keyword\.text\s*=\s*'([^']+)'/i);
      const matchTypeMatch = gaql.match(/keyword\.match_type\s*=\s*'([^']+)'/i);
      if (kwMatch) {
        return this._keywords.filter(r =>
          r.ad_group_criterion.keyword.text === kwMatch[1] &&
          (!matchTypeMatch || r.ad_group_criterion.keyword.match_type === matchTypeMatch[1])
        );
      }
    }

    // All keywords
    if (q.includes('from ad_group_criterion')) {
      return this._keywords;
    }

    // Ad group lookup by name
    if (q.includes('from ad_group') && q.includes('ad_group.name =')) {
      const campMatch = gaql.match(/campaign\.name\s*=\s*'([^']+)'/i);
      const agMatch = gaql.match(/ad_group\.name\s*=\s*'([^']+)'/i);
      if (campMatch && agMatch) {
        return this._adGroups.filter(r =>
          r.campaign.name === campMatch[1] && r.ad_group.name === agMatch[1]
        );
      }
    }

    // All ad groups
    if (q.includes('from ad_group')) {
      return this._adGroups;
    }

    // Location targets
    if (q.includes('from campaign_criterion')) {
      return this._locations;
    }

    return [];
  }

  _recordMutation(type, data) {
    this.mutations.push({ type, data });
    return Promise.resolve();
  }
}

module.exports = { FakeGoogleAdsClient };
