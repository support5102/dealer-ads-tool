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

  const result = await Promise.race([
    api.listAccessibleCustomers(refreshToken),
    new Promise((_, rej) => setTimeout(() => rej(new Error(
      'Timed out listing accessible customers. Try again or check your Google Ads permissions.'
    )), 15000)),
  ]);

  return result.resource_names || result.resourceNames || [];
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
 * Fetches full account structure: campaigns, ad groups, keywords, locations.
 *
 * @param {Object} client - Google Ads API customer client
 * @returns {Promise<Object>} Account structure tree with campaigns, stats
 */
async function getAccountStructure(client) {
  // Fetch campaigns (no budget join — permission issues in V2)
  const campaigns = await client.query(`
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.bidding_strategy_type
    FROM campaign
    WHERE campaign.status != 'REMOVED'
    ORDER BY campaign.name
  `);

  // Fetch ad groups
  const adGroups = await client.query(`
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
  `);

  // Fetch keywords (limit 500 per account for speed)
  const keywords = await client.query(`
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
    LIMIT 500
  `);

  // Fetch location targets
  const locations = await client.query(`
    SELECT
      campaign_criterion.location.geo_target_constant,
      campaign_criterion.bid_modifier,
      campaign_criterion.negative,
      campaign.name
    FROM campaign_criterion
    WHERE campaign_criterion.type = 'LOCATION'
      AND campaign.status != 'REMOVED'
    LIMIT 200
  `).catch(() => []);

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
function buildStructureTree(campaigns, adGroups, keywords, locations) {
  const campMap = {};

  campaigns.forEach(row => {
    const c = row.campaign;
    campMap[c.name] = {
      id:        String(c.id),
      name:      c.name,
      status:    c.status,
      type:      c.advertising_channel_type,
      bidding:   c.bidding_strategy_type,
      budget:    '?', // TODO: fix budget display (V2 bug)
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
      status:     row.ad_group.status,
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
      match:    kw.keyword.match_type,
      status:   kw.status,
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
    },
  };
}

module.exports = {
  createClient,
  listAccessibleCustomers,
  queryViaRest,
  refreshAccessToken,
  getAccountStructure,
  buildStructureTree,
};
