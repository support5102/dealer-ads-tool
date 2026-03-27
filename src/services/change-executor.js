/**
 * Change Executor — applies individual change types against the Google Ads API.
 *
 * Called by: routes/changes.js (POST /api/apply-changes)
 * Calls: Google Ads API client (GAQL queries + mutations)
 *
 * Each change type (pause_campaign, add_keyword, etc.) is a separate handler
 * that looks up the target entity and executes the appropriate mutation.
 *
 * Supported types: pause_campaign, enable_campaign, update_budget,
 * pause_ad_group, enable_ad_group, pause_keyword, add_keyword,
 * add_negative_keyword, exclude_radius, add_radius, update_keyword_bid,
 * dismiss_recommendation
 */

const { sanitizeGaqlString, sanitizeGaqlNumber } = require('../utils/sanitize');
const { MATCH_TYPE_POLICY } = require('./strategy-rules');

/** Validate and normalize match type — only EXACT and PHRASE allowed. */
function validateMatchType(matchType, fallback = 'PHRASE') {
  if (!matchType) return fallback;
  const upper = matchType.toUpperCase();
  if (MATCH_TYPE_POLICY.forbidden.includes(upper)) {
    throw new Error(`Match type "${upper}" is forbidden by strategy rules. Use EXACT or PHRASE only.`);
  }
  if (!MATCH_TYPE_POLICY.allowed.includes(upper)) {
    throw new Error(`Invalid match type: "${matchType}". Allowed: ${MATCH_TYPE_POLICY.allowed.join(', ')}`);
  }
  return upper;
}

/**
 * Looks up a campaign by name and returns its ID.
 *
 * @param {Object} client - Google Ads API customer client
 * @param {string} name - Exact campaign name
 * @returns {Promise<string>} Campaign ID
 * @throws {Error} If campaign not found
 */
async function getCampaignId(client, name) {
  const safeName = sanitizeGaqlString(name);
  const rows = await client.query(
    `SELECT campaign.id, campaign.name FROM campaign ` +
    `WHERE campaign.name = '${safeName}' AND campaign.status != 'REMOVED' LIMIT 1`
  );
  if (!rows.length) throw new Error(`Campaign not found: "${name}"`);
  return String(rows[0].campaign.id);
}

/**
 * Looks up an ad group by name within a campaign and returns its ID.
 *
 * @param {Object} client - Google Ads API customer client
 * @param {string} campName - Exact campaign name
 * @param {string} agName - Exact ad group name
 * @returns {Promise<string>} Ad group ID
 * @throws {Error} If ad group not found
 */
async function getAdGroupId(client, campName, agName) {
  const safeCamp = sanitizeGaqlString(campName);
  const safeAg   = sanitizeGaqlString(agName);
  const rows = await client.query(
    `SELECT ad_group.id FROM ad_group ` +
    `WHERE campaign.name = '${safeCamp}' AND ad_group.name = '${safeAg}' ` +
    `AND ad_group.status != 'REMOVED' LIMIT 1`
  );
  if (!rows.length) throw new Error(`Ad group not found: "${agName}" in "${campName}"`);
  return String(rows[0].ad_group.id);
}

/**
 * Returns the customer ID from a Google Ads client instance.
 *
 * @param {Object} client - Google Ads API customer client
 * @returns {string} Customer ID
 */
function getCustomerId(client) {
  return client.credentials.customer_id;
}

/**
 * Applies a single change to a Google Ads account.
 *
 * @param {Object} client - Authenticated Google Ads API client
 * @param {Object} change - Structured change from Claude parser
 * @param {string} change.type - One of the 10 supported change types
 * @param {string} change.campaignName - Exact campaign name from account
 * @param {string} [change.adGroupName] - Exact ad group name (if applicable)
 * @param {Object} [change.details] - Type-specific details (budget, keyword, etc.)
 * @param {boolean} dryRun - If true, return description without executing
 * @returns {Promise<string>} Human-readable result message
 * @throws {Error} If campaign/ad group not found or API call fails
 */
