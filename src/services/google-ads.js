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
 * Lists all accessible customer IDs for the authenticated user via REST.
 *
 * @param {string} accessToken - Fresh OAuth access token
 * @param {string} developerToken - Google Ads developer token
 * @returns {Promise<string[]>} Array of customer resource names
 */
async function listAccessibleCustomers(accessToken, developerToken) {
  const resp = await axios.get(
    'https://googleads.googleapis.com/v19/customers:listAccessibleCustomers',
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': developerToken,
      },
      timeout: 15000,
    }
  );
  return resp.data.resourceNames || [];
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
    { headers, timeout: 20000 }
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
 * Fetches full account structure via REST: campaigns, ad groups, keywords, locations.
 *
 * @param {Object} restCtx - REST context { accessToken, developerToken, customerId, loginCustomerId }
 * @returns {Promise<Object>} Account structure tree with campaigns, stats
 */
async function getAccountStructure(restCtx) {
  const doQuery = restCtx._queryFn || queryViaRest;
  const { accessToken, developerToken, customerId, loginCustomerId } = restCtx;

  const campaigns = await doQuery(accessToken, developerToken, customerId,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
            campaign.bidding_strategy_type, campaign_budget.amount_micros
     FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name`,
    loginCustomerId);

  const adGroups = await doQuery(accessToken, developerToken, customerId,
    `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.cpc_bid_micros, campaign.name
     FROM ad_group WHERE campaign.status != 'REMOVED' AND ad_group.status != 'REMOVED'
     ORDER BY campaign.name, ad_group.name`,
    loginCustomerId);

  const keywords = await doQuery(accessToken, developerToken, customerId,
    `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
            ad_group_criterion.status, ad_group_criterion.cpc_bid_micros,
            ad_group_criterion.negative, ad_group.name, campaign.name
     FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD'
       AND campaign.status != 'REMOVED' AND ad_group.status != 'REMOVED'
       AND ad_group_criterion.status != 'REMOVED'
     ORDER BY campaign.name, ad_group.name LIMIT 2000`,
    loginCustomerId);

  let locations = [];
  try {
    locations = await doQuery(accessToken, developerToken, customerId,
      `SELECT campaign_criterion.location.geo_target_constant, campaign_criterion.bid_modifier,
              campaign_criterion.negative, campaign.name
       FROM campaign_criterion WHERE campaign_criterion.type = 'LOCATION'
         AND campaign.status != 'REMOVED' LIMIT 200`,
      loginCustomerId);
  } catch (_) { /* non-fatal */ }

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

  // Helper: REST returns camelCase, gRPC library returns snake_case
  // Support both for backward compat with tests
  const get = (obj, camel, snake) => obj[camel] !== undefined ? obj[camel] : obj[snake];

  campaigns.forEach(row => {
    const c = row.campaign;
    const budget = row.campaignBudget || row.campaign_budget;
    const budgetMicros = budget ? (get(budget, 'amountMicros', 'amount_micros')) : undefined;
    campMap[c.name] = {
      id:        String(c.id),
      name:      c.name,
      status:    normalizeStatus(c.status),
      type:      String(get(c, 'advertisingChannelType', 'advertising_channel_type')),
      bidding:   String(get(c, 'biddingStrategyType', 'bidding_strategy_type')),
      budget:    budgetMicros != null ? (budgetMicros / 1_000_000).toFixed(2) : '?',
      adGroups:  [],
      locations: [],
    };
  });

  adGroups.forEach(row => {
    const camp = campMap[row.campaign.name];
    if (!camp) return;
    const ag = row.adGroup || row.ad_group;
    camp.adGroups.push({
      id:         String(ag.id),
      name:       ag.name,
      status:     normalizeStatus(ag.status),
      defaultBid: get(ag, 'cpcBidMicros', 'cpc_bid_micros')
        ? (get(ag, 'cpcBidMicros', 'cpc_bid_micros') / 1_000_000).toFixed(2) : '?',
      keywords:   [],
    });
  });

  keywords.forEach(row => {
    const camp = campMap[row.campaign.name];
    if (!camp) return;
    const ag = row.adGroup || row.ad_group;
    const agEntry = camp.adGroups.find(a => a.name === ag.name);
    if (!agEntry) return;
    const kw = row.adGroupCriterion || row.ad_group_criterion;
    agEntry.keywords.push({
      text:     kw.keyword.text,
      match:    String(get(kw.keyword, 'matchType', 'match_type')),
      status:   normalizeStatus(kw.status),
      bid:      get(kw, 'cpcBidMicros', 'cpc_bid_micros')
        ? (get(kw, 'cpcBidMicros', 'cpc_bid_micros') / 1_000_000).toFixed(2) : null,
      negative: kw.negative,
    });
  });

  locations.forEach(row => {
    const camp = campMap[row.campaign.name];
    if (!camp) return;
    const cc = row.campaignCriterion || row.campaign_criterion;
    camp.locations.push({
      geoTarget: cc.location?.geoTargetConstant || cc.location?.geo_target_constant || '',
      negative:  cc.negative,
      bidMod:    get(cc, 'bidModifier', 'bid_modifier'),
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
 * Fetches month-to-date spend per campaign via REST.
 *
 * @param {Object} restCtx - REST context { accessToken, developerToken, customerId, loginCustomerId }
 * @returns {Promise<Object[]>} Array of { campaignId, campaignName, status, spend }
 */
async function getMonthSpend(restCtx) {
  const doQuery = restCtx._queryFn || queryViaRest;
  const rows = await doQuery(
    restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
    `SELECT campaign.id, campaign.name, campaign.status, metrics.cost_micros
     FROM campaign
     WHERE segments.date DURING THIS_MONTH AND campaign.status != 'REMOVED'`,
    restCtx.loginCustomerId
  );

  return rows.map(row => ({
    campaignId: String(row.campaign.id),
    campaignName: row.campaign.name,
    status: normalizeStatus(row.campaign.status),
    spend: (row.metrics.costMicros ?? 0) / 1_000_000,
  }));
}

/**
 * Fetches all explicitly shared budgets with their linked campaigns via REST.
 * Returns one entry per shared budget, with an array of campaign names.
 *
 * @param {Object} restCtx - REST context { accessToken, developerToken, customerId, loginCustomerId }
 * @returns {Promise<Object[]>} Array of { resourceName, name, dailyBudget, campaigns }
 */
async function getSharedBudgets(restCtx) {
  const doQuery = restCtx._queryFn || queryViaRest;
  const rows = await doQuery(
    restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
    `SELECT campaign.id, campaign.name, campaign_budget.resource_name, campaign_budget.name, campaign_budget.amount_micros
     FROM campaign
     WHERE campaign_budget.explicitly_shared = TRUE AND campaign.status != 'REMOVED'
     ORDER BY campaign_budget.name, campaign.name`,
    restCtx.loginCustomerId
  );

  // Deduplicate by budget resource_name, collecting linked campaigns
  const budgetMap = new Map();
  for (const row of rows) {
    const key = row.campaignBudget.resourceName;
    if (!budgetMap.has(key)) {
      budgetMap.set(key, {
        resourceName: key,
        name: row.campaignBudget.name,
        dailyBudget: (row.campaignBudget.amountMicros ?? 0) / 1_000_000,
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
 * Fetches search impression share metrics per campaign for current month via REST.
 * Only includes ENABLED campaigns — paused campaigns don't generate impression data.
 *
 * @param {Object} restCtx - REST context { accessToken, developerToken, customerId, loginCustomerId }
 * @returns {Promise<Object[]>} Array of { campaignId, campaignName, impressionShare, budgetLostShare }
 */
async function getImpressionShare(restCtx) {
  const doQuery = restCtx._queryFn || queryViaRest;
  const rows = await doQuery(
    restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
    `SELECT campaign.id, campaign.name, metrics.search_impression_share, metrics.search_budget_lost_impression_share
     FROM campaign
     WHERE segments.date DURING THIS_MONTH AND campaign.status = 'ENABLED'`,
    restCtx.loginCustomerId
  );

  return rows.map(row => ({
    campaignId: String(row.campaign.id),
    campaignName: row.campaign.name,
    impressionShare: row.metrics.searchImpressionShare ?? null,
    budgetLostShare: row.metrics.searchBudgetLostImpressionShare ?? null,
  }));
}

/**
 * Fetches vehicle inventory from shopping product feed via REST.
 *
 * @param {Object} restCtx - REST context { accessToken, developerToken, customerId, loginCustomerId }
 * @returns {Promise<Object>} { items: [{ itemId, condition, brand, model }], truncated: boolean }
 */
async function getInventory(restCtx) {
  const doQuery = restCtx._queryFn || queryViaRest;
  const rows = await doQuery(
    restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
    `SELECT shopping_product.item_id, shopping_product.condition, shopping_product.brand, shopping_product.custom_label1
     FROM shopping_product
     WHERE shopping_product.status = 'ELIGIBLE'
     LIMIT 5000`,
    restCtx.loginCustomerId
  );

  return {
    items: rows.map(row => ({
      itemId: row.shoppingProduct.itemId,
      condition: row.shoppingProduct.condition,
      brand: row.shoppingProduct.brand || null,
      model: row.shoppingProduct.customLabel1 || null,
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
