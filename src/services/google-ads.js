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
    customer_id:   String(customerId).replace(/-/g, ''),
    refresh_token: refreshToken,
  };
  if (loginCustomerId) {
    customerConfig.login_customer_id = String(loginCustomerId).replace(/-/g, '');
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
    'https://googleads.googleapis.com/v20/customers:listAccessibleCustomers',
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
  const cleanCustomerId = String(customerId).replace(/-/g, '');
  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'developer-token': developerToken,
    'Content-Type': 'application/json',
  };
  if (loginCustomerId) {
    headers['login-customer-id'] = String(loginCustomerId).replace(/-/g, '');
  }

  let resp;
  try {
    resp = await axios.post(
      `https://googleads.googleapis.com/v20/customers/${cleanCustomerId}/googleAds:searchStream`,
      { query },
      { headers, timeout: 20000 }
    );
  } catch (err) {
    // Log full API error details for debugging
    if (err.response) {
      console.error(`[queryViaRest] HTTP ${err.response.status} for customer ${cleanCustomerId}`);
      console.error('[queryViaRest] Response body:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('[queryViaRest] Network error:', err.message);
    }
    throw err;
  }

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
    spend: (row.metrics?.costMicros ?? 0) / 1_000_000,
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
     WHERE campaign_budget.explicitly_shared = TRUE AND campaign.status = 'ENABLED'
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
async function getImpressionShare(restCtx, sinceDate) {
  const doQuery = restCtx._queryFn || queryViaRest;
  // If a budget change date is provided and falls within this month, narrow the
  // impression share window to only the post-change period so the numbers reflect
  // performance after the pacing adjustment — not the full month average.
  let dateFilter = 'segments.date DURING THIS_MONTH';
  if (sinceDate) {
    const today = new Date().toISOString().slice(0, 10);
    dateFilter = `segments.date BETWEEN '${sinceDate}' AND '${today}'`;
  }
  const rows = await doQuery(
    restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
    `SELECT campaign.id, campaign.name, metrics.search_impression_share, metrics.search_budget_lost_impression_share
     FROM campaign
     WHERE ${dateFilter} AND campaign.status = 'ENABLED'`,
    restCtx.loginCustomerId
  );

  return rows.map(row => ({
    campaignId: String(row.campaign.id),
    campaignName: row.campaign.name,
    impressionShare: row.metrics?.searchImpressionShare ?? null,
    budgetLostShare: row.metrics?.searchBudgetLostImpressionShare ?? null,
  }));
}

/**
 * Fetches vehicle inventory count from VLA feed data.
 *
 * Strategy:
 * 1. Primary: shopping_performance_view — counts unique products that actually
 *    served in VLA/Shopping campaigns in the last 14 days. Works regardless of
 *    Merchant Center linking level (MCC vs sub-account).
 * 2. Fallback: shopping_product with status ELIGIBLE — direct feed query.
 *
 * @param {Object} restCtx - REST context { accessToken, developerToken, customerId, loginCustomerId }
 * @returns {Promise<Object>} { newCount, usedCount, totalCount, source }
 */
async function getInventory(restCtx) {
  const { extractModelFromProduct } = require('./campaign-classifier');
  const doQuery = restCtx._queryFn || queryViaRest;

  // Primary: count unique vehicles from shopping performance (actually serving)
  try {
    const rows = await doQuery(
      restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
      `SELECT segments.product_item_id, segments.product_condition,
              segments.product_title, segments.product_brand
       FROM shopping_performance_view
       WHERE segments.date DURING LAST_14_DAYS
       LIMIT 10000`,
      restCtx.loginCustomerId
    );

    if (rows.length > 0) {
      // Deduplicate by item_id — same vehicle can serve multiple times
      const seen = new Map();
      for (const row of rows) {
        const id = row.segments?.productItemId;
        if (id && !seen.has(id)) {
          seen.set(id, {
            condition: (row.segments?.productCondition || '').toUpperCase(),
            title: row.segments?.productTitle || '',
            brand: row.segments?.productBrand || '',
          });
        }
      }
      let newCount = 0;
      let usedCount = 0;
      const newInventoryByModel = {};
      for (const [id, data] of seen.entries()) {
        const isNew = data.condition === 'NEW' || (!data.condition);
        if (isNew) {
          newCount++;
          const model = extractModelFromProduct(id, data.title, data.brand);
          if (model) {
            newInventoryByModel[model] = (newInventoryByModel[model] || 0) + 1;
          }
        } else {
          usedCount++;
        }
      }
      return { newCount, usedCount, totalCount: seen.size, source: 'shopping_performance', newInventoryByModel };
    }
  } catch (err) {
    console.warn('getInventory shopping_performance_view failed (trying fallback):', err.message);
  }

  // Fallback: direct shopping_product query
  try {
    const rows = await doQuery(
      restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
      `SELECT shopping_product.item_id, shopping_product.condition,
              shopping_product.brand, shopping_product.title
       FROM shopping_product
       WHERE shopping_product.status = 'ELIGIBLE'
       LIMIT 5000`,
      restCtx.loginCustomerId
    );

    let newCount = 0;
    let usedCount = 0;
    const newInventoryByModel = {};
    for (const row of rows) {
      const condition = (row.shoppingProduct?.condition || '').toUpperCase();
      if (condition === 'USED' || condition === 'REFURBISHED') {
        usedCount++;
      } else {
        newCount++;
        const model = extractModelFromProduct(
          row.shoppingProduct?.itemId,
          row.shoppingProduct?.title,
          row.shoppingProduct?.brand
        );
        if (model) {
          newInventoryByModel[model] = (newInventoryByModel[model] || 0) + 1;
        }
      }
    }
    return { newCount, usedCount, totalCount: rows.length, source: 'shopping_product', newInventoryByModel };
  } catch (err) {
    console.warn('getInventory fallback also failed (non-fatal):', err.message);
    return { newCount: 0, usedCount: 0, totalCount: 0, source: 'none', newInventoryByModel: {} };
  }
}

/**
 * Fetches campaigns with dedicated (non-shared) budgets via REST.
 * Used to find VLA and other campaigns with their own budget line.
 *
 * @param {Object} restCtx - REST context { accessToken, developerToken, customerId, loginCustomerId }
 * @returns {Promise<Object[]>} Array of { campaignId, campaignName, channelType, resourceName, dailyBudget }
 */
async function getDedicatedBudgets(restCtx) {
  const doQuery = restCtx._queryFn || queryViaRest;
  const rows = await doQuery(
    restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
    `SELECT campaign.id, campaign.name, campaign.advertising_channel_type,
            campaign_budget.resource_name, campaign_budget.amount_micros
     FROM campaign
     WHERE campaign_budget.explicitly_shared = FALSE
       AND campaign.status = 'ENABLED'
     ORDER BY campaign.name`,
    restCtx.loginCustomerId
  );

  // Deduplicate by budget resource_name — multiple campaigns can share the
  // same non-shared budget, and each would return a separate row.
  const budgetMap = new Map();
  for (const row of rows) {
    const key = row.campaignBudget?.resourceName ?? row.campaign_budget?.resource_name ?? '';
    if (!budgetMap.has(key)) {
      budgetMap.set(key, {
        campaignId: String(row.campaign.id),
        campaignName: row.campaign.name,
        channelType: String(row.campaign.advertisingChannelType ?? row.campaign.advertising_channel_type ?? ''),
        resourceName: key,
        dailyBudget: ((row.campaignBudget?.amountMicros ?? row.campaign_budget?.amount_micros ?? 0)) / 1_000_000,
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

// ===========================================================================
// Audit & Optimization Queries (Phase 9)
// ===========================================================================

/**
 * Fetches keyword-level performance metrics for the last 7 days via REST.
 * Used by audit engine (negative conflicts, impression share) and CPC optimizer.
 *
 * @param {Object} restCtx - REST context { accessToken, developerToken, customerId, loginCustomerId }
 * @returns {Promise<Object[]>} Array of keyword performance objects
 */
async function getKeywordPerformance(restCtx) {
  const doQuery = restCtx._queryFn || queryViaRest;
  const rows = await doQuery(
    restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
    `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
            ad_group_criterion.status, ad_group_criterion.negative,
            ad_group_criterion.cpc_bid_micros,
            ad_group.name, ad_group.id, campaign.name, campaign.id,
            metrics.clicks, metrics.impressions, metrics.average_cpc,
            metrics.ctr, metrics.search_impression_share
     FROM keyword_view
     WHERE segments.date DURING LAST_7_DAYS
       AND campaign.status = 'ENABLED'
       AND ad_group.status = 'ENABLED'
     ORDER BY metrics.impressions DESC
     LIMIT 5000`,
    restCtx.loginCustomerId
  );

  return rows.map(row => {
    const kw = row.adGroupCriterion || row.ad_group_criterion || {};
    const keyword = kw.keyword || {};
    const m = row.metrics || {};
    return {
      keyword: keyword.text || '',
      matchType: String(keyword.matchType ?? keyword.match_type ?? ''),
      status: normalizeStatus(kw.status),
      negative: kw.negative || false,
      cpcBid: (kw.cpcBidMicros ?? kw.cpc_bid_micros ?? 0) / 1_000_000,
      adGroupName: row.adGroup?.name ?? row.ad_group?.name ?? '',
      adGroupId: String(row.adGroup?.id ?? row.ad_group?.id ?? ''),
      campaignName: row.campaign?.name ?? '',
      campaignId: String(row.campaign?.id ?? ''),
      clicks: m.clicks ?? 0,
      impressions: m.impressions ?? 0,
      averageCpc: (m.averageCpc ?? m.average_cpc ?? 0) / 1_000_000,
      ctr: m.ctr ?? 0,
      searchImpressionShare: m.searchImpressionShare ?? m.search_impression_share ?? null,
    };
  });
}

/**
 * Fetches campaign-level performance metrics for the last 7 days via REST.
 * Used by audit engine for performance drop detection and troubleshooting.
 *
 * @param {Object} restCtx - REST context { accessToken, developerToken, customerId, loginCustomerId }
 * @returns {Promise<Object[]>} Array of campaign performance objects
 */
async function getCampaignPerformance(restCtx) {
  const doQuery = restCtx._queryFn || queryViaRest;
  const rows = await doQuery(
    restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
    `SELECT campaign.id, campaign.name, campaign.status,
            campaign.advertising_channel_type,
            campaign.bidding_strategy_type,
            campaign.manual_cpc.enhanced_cpc_enabled,
            metrics.clicks, metrics.impressions, metrics.conversions,
            metrics.conversions_value, metrics.cost_micros, metrics.ctr,
            metrics.average_cpc, metrics.search_impression_share
     FROM campaign
     WHERE segments.date DURING LAST_7_DAYS
       AND campaign.status != 'REMOVED'`,
    restCtx.loginCustomerId
  );

  return rows.map(row => {
    const c = row.campaign || {};
    const m = row.metrics || {};
    return {
      campaignId: String(c.id ?? ''),
      campaignName: c.name ?? '',
      status: normalizeStatus(c.status),
      channelType: String(c.advertisingChannelType ?? c.advertising_channel_type ?? ''),
      biddingStrategy: String(c.biddingStrategyType ?? c.bidding_strategy_type ?? ''),
      ecpcEnabled: c.manualCpc?.enhancedCpcEnabled ?? c.manual_cpc?.enhanced_cpc_enabled ?? false,
      clicks: m.clicks ?? 0,
      impressions: m.impressions ?? 0,
      conversions: m.conversions ?? 0,
      conversionValue: m.conversionsValue ?? m.conversions_value ?? 0,
      cost: (m.costMicros ?? m.cost_micros ?? 0) / 1_000_000,
      ctr: m.ctr ?? 0,
      averageCpc: (m.averageCpc ?? m.average_cpc ?? 0) / 1_000_000,
      searchImpressionShare: m.searchImpressionShare ?? m.search_impression_share ?? null,
    };
  });
}

/**
 * Fetches keyword quality scores and bid estimates via REST.
 * Separate from getKeywordPerformance because these fields require
 * ad_group_criterion resource (not keyword_view with metrics).
 *
 * @param {Object} restCtx - REST context
 * @returns {Promise<Object[]>} Array of { keyword, matchType, campaignName, qualityScore, firstPageBid, approvalStatus }
 */
async function getKeywordDiagnostics(restCtx) {
  const doQuery = restCtx._queryFn || queryViaRest;
  try {
    const rows = await doQuery(
      restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
      `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
              ad_group_criterion.quality_info.quality_score,
              ad_group_criterion.position_estimates.first_page_cpc_micros,
              ad_group_criterion.approval_status,
              campaign.name
       FROM ad_group_criterion
       WHERE campaign.status = 'ENABLED'
         AND ad_group.status = 'ENABLED'
         AND ad_group_criterion.type = 'KEYWORD'
         AND ad_group_criterion.status = 'ENABLED'
         AND ad_group_criterion.negative = FALSE
       LIMIT 5000`,
      restCtx.loginCustomerId
    );

    return rows.map(row => {
      const kw = row.adGroupCriterion || row.ad_group_criterion || {};
      const keyword = kw.keyword || {};
      const qi = kw.qualityInfo ?? kw.quality_info ?? {};
      const pe = kw.positionEstimates ?? kw.position_estimates ?? {};
      return {
        keyword: keyword.text || '',
        matchType: String(keyword.matchType ?? keyword.match_type ?? ''),
        campaignName: row.campaign?.name ?? '',
        qualityScore: qi.qualityScore ?? qi.quality_score ?? null,
        firstPageBid: (pe.firstPageCpcMicros ?? pe.first_page_cpc_micros ?? null) != null
          ? (pe.firstPageCpcMicros ?? pe.first_page_cpc_micros) / 1_000_000 : null,
        approvalStatus: kw.approvalStatus ?? kw.approval_status ?? null,
      };
    });
  } catch (err) {
    console.warn('getKeywordDiagnostics failed (non-fatal):', err.message);
    return [];
  }
}

/**
 * Fetches campaign diagnostics for zero-spend/issue diagnosis via REST.
 * Returns ad group count, keyword count, and budget per campaign.
 *
 * @param {Object} restCtx - REST context
 * @returns {Promise<Object[]>} Array of { campaignId, campaignName, adGroupCount, keywordCount, budget }
 */
async function getCampaignDiagnostics(restCtx) {
  const doQuery = restCtx._queryFn || queryViaRest;

  // Query 1: Ad group counts per campaign
  const agRows = await doQuery(
    restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
    `SELECT campaign.id, campaign.name, ad_group.id, ad_group.status
     FROM ad_group
     WHERE campaign.status = 'ENABLED'
     LIMIT 5000`,
    restCtx.loginCustomerId
  );

  // Query 2: Keyword counts per campaign
  const kwRows = await doQuery(
    restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
    `SELECT campaign.id, ad_group_criterion.status, ad_group_criterion.approval_status
     FROM ad_group_criterion
     WHERE campaign.status = 'ENABLED'
       AND ad_group_criterion.type = 'KEYWORD'
       AND ad_group_criterion.negative = FALSE
     LIMIT 10000`,
    restCtx.loginCustomerId
  );

  // Query 3: Budget per campaign
  const budgetRows = await doQuery(
    restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
    `SELECT campaign.id, campaign_budget.amount_micros
     FROM campaign
     WHERE campaign.status = 'ENABLED'
     LIMIT 2000`,
    restCtx.loginCustomerId
  );

  // Aggregate
  const campaigns = new Map();
  for (const row of agRows) {
    const id = String(row.campaign?.id ?? '');
    if (!campaigns.has(id)) campaigns.set(id, { campaignId: id, campaignName: row.campaign?.name ?? '', enabledAdGroups: 0, totalAdGroups: 0, enabledKeywords: 0, disapprovedKeywords: 0, budget: 0 });
    const entry = campaigns.get(id);
    entry.totalAdGroups++;
    if (normalizeStatus(row.adGroup?.status ?? row.ad_group?.status) === 'ENABLED') entry.enabledAdGroups++;
  }
  for (const row of kwRows) {
    const id = String(row.campaign?.id ?? '');
    if (!campaigns.has(id)) continue;
    const entry = campaigns.get(id);
    const kwStatus = normalizeStatus(row.adGroupCriterion?.status ?? row.ad_group_criterion?.status);
    const approvalStatus = row.adGroupCriterion?.approvalStatus ?? row.ad_group_criterion?.approval_status ?? '';
    if (kwStatus === 'ENABLED') entry.enabledKeywords++;
    if (approvalStatus === 'DISAPPROVED') entry.disapprovedKeywords++;
  }
  for (const row of budgetRows) {
    const id = String(row.campaign?.id ?? '');
    if (!campaigns.has(id)) continue;
    const budget = row.campaignBudget ?? row.campaign_budget ?? {};
    campaigns.get(id).budget = (budget.amountMicros ?? budget.amount_micros ?? 0) / 1_000_000;
  }

  return Array.from(campaigns.values());
}

/**
 * Fetches RSA ad copy data (headlines, descriptions, final URLs, policy status) via REST.
 * Used by ad copy analyzer for quality checks and factory offer detection.
 *
 * @param {Object} restCtx - REST context { accessToken, developerToken, customerId, loginCustomerId }
 * @returns {Promise<Object[]>} Array of ad copy objects
 */
async function getAdCopy(restCtx) {
  const doQuery = restCtx._queryFn || queryViaRest;
  const rows = await doQuery(
    restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
    `SELECT ad_group_ad.ad.responsive_search_ad.headlines,
            ad_group_ad.ad.responsive_search_ad.descriptions,
            ad_group_ad.ad.final_urls, ad_group_ad.ad.id,
            ad_group_ad.policy_summary.approval_status,
            ad_group_ad.policy_summary.policy_topic_entries,
            ad_group_ad.status,
            ad_group.name, campaign.name
     FROM ad_group_ad
     WHERE ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
       AND campaign.status != 'REMOVED'
       AND ad_group_ad.status != 'REMOVED'
     LIMIT 2000`,
    restCtx.loginCustomerId
  );

  return rows.map(row => {
    const ad = row.adGroupAd || row.ad_group_ad || {};
    const adInner = ad.ad || {};
    const rsa = adInner.responsiveSearchAd || adInner.responsive_search_ad || {};
    const policy = ad.policySummary || ad.policy_summary || {};
    return {
      adId: String(adInner.id ?? ''),
      headlines: (rsa.headlines || []).map(h => ({
        text: h.text || '',
        pinnedField: h.pinnedField ?? h.pinned_field ?? null,
      })),
      descriptions: (rsa.descriptions || []).map(d => ({
        text: d.text || '',
        pinnedField: d.pinnedField ?? d.pinned_field ?? null,
      })),
      finalUrls: adInner.finalUrls || adInner.final_urls || [],
      approvalStatus: policy.approvalStatus ?? policy.approval_status ?? null,
      policyTopics: (policy.policyTopicEntries ?? policy.policy_topic_entries ?? []).map(e => ({
        topic: e.topic || '',
        type: e.type || '',
      })),
      status: normalizeStatus(ad.status),
      adGroupName: row.adGroup?.name ?? row.ad_group?.name ?? '',
      campaignName: row.campaign?.name ?? '',
    };
  });
}

/**
 * Fetches pending recommendations for an account via REST.
 * Used by recommendation dismisser to identify and dismiss unwanted suggestions.
 *
 * @param {Object} restCtx - REST context { accessToken, developerToken, customerId, loginCustomerId }
 * @returns {Promise<Object[]>} Array of recommendation objects
 */
async function getRecommendations(restCtx) {
  const doQuery = restCtx._queryFn || queryViaRest;
  try {
    const rows = await doQuery(
      restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
      `SELECT recommendation.resource_name, recommendation.type,
              recommendation.campaign, recommendation.ad_group
       FROM recommendation`,
      restCtx.loginCustomerId
    );

    return rows.map(row => {
      const rec = row.recommendation || {};
      return {
        resourceName: rec.resourceName ?? rec.resource_name ?? '',
        type: rec.type ?? '',
        campaignResourceName: rec.campaign ?? '',
        adGroupResourceName: rec.adGroup ?? rec.ad_group ?? null,
      };
    });
  } catch (err) {
    // Non-fatal: some accounts may not have recommendations access
    console.warn('getRecommendations failed (non-fatal):', err.message);
    return [];
  }
}

/**
 * Fetches ad schedule criteria for all campaigns via REST.
 * Used by audit engine to check schedule consistency across campaigns.
 *
 * @param {Object} restCtx - REST context { accessToken, developerToken, customerId, loginCustomerId }
 * @returns {Promise<Object[]>} Array of ad schedule objects grouped by campaign
 */
async function getAdSchedules(restCtx) {
  const doQuery = restCtx._queryFn || queryViaRest;
  try {
    const rows = await doQuery(
      restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
      `SELECT campaign_criterion.ad_schedule.day_of_week,
              campaign_criterion.ad_schedule.start_hour,
              campaign_criterion.ad_schedule.start_minute,
              campaign_criterion.ad_schedule.end_hour,
              campaign_criterion.ad_schedule.end_minute,
              campaign.name, campaign.id
       FROM campaign_criterion
       WHERE campaign_criterion.type = 'AD_SCHEDULE'
         AND campaign.status != 'REMOVED'
       ORDER BY campaign.name`,
      restCtx.loginCustomerId
    );

    return rows.map(row => {
      const cc = row.campaignCriterion || row.campaign_criterion || {};
      const sched = cc.adSchedule || cc.ad_schedule || {};
      return {
        campaignName: row.campaign?.name ?? '',
        campaignId: String(row.campaign?.id ?? ''),
        dayOfWeek: sched.dayOfWeek ?? sched.day_of_week ?? '',
        startHour: sched.startHour ?? sched.start_hour ?? 0,
        startMinute: sched.startMinute ?? sched.start_minute ?? 0,
        endHour: sched.endHour ?? sched.end_hour ?? 0,
        endMinute: sched.endMinute ?? sched.end_minute ?? 0,
      };
    });
  } catch (err) {
    // Non-fatal: some accounts may not have ad schedules
    console.warn('getAdSchedules failed (non-fatal):', err.message);
    return [];
  }
}

/**
 * Fetches campaign-level negative keywords via REST GAQL.
 * Used by deep scanner to detect negative keyword conflicts.
 *
 * @param {Object} restCtx - REST context { accessToken, developerToken, customerId, loginCustomerId }
 * @returns {Promise<Object[]>} Array of negative keyword objects
 */
async function getCampaignNegatives(restCtx) {
  const doQuery = restCtx._queryFn || queryViaRest;
  try {
    const rows = await doQuery(
      restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
      `SELECT campaign_criterion.keyword.text,
              campaign_criterion.keyword.match_type,
              campaign_criterion.negative,
              campaign.name, campaign.id
       FROM campaign_criterion
       WHERE campaign_criterion.type = 'KEYWORD'
         AND campaign_criterion.negative = TRUE
         AND campaign.status != 'REMOVED'`,
      restCtx.loginCustomerId
    );

    return rows.map(row => {
      const cc = row.campaignCriterion || row.campaign_criterion || {};
      const kw = cc.keyword || {};
      const c = row.campaign || {};
      return {
        keyword: kw.text || '',
        matchType: kw.matchType || kw.match_type || '',
        campaignName: c.name || '',
        campaignId: String(c.id || ''),
      };
    });
  } catch (err) {
    // Non-fatal: some accounts may not have campaign negatives
    console.warn('getCampaignNegatives failed (non-fatal):', err.message);
    return [];
  }
}

/**
 * Fetches search term report for the last 30 days via REST.
 * Returns actual user search queries that triggered ads with performance metrics.
 * Used by audit engine to detect irrelevant traffic and negative keyword opportunities.
 *
 * @param {Object} restCtx - REST context
 * @returns {Promise<Object[]>} Array of search term objects
 */
async function getSearchTermReport(restCtx) {
  const doQuery = restCtx._queryFn || queryViaRest;
  try {
    const rows = await doQuery(
      restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
      `SELECT search_term_view.search_term, search_term_view.status,
              campaign.name, campaign.id, ad_group.name,
              metrics.clicks, metrics.impressions, metrics.cost_micros,
              metrics.conversions, metrics.conversions_value
       FROM search_term_view
       WHERE segments.date DURING LAST_30_DAYS
         AND campaign.status = 'ENABLED'
         AND metrics.impressions > 0
       ORDER BY metrics.cost_micros DESC
       LIMIT 5000`,
      restCtx.loginCustomerId
    );

    return rows.map(row => {
      const stv = row.searchTermView || row.search_term_view || {};
      const m = row.metrics || {};
      return {
        searchTerm: stv.searchTerm ?? stv.search_term ?? '',
        status: stv.status ?? '',
        campaignName: row.campaign?.name ?? '',
        campaignId: String(row.campaign?.id ?? ''),
        adGroupName: row.adGroup?.name ?? row.ad_group?.name ?? '',
        clicks: m.clicks ?? 0,
        impressions: m.impressions ?? 0,
        cost: (m.costMicros ?? m.cost_micros ?? 0) / 1_000_000,
        conversions: m.conversions ?? 0,
        conversionValue: m.conversionsValue ?? m.conversions_value ?? 0,
      };
    });
  } catch (err) {
    console.warn('getSearchTermReport failed (non-fatal):', err.message);
    return [];
  }
}

/**
 * Counts active RSA ads per ad group via REST GAQL.
 * Used by deep scanner to detect ad groups missing RSAs.
 *
 * @param {Object} restCtx - REST context { accessToken, developerToken, customerId, loginCustomerId }
 * @returns {Promise<Object[]>} Array of ad group ad count objects
 */
async function getAdGroupAdCounts(restCtx) {
  const doQuery = restCtx._queryFn || queryViaRest;
  try {
    const rows = await doQuery(
      restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
      `SELECT ad_group.name, ad_group.id, campaign.name,
              ad_group_ad.ad.type, ad_group_ad.status,
              ad_group_ad.policy_summary.approval_status
       FROM ad_group_ad
       WHERE ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
         AND ad_group.status = 'ENABLED'
         AND campaign.status = 'ENABLED'`,
      restCtx.loginCustomerId
    );

    // Group by ad group, count approved+enabled RSAs
    const groups = {};
    for (const row of rows) {
      const ag = row.adGroup || row.ad_group || {};
      const c = row.campaign || {};
      const aga = row.adGroupAd || row.ad_group_ad || {};
      const key = `${c.name}||${ag.name}`;

      if (!groups[key]) {
        groups[key] = {
          adGroupName: ag.name || '',
          adGroupId: String(ag.id || ''),
          campaignName: c.name || '',
          activeRsaCount: 0,
          totalRsaCount: 0,
        };
      }

      groups[key].totalRsaCount++;
      const isActive = (aga.status === 'ENABLED') &&
                       (aga.policySummary?.approvalStatus || aga.policy_summary?.approval_status) !== 'DISAPPROVED';
      if (isActive) groups[key].activeRsaCount++;
    }

    return Object.values(groups);
  } catch (err) {
    // Non-fatal: some accounts may not have ad group ad data
    console.warn('getAdGroupAdCounts failed (non-fatal):', err.message);
    return [];
  }
}

/**
 * Fetches the most recent budget change event this month.
 *
 * @param {Object} restCtx - REST context
 * @returns {Promise<{changeDate: string|null}>} Date string (YYYY-MM-DD) or null
 */
async function getLastBudgetChange(restCtx) {
  const doQuery = restCtx._queryFn || queryViaRest;
  try {
    // Fetch recent budget changes (up to 5 in case the most recent is < 24h old)
    const rows = await doQuery(
      restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
      `SELECT change_event.change_date_time
       FROM change_event
       WHERE change_event.change_date_time DURING THIS_MONTH
         AND change_event.change_resource_type = 'CAMPAIGN_BUDGET'
       ORDER BY change_event.change_date_time DESC
       LIMIT 5`,
      restCtx.loginCustomerId
    );
    if (rows.length === 0) return { changeDate: null };

    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    // Find the most recent change that is at least 24 hours old.
    // Changes < 24h old don't have enough spend data to compute a meaningful daily avg.
    for (const row of rows) {
      const dt = row.changeEvent?.changeDateTime;
      if (!dt) continue;
      const changeTime = new Date(dt.replace(' ', 'T') + 'Z').getTime();
      if (now - changeTime >= TWENTY_FOUR_HOURS) {
        return { changeDate: dt.split(' ')[0] };
      }
    }

    // All changes are < 24h old — don't use any
    return { changeDate: null };
  } catch (err) {
    console.warn('getLastBudgetChange failed (non-fatal):', err.message);
    return { changeDate: null };
  }
}

/**
 * Fetches per-day, per-campaign spend breakdown for the current month.
 *
 * @param {Object} restCtx - REST context
 * @returns {Promise<Object[]>} Array of { date, campaignId, campaignName, spend }
 */
async function getDailySpendBreakdown(restCtx) {
  const doQuery = restCtx._queryFn || queryViaRest;
  const rows = await doQuery(
    restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
    `SELECT segments.date, campaign.id, campaign.name, metrics.cost_micros
     FROM campaign
     WHERE segments.date DURING THIS_MONTH AND campaign.status != 'REMOVED'`,
    restCtx.loginCustomerId
  );

  return rows.map(row => ({
    date: row.segments.date,
    campaignId: String(row.campaign.id),
    campaignName: row.campaign.name,
    spend: (row.metrics?.costMicros ?? 0) / 1_000_000,
  }));
}

/**
 * Fetches per-day total spend for the last 14 calendar days (crosses month boundaries).
 * Used by the all-accounts pacing overview for 7-day trend calculation.
 *
 * @param {Object} restCtx - REST context
 * @returns {Promise<Object[]>} Array of { date, spend } sorted by date ascending
 */
async function getDailySpendLast14Days(restCtx) {
  const doQuery = restCtx._queryFn || queryViaRest;
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const fourteenDaysAgo = new Date(today);
  fourteenDaysAgo.setDate(today.getDate() - 14);

  const fmt = d => d.toISOString().slice(0, 10);

  const rows = await doQuery(
    restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
    `SELECT segments.date, metrics.cost_micros
     FROM campaign
     WHERE segments.date BETWEEN '${fmt(fourteenDaysAgo)}' AND '${fmt(yesterday)}'
       AND campaign.status != 'REMOVED'`,
    restCtx.loginCustomerId
  );

  // Aggregate spend per day (rows are per-campaign)
  const byDate = {};
  for (const row of rows) {
    const date = row.segments.date;
    const spend = (row.metrics?.costMicros ?? 0) / 1_000_000;
    byDate[date] = (byDate[date] || 0) + spend;
  }

  return Object.entries(byDate)
    .map(([date, spend]) => ({ date, spend }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Fetches proximity targeting (radius) for specific campaigns.
 * Only called for IS-capped campaigns to provide geo expansion recommendations.
 *
 * @param {Object} restCtx - REST context
 * @param {string[]} campaignIds - Campaign IDs to query
 * @returns {Promise<Object[]>} Array of { campaignId, campaignName, city, state, radiusMiles, lat, lng }
 */
async function getCampaignProximityTargets(restCtx, campaignIds) {
  if (!campaignIds || campaignIds.length === 0) return [];
  const doQuery = restCtx._queryFn || queryViaRest;
  try {
    const idList = campaignIds.map(id => `'${id}'`).join(', ');
    const rows = await doQuery(
      restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
      `SELECT campaign.id, campaign.name,
              campaign_criterion.proximity.address.city_name,
              campaign_criterion.proximity.address.province_code,
              campaign_criterion.proximity.radius,
              campaign_criterion.proximity.radius_units,
              campaign_criterion.proximity.geo_point.latitude_in_micro_degrees,
              campaign_criterion.proximity.geo_point.longitude_in_micro_degrees
       FROM campaign_criterion
       WHERE campaign_criterion.type = 'PROXIMITY'
         AND campaign.id IN (${idList})
         AND campaign_criterion.negative = FALSE`,
      restCtx.loginCustomerId
    );

    return rows.map(row => {
      const prox = row.campaignCriterion?.proximity || {};
      const addr = prox.address || {};
      const geo = prox.geoPoint || {};
      const radiusVal = parseFloat(prox.radius) || 0;
      const units = prox.radiusUnits || 'MILES';
      // Convert km to miles if needed
      const radiusMiles = units === 'KILOMETERS' ? Math.round(radiusVal * 0.621371) : Math.round(radiusVal);
      return {
        campaignId: String(row.campaign.id),
        campaignName: row.campaign.name,
        city: addr.cityName || null,
        state: addr.provinceCode || null,
        radiusMiles,
        lat: geo.latitudeInMicroDegrees ? geo.latitudeInMicroDegrees / 1_000_000 : null,
        lng: geo.longitudeInMicroDegrees ? geo.longitudeInMicroDegrees / 1_000_000 : null,
      };
    });
  } catch (err) {
    console.warn('getCampaignProximityTargets failed (non-fatal):', err.message);
    return [];
  }
}

/**
 * Fetches geographic performance data for specific campaigns.
 * Shows which nearby locations have search volume / demand.
 *
 * @param {Object} restCtx - REST context
 * @param {string[]} campaignIds - Campaign IDs to query
 * @returns {Promise<Object[]>} Array of { campaignId, geoName, locationType, impressions, clicks, cost }
 */
async function getGeographicPerformance(restCtx, campaignIds) {
  if (!campaignIds || campaignIds.length === 0) return [];
  const doQuery = restCtx._queryFn || queryViaRest;
  try {
    const idList = campaignIds.map(id => `'${id}'`).join(', ');
    const rows = await doQuery(
      restCtx.accessToken, restCtx.developerToken, restCtx.customerId,
      `SELECT campaign.id,
              geographic_view.country_criterion_id,
              geographic_view.location_type,
              metrics.impressions, metrics.clicks, metrics.cost_micros
       FROM geographic_view
       WHERE campaign.id IN (${idList})
         AND segments.date DURING THIS_MONTH
         AND metrics.impressions > 0
       ORDER BY metrics.impressions DESC
       LIMIT 50`,
      restCtx.loginCustomerId
    );

    return rows.map(row => ({
      campaignId: String(row.campaign.id),
      geoTargetId: row.geographicView?.countryCriterionId || null,
      locationType: row.geographicView?.locationType || null,
      impressions: parseInt(row.metrics?.impressions) || 0,
      clicks: parseInt(row.metrics?.clicks) || 0,
      cost: (row.metrics?.costMicros ?? 0) / 1_000_000,
    }));
  } catch (err) {
    console.warn('getGeographicPerformance failed (non-fatal):', err.message);
    return [];
  }
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
  getDedicatedBudgets,
  getImpressionShare,
  getInventory,
  // Phase 9: Audit & Optimization queries
  getKeywordPerformance,
  getCampaignPerformance,
  getAdCopy,
  getRecommendations,
  getAdSchedules,
  // Phase 12: Deep Scanner queries
  getCampaignNegatives,
  getAdGroupAdCounts,
  // Pacing: post-change tracking
  getLastBudgetChange,
  getDailySpendBreakdown,
  getDailySpendLast14Days,
  // Pacing: geo expansion
  getCampaignProximityTargets,
  getGeographicPerformance,
  // Audit: diagnostics
  getKeywordDiagnostics,
  getCampaignDiagnostics,
  getSearchTermReport,
};
