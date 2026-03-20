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

    // Pacing dashboard data (Phase 7.3)
    this._monthSpend = options.monthSpend || [
      { campaign: { id: '100', name: 'Honda Civic - Search', status: 'ENABLED' }, metrics: { cost_micros: 5000000 } },
      { campaign: { id: '200', name: 'Toyota Trucks', status: 'PAUSED' }, metrics: { cost_micros: 3200000 } },
    ];

    this._sharedBudgets = options.sharedBudgets || [
      { campaign: { id: '100', name: 'Honda Civic - Search' }, campaign_budget: { resource_name: 'customers/1234567890/campaignBudgets/8001', name: 'Shared Budget - Honda', amount_micros: 50000000 } },
      { campaign: { id: '101', name: 'Honda Accord - Search' }, campaign_budget: { resource_name: 'customers/1234567890/campaignBudgets/8001', name: 'Shared Budget - Honda', amount_micros: 50000000 } },
      { campaign: { id: '200', name: 'Toyota Trucks' }, campaign_budget: { resource_name: 'customers/1234567890/campaignBudgets/8002', name: 'Shared Budget - Toyota', amount_micros: 75000000 } },
    ];

    this._impressionShare = options.impressionShare || [
      { campaign: { id: '100', name: 'Honda Civic - Search' }, metrics: { search_impression_share: 0.85, search_budget_lost_impression_share: 0.10 } },
      { campaign: { id: '200', name: 'Toyota Trucks' }, metrics: { search_impression_share: 0.62, search_budget_lost_impression_share: 0.25 } },
    ];

    this._shoppingProducts = options.shoppingProducts || [
      { shopping_product: { resource_name: 'customers/1234567890/shoppingProducts/1', item_id: 'VIN001', condition: 'NEW', brand: 'Honda', custom_label1: 'Civic' } },
      { shopping_product: { resource_name: 'customers/1234567890/shoppingProducts/2', item_id: 'VIN002', condition: 'NEW', brand: 'Honda', custom_label1: 'Accord' } },
      { shopping_product: { resource_name: 'customers/1234567890/shoppingProducts/3', item_id: 'VIN003', condition: 'USED', brand: 'Toyota', custom_label1: 'Camry' } },
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
    this.recommendations = { dismiss: (data) => this._recordMutation('recommendations.dismiss', data) };
  }

  /**
   * Simulates GAQL query execution. Returns matching fake data based on query patterns.
   */
  async query(gaql) {
    const q = gaql.toLowerCase().trim();

    // Pacing queries (Phase 7.3) — must be checked before generic 'from campaign'
    if (q.includes('from campaign') && q.includes('cost_micros') && q.includes('this_month')) {
      return this._monthSpend;
    }

    if (q.includes('from campaign') && q.includes('explicitly_shared')) {
      return this._sharedBudgets;
    }

    if (q.includes('from campaign') && q.includes('search_impression_share')) {
      return this._impressionShare;
    }

    if (q.includes('from shopping_product')) {
      return this._shoppingProducts;
    }

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
