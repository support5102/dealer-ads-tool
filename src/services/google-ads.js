/**
 * Google Ads Service — creates API clients and executes GAQL queries.
 *
 * Called by: routes/accounts.js, routes/changes.js
 * Calls: google-ads-api library, axios (for REST fallback), utils/sanitize.js
 *
 * Provides:
 * - Client factory from OAuth refresh token
 * - MCC account discovery (listAccessibleCustomers + child account query)
 * - Account structure queries (campaigns, ad groups, keywords, locations)
 * - Token refresh helper
 */

const { GoogleAdsApi } = require('google-ads-api');
const axios = require('axios');
const { sanitizeGaqlString, sanitizeGaqlNumber } = require('../utils/sanitize');

/**
 * Creates a Google Ads API customer client.
 *
 * @param {Object} config - Google Ads credentials from config.js
 * @param {string} config.clientId - OAuth client ID
 * @param {string} config.clientSecret - OAuth client secret
 * @param {string} config.developerToken - Google Ads developer token
 * @param {string} refreshToken - User's OAuth refresh token
 * @param {string} customerId - Target customer account ID
 * @param {string} [loginCustomerId] - MCC login customer ID (if accessing via MCC)
 * @returns {Object} Google Ads API customer client
 */
function createClient(config, refreshToken, customerId, loginCustomerId) {
  const customerConfig = {
    customer_id:   customerId,
    refresh_token: refreshToken,
  };
  if (loginCustomerId) {
    customerConfig.login_customer_id = loginCustomerId;
  }

  return new GoogleAdsApi({
    client_id:       config.clientId,
    client_secret:   config.clientSecret,
    developer_token: config.developerToken,
  }).Customer(customerConfig);
}

/**
 * Lists all accessible customer IDs for the authenticated user.
 *
 * @param {Object} config - Google Ads credentials
 * @param {string} refreshToken - User's OAuth refresh token
 * @returns {Promise<string[]>} Array of customer resource names
 */
async function listAccessibleCustomers(config, refreshToken) {
  const api = new GoogleAdsApi({
    client_id:       config.clientId,
    client_secret:   config.clientSecret,
    developer_token: config.developerToken,
  });

  // Retry once on timeout — Railway cold starts can be slow
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await queryWithTimeout(
        api.listAccessibleCustomers(refreshToken),
        'accessible customers',
        30000 // 30s — Railway can be slow on first call
      );
      return result.resource_names || result.resourceNames || [];
    } catch (err) {
      if (attempt === 2 || !err.message.includes('Timed out')) throw err;
      console.warn('listAccessibleCustomers attempt 1 timed out, retrying...');
    }
  }
}

/**
 * Queries a customer account using GAQL via REST (for MCC discovery).
 *
 * @param {string} accessToken - Fresh OAuth access token
 * @param {string} developerToken - Google Ads developer token
 * @param {string} customerId - Customer ID to query
 * @param {string} query - GAQL query string
 * @param {string} [loginCustomerId] - MCC login customer ID
 * @returns {Promise<Object[]>} Query result rows
 */
async function queryViaRest(accessToken, developerToken, customerId, query, loginCustomerId) {
  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'developer-token': developerToken,
    'Content-Type': 'application/json',
  };
  if (loginCustomerId) {
    headers['login-customer-id'] = String(loginCustomerId);
  }

  const resp = await axios.post(
    `https://googleads.googleapis.com/v19/customers/${customerId}/googleAds:searchStream`,
    { query },
    { headers, timeout: 10000 }
  );

  const results = [];
  const data = Array.isArray(resp.data) ? resp.data : [resp.data];
  data.forEach(chunk => { if (chunk.results) results.push(...chunk.results); });
  return results;
}

/**
 * Refreshes an OAuth access token using the refresh token.
 *
 * @param {Object} config - Google Ads credentials (clientId, clientSecret)
 * @param {string} refreshToken - OAuth refresh token
 * @returns {Promise<string>} Fresh access token
 * @throws {Error} If token refresh fails
 */
async function refreshAccessToken(config, refreshToken) {
  const { data } = await axios.post('https://oauth2.googleapis.com/token', {
    client_id:     config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
  });
  return data.access_token;
}

/**
 * Wraps a query promise with a timeout.
 *
 * @param {Promise} queryPromise - The query to execute
 * @param {string} label - Human-readable label for error messages
 * @param {number} [ms=15000] - Timeout in milliseconds
 * @returns {Promise} Query result or timeout rejection
 */