async function applyChange(client, change, dryRun) {
  const { type, campaignName, adGroupName, details } = change;
  const customerId = getCustomerId(client);

  if (dryRun) {
    return `[DRY RUN] Would ${type} — ${campaignName || ''}${adGroupName ? ' > ' + adGroupName : ''}`;
  }

  switch (type) {
    case 'pause_campaign': {
      const id = await getCampaignId(client, campaignName);
      await client.campaigns.update([{
        resource_name: `customers/${customerId}/campaigns/${id}`,
        status: 'PAUSED',
      }]);
      return `Paused campaign: ${campaignName}`;
    }

    case 'enable_campaign': {
      const id = await getCampaignId(client, campaignName);
      await client.campaigns.update([{
        resource_name: `customers/${customerId}/campaigns/${id}`,
        status: 'ENABLED',
      }]);
      return `Enabled campaign: ${campaignName}`;
    }

    case 'update_budget': {
      const id = await getCampaignId(client, campaignName);
      const rows = await client.query(
        `SELECT campaign_budget.resource_name, campaign_budget.amount_micros ` +
        `FROM campaign WHERE campaign.id = ${sanitizeGaqlNumber(id)} LIMIT 1`
      );
      if (!rows.length) throw new Error(`Budget not found for campaign: "${campaignName}"`);
      const budgetResource = rows[0].campaign_budget.resource_name;
      const newAmountMicros = Math.round(parseFloat(details.newBudget) * 1_000_000);
      await client.campaignBudgets.update([{
        resource_name: budgetResource,
        amount_micros: newAmountMicros,
      }]);
      return `Updated budget for "${campaignName}" to $${details.newBudget}/day`;
    }

    case 'pause_ad_group': {
      await getCampaignId(client, campaignName); // validate campaign exists
      const agId = await getAdGroupId(client, campaignName, adGroupName);
      await client.adGroups.update([{
        resource_name: `customers/${customerId}/adGroups/${agId}`,
        status: 'PAUSED',
      }]);
      return `Paused ad group: ${adGroupName} in ${campaignName}`;
    }

    case 'enable_ad_group': {
      const agId = await getAdGroupId(client, campaignName, adGroupName);
      await client.adGroups.update([{
        resource_name: `customers/${customerId}/adGroups/${agId}`,
        status: 'ENABLED',
      }]);
      return `Enabled ad group: ${adGroupName} in ${campaignName}`;
    }

    case 'pause_keyword': {
      const safeCamp = sanitizeGaqlString(campaignName);
      const safeKw   = sanitizeGaqlString(details.keyword);
      const safeMatch = sanitizeGaqlString(details.matchType);
      const rows = await client.query(
        `SELECT ad_group_criterion.resource_name FROM ad_group_criterion ` +
        `WHERE campaign.name = '${safeCamp}' ` +
        `AND ad_group_criterion.keyword.text = '${safeKw}' ` +
        `AND ad_group_criterion.keyword.match_type = '${safeMatch}' LIMIT 1`
      );
      if (!rows.length) throw new Error(`Keyword not found: ${details.keyword}`);
      await client.adGroupCriteria.update([{
        resource_name: rows[0].ad_group_criterion.resource_name,
        status: 'PAUSED',
      }]);
      return `Paused keyword: [${details.matchType}] "${details.keyword}"`;
    }

    case 'add_negative_keyword': {
      const matchType = validateMatchType(details.matchType, 'EXACT');
      const campId = await getCampaignId(client, campaignName);
      await client.campaignCriteria.create([{
        campaign: `customers/${customerId}/campaigns/${campId}`,
        negative: true,
        keyword: {
          text:       details.keyword,
          match_type: matchType,
        },
      }]);
      return `Added negative keyword [${matchType}] "${details.keyword}" to ${campaignName}`;
    }

    case 'add_keyword': {
      const matchType = validateMatchType(details.matchType, 'PHRASE');
      const agId = await getAdGroupId(client, campaignName, adGroupName);
      await client.adGroupCriteria.create([{
        ad_group: `customers/${customerId}/adGroups/${agId}`,
        status:   'ENABLED',
        keyword: {
          text:       details.keyword,
          match_type: matchType,
        },
        ...(details.cpcBid ? { cpc_bid_micros: Math.round(parseFloat(details.cpcBid) * 1_000_000) } : {}),
      }]);
      return `Added keyword [${matchType}] "${details.keyword}" to ${adGroupName}`;
    }

    case 'exclude_radius': {
      const campId = await getCampaignId(client, campaignName);
      await client.campaignCriteria.create([{
        campaign: `customers/${customerId}/campaigns/${campId}`,
        negative: true,
        proximity: {
          geo_point: {
            longitude_in_micro_degrees: Math.round(details.lng * 1_000_000),
            latitude_in_micro_degrees:  Math.round(details.lat * 1_000_000),
          },
          radius:       details.radius,
          radius_units: details.units || 'MILES',
        },
      }]);
      return `Excluded ${details.radius}mi radius from ${campaignName}`;
    }

    case 'add_radius': {
      const campId = await getCampaignId(client, campaignName);
      await client.campaignCriteria.create([{
        campaign: `customers/${customerId}/campaigns/${campId}`,
        negative: false,
        proximity: {
          geo_point: {
            longitude_in_micro_degrees: Math.round(details.lng * 1_000_000),
            latitude_in_micro_degrees:  Math.round(details.lat * 1_000_000),
          },
          radius:       details.radius,
          radius_units: details.units || 'MILES',
        },
      }]);
      return `Added ${details.radius}mi radius targeting to ${campaignName}`;
    }

    case 'update_keyword_bid': {
      const safeCamp = sanitizeGaqlString(campaignName);
      const safeKw   = sanitizeGaqlString(details.keyword);
      const safeMatch = sanitizeGaqlString(details.matchType);
      const rows = await client.query(
        `SELECT ad_group_criterion.resource_name FROM ad_group_criterion ` +
        `WHERE campaign.name = '${safeCamp}' ` +
        `AND ad_group_criterion.keyword.text = '${safeKw}' ` +
        `AND ad_group_criterion.keyword.match_type = '${safeMatch}' LIMIT 1`
      );
      if (!rows.length) throw new Error(`Keyword not found: ${details.keyword}`);
      const newBidMicros = Math.round(parseFloat(details.newBid) * 1_000_000);
      await client.adGroupCriteria.update([{
        resource_name: rows[0].ad_group_criterion.resource_name,
        cpc_bid_micros: newBidMicros,
      }]);
      return `Updated bid for [${details.matchType}] "${details.keyword}" to $${details.newBid}`;
    }

    case 'dismiss_recommendation': {
      // Dismiss via REST API — resource name is the full recommendation path
      await client.recommendations.dismiss([{
        resource_name: details.resourceName,
      }]);
      return `Dismissed recommendation: ${details.resourceName}`;
    }

    default:
      throw new Error(`Unknown change type: "${type}". Supported: pause_campaign, enable_campaign, update_budget, pause_ad_group, enable_ad_group, pause_keyword, add_keyword, add_negative_keyword, exclude_radius, add_radius, update_keyword_bid, dismiss_recommendation`);
  }
}

module.exports = { applyChange, getCampaignId, getAdGroupId };