function queryWithTimeout(queryPromise, label, ms = 15000) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(
      `Timed out fetching ${label}. Try again or check your Google Ads permissions.`
    )), ms);
  });
  return Promise.race([queryPromise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Fetches full account structure: campaigns, ad groups, keywords, locations.
 *
 * @param {Object} client - Google Ads API customer client
 * @returns {Promise<Object>} Account structure tree with campaigns, stats
 */
async function getAccountStructure(client) {
  // Fetch campaigns with budget (V2 omitted budget due to REST permission issues;
  // library client handles auth correctly so the join works here)
  const campaigns = await queryWithTimeout(client.query(`
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.bidding_strategy_type,
      campaign_budget.amount_micros
    FROM campaign
    WHERE campaign.status != 'REMOVED'
    ORDER BY campaign.name
  `), 'campaigns');

  // Fetch ad groups
  const adGroups = await queryWithTimeout(client.query(`
    SELECT
      ad_group.id,
      ad_group.name,
      ad_group.status,
      ad_group.cpc_bid_micros,
      campaign.name
    FROM ad_group
    WHERE campaign.status != 'REMOVED'
      AND ad_group.status != 'REMOVED'
    ORDER BY campaign.name, ad_group.name
  `), 'ad groups');

  // Fetch keywords (limit 2000 — balances completeness vs memory/latency)
  const keywords = await queryWithTimeout(client.query(`
    SELECT
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.status,
      ad_group_criterion.cpc_bid_micros,
      ad_group_criterion.negative,
      ad_group.name,
      campaign.name
    FROM ad_group_criterion
    WHERE ad_group_criterion.type = 'KEYWORD'
      AND campaign.status != 'REMOVED'
      AND ad_group.status != 'REMOVED'
      AND ad_group_criterion.status != 'REMOVED'
    ORDER BY campaign.name, ad_group.name
    LIMIT 2000
  `), 'keywords', 20000);

  // Fetch location targets (non-fatal — empty array on failure)
  const locations = await queryWithTimeout(client.query(`
    SELECT
      campaign_criterion.location.geo_target_constant,
      campaign_criterion.bid_modifier,
      campaign_criterion.negative,
      campaign.name
    FROM campaign_criterion
    WHERE campaign_criterion.type = 'LOCATION'
      AND campaign.status != 'REMOVED'
    LIMIT 200
  `), 'locations').catch(() => []);

  return buildStructureTree(campaigns, adGroups, keywords, locations);
}

/**
 * Assembles flat query results into a nested campaign → ad group → keyword tree.
 *
 * @param {Object[]} campaigns - Campaign query results
 * @param {Object[]} adGroups - Ad group query results
 * @param {Object[]} keywords - Keyword query results
 * @param {Object[]} locations - Location query results
 * @returns {Object} Nested structure with campaigns array and stats
 */
// Google Ads API enum → string mapping (library returns integers)
const STATUS_MAP = { 0: 'UNSPECIFIED', 1: 'UNKNOWN', 2: 'ENABLED', 3: 'PAUSED', 4: 'REMOVED' };
function normalizeStatus(val) {
  if (typeof val === 'string') return val;
  return STATUS_MAP[val] || String(val);
}

function buildStructureTree(campaigns, adGroups, keywords, locations) {
  const campMap = {};

  campaigns.forEach(row => {
    const c = row.campaign;
    const budgetMicros = row.campaign_budget?.amount_micros;
    campMap[c.name] = {
      id:        String(c.id),
      name:      c.name,
      status:    normalizeStatus(c.status),
      type:      String(c.advertising_channel_type),
      bidding:   String(c.bidding_strategy_type),
      budget:    budgetMicros != null ? (budgetMicros / 1_000_000).toFixed(2) : '?',
      adGroups:  [],
      locations: [],
    };
  });

  adGroups.forEach(row => {
    const camp = campMap[row.campaign.name];
    if (!camp) return;
    camp.adGroups.push({
      id:         String(row.ad_group.id),
      name:       row.ad_group.name,
      status:     normalizeStatus(row.ad_group.status),
      defaultBid: row.ad_group.cpc_bid_micros
        ? (row.ad_group.cpc_bid_micros / 1_000_000).toFixed(2) : '?',
      keywords:   [],
    });
  });

  keywords.forEach(row => {
    const camp = campMap[row.campaign.name];
    if (!camp) return;
    const ag = camp.adGroups.find(a => a.name === row.ad_group.name);
    if (!ag) return;
    const kw = row.ad_group_criterion;
    ag.keywords.push({
      text:     kw.keyword.text,
      match:    String(kw.keyword.match_type),
      status:   normalizeStatus(kw.status),
      bid:      kw.cpc_bid_micros ? (kw.cpc_bid_micros / 1_000_000).toFixed(2) : null,
      negative: kw.negative,
    });
  });

  locations.forEach(row => {
    const camp = campMap[row.campaign.name];
    if (!camp) return;
    camp.locations.push({
      geoTarget: row.campaign_criterion.location?.geo_target_constant || '',
      negative:  row.campaign_criterion.negative,
      bidMod:    row.campaign_criterion.bid_modifier,
    });
  });

  const campaignList = Object.values(campMap);
  return {
    campaigns: campaignList,
    stats: {
      campaigns: campaigns.length,
      adGroups:  adGroups.length,
      keywords:  keywords.length,
      keywordsTruncated: keywords.length >= 2000,
    },
  };
}

// ===========================================================================
// Pacing Dashboard Queries (Phase 7.3)
// ===========================================================================

/**
 * Fetches month-to-date spend per campaign.
 *
 * @param {Object} client - Google Ads API customer client
 * @returns {Promise<Object[]>} Array of { campaignId, campaignName, status, spend }
 */
async function getMonthSpend(client) {
  const rows = await queryWithTimeout(client.query(`
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      metrics.cost_micros
    FROM campaign
    WHERE segments.date DURING THIS_MONTH
      AND campaign.status != 'REMOVED'
  `), 'month spend');

  return rows.map(row => ({
    campaignId: String(row.campaign.id),
    campaignName: row.campaign.name,
    status: normalizeStatus(row.campaign.status),
    spend: (row.metrics.cost_micros ?? 0) / 1_000_000,
  }));
}

/**
 * Fetches all explicitly shared budgets with their linked campaigns.
 * Returns one entry per shared budget, with an array of campaign names.
 *
 * @param {Object} client - Google Ads API customer client
 * @returns {Promise<Object[]>} Array of { resourceName, name, dailyBudget, campaigns }
 */
async function getSharedBudgets(client) {
  const rows = await queryWithTimeout(client.query(`
    SELECT
      campaign.id,
      campaign.name,
      campaign_budget.resource_name,
      campaign_budget.name,
      campaign_budget.amount_micros
    FROM campaign
    WHERE campaign_budget.explicitly_shared = TRUE
      AND campaign.status != 'REMOVED'
    ORDER BY campaign_budget.name, campaign.name
  `), 'shared budgets');

  // Deduplicate by budget resource_name, collecting linked campaigns
  const budgetMap = new Map();
  for (const row of rows) {
    const key = row.campaign_budget.resource_name;
    if (!budgetMap.has(key)) {
      budgetMap.set(key, {
        resourceName: key,
        name: row.campaign_budget.name,
        dailyBudget: (row.campaign_budget.amount_micros ?? 0) / 1_000_000,
        campaigns: [],
      });
    }
    budgetMap.get(key).campaigns.push({
      campaignId: String(row.campaign.id),
      campaignName: row.campaign.name,
    });
  }

  return Array.from(budgetMap.values());
}

/**
 * Fetches search impression share metrics per campaign for current month.
 * Only includes ENABLED campaigns — paused campaigns don't generate impression data.
 *
 * @param {Object} client - Google Ads API customer client
 * @returns {Promise<Object[]>} Array of { campaignId, campaignName, impressionShare, budgetLostShare }
 */
async function getImpressionShare(client) {
  const rows = await queryWithTimeout(client.query(`
    SELECT
      campaign.id,
      campaign.name,
      metrics.search_impression_share,
      metrics.search_budget_lost_impression_share
    FROM campaign
    WHERE segments.date DURING THIS_MONTH
      AND campaign.status = 'ENABLED'
  `), 'impression share');

  return rows.map(row => ({
    campaignId: String(row.campaign.id),
    campaignName: row.campaign.name,
    impressionShare: row.metrics.search_impression_share ?? null,
    budgetLostShare: row.metrics.search_budget_lost_impression_share ?? null,
  }));
}

/**
 * Fetches vehicle inventory from shopping product feed.
 * Note: shopping_product resource requires google-ads-api v23+ / API v17+.
 * If the npm package doesn't support it, fall back to queryViaRest.
 *
 * @param {Object} client - Google Ads API customer client
 * @returns {Promise<Object>} { items: [{ itemId, condition, brand, model }], truncated: boolean }
 */
async function getInventory(client) {
  const rows = await queryWithTimeout(client.query(`
    SELECT
      shopping_product.item_id,
      shopping_product.condition,
      shopping_product.brand,
      shopping_product.custom_label1
    FROM shopping_product
    WHERE shopping_product.status = 'ELIGIBLE'
    LIMIT 5000
  `), 'inventory', 20000);

  return {
    items: rows.map(row => ({
      itemId: row.shopping_product.item_id,
      condition: row.shopping_product.condition,
      brand: row.shopping_product.brand || null,
      model: row.shopping_product.custom_label1 || null,
    })),
    truncated: rows.length >= 5000,
  };
}

module.exports = {
  createClient,
  listAccessibleCustomers,
  queryViaRest,
  refreshAccessToken,
  getAccountStructure,
  buildStructureTree,
  queryWithTimeout,
  getMonthSpend,
  getSharedBudgets,
  getImpressionShare,
  getInventory,
};
