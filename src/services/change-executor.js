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
 * dismiss_recommendation, create_shared_budget, assign_campaign_budget
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
 * Looks up a shared budget by name and returns its resource_name.
 *
 * @param {Object} client - Google Ads API customer client
 * @param {string} budgetName - Exact shared budget name
 * @returns {Promise<string>} Budget resource_name
 * @throws {Error} If shared budget not found
 */
async function getSharedBudgetResourceName(client, budgetName) {
  const safeName = sanitizeGaqlString(budgetName);
  const rows = await client.query(
    `SELECT campaign_budget.resource_name, campaign_budget.name ` +
    `FROM campaign_budget ` +
    `WHERE campaign_budget.explicitly_shared = TRUE ` +
    `AND campaign_budget.name = '${safeName}' LIMIT 1`
  );
  if (!rows.length) throw new Error(`Shared budget not found: "${budgetName}"`);
  return rows[0].campaign_budget.resource_name;
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
    if (type === 'create_shared_budget') {
      const camps = details?.campaignNames?.length ? ` and assign ${details.campaignNames.length} campaign(s)` : '';
      return `[DRY RUN] Would create shared budget "${details?.budgetName}" at $${details?.dailyAmount}/day${camps}`;
    }
    if (type === 'assign_campaign_budget') {
      return `[DRY RUN] Would assign "${campaignName}" to shared budget "${details?.budgetName}"`;
    }
    if (type === 'create_campaign') {
      return `[DRY RUN] Would create campaign "${campaignName}" (budget: ${details?.budgetName || '$' + (details?.budgetAmount || 20) + '/day'})`;
    }
    if (type === 'create_ad_group') {
      return `[DRY RUN] Would create ad group "${adGroupName}" in "${campaignName}" (CPC: $${details?.defaultCpc || 9})`;
    }
    if (type === 'create_rsa') {
      return `[DRY RUN] Would create RSA in "${adGroupName}" with ${details?.headlines?.length || 0} headlines → ${details?.finalUrl || ''}`;
    }
    if (type === 'set_location_targeting') {
      return `[DRY RUN] Would set ${details?.locations?.length || 0} location target(s) on "${campaignName}"`;
    }
    if (type === 'set_ad_schedule') {
      return `[DRY RUN] Would set ad schedule (${details?.schedule?.length || 0} days) on "${campaignName}"`;
    }
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

    case 'enable_keyword': {
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
        status: 'ENABLED',
      }]);
      return `Enabled keyword: [${details.matchType}] "${details.keyword}"`;
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

    case 'create_shared_budget': {
      const amountMicros = Math.round(parseFloat(details.dailyAmount) * 1_000_000);
      const result = await client.campaignBudgets.create([{
        name: details.budgetName,
        amount_micros: amountMicros,
        explicitly_shared: true,
      }]);
      // Extract the new budget's resource_name from create result
      const budgetResource = result?.results?.[0]?.resource_name || result?.[0]?.resource_name;
      if (!budgetResource) throw new Error('Budget created but resource_name not returned');

      const messages = [`Created shared budget "${details.budgetName}" at $${details.dailyAmount}/day`];

      // Optionally assign campaigns to the new budget
      if (details.campaignNames && details.campaignNames.length > 0) {
        for (const campName of details.campaignNames) {
          try {
            const campId = await getCampaignId(client, campName);
            await client.campaigns.update([{
              resource_name: `customers/${customerId}/campaigns/${campId}`,
              campaign_budget: budgetResource,
            }]);
            messages.push(`  ✓ Assigned "${campName}"`);
          } catch (err) {
            messages.push(`  ✗ Failed to assign "${campName}": ${err.message}`);
          }
        }
      }
      return messages.join('\n');
    }

    case 'assign_campaign_budget': {
      const budgetResource = await getSharedBudgetResourceName(client, details.budgetName);
      const campId = await getCampaignId(client, campaignName);
      await client.campaigns.update([{
        resource_name: `customers/${customerId}/campaigns/${campId}`,
        campaign_budget: budgetResource,
      }]);
      return `Assigned "${campaignName}" to shared budget "${details.budgetName}"`;
    }

    // ── Ad copy mutations ──

    case 'pause_ad': {
      if (!details.adId) throw new Error('pause_ad requires details.adId');
      const agId = await getAdGroupId(client, campaignName, adGroupName);
      await client.adGroupAds.update([{
        resource_name: `customers/${customerId}/adGroupAds/${agId}~${details.adId}`,
        status: 'PAUSED',
      }]);
      return `Paused ad ${details.adId} in ${adGroupName}`;
    }

    case 'enable_ad': {
      if (!details.adId) throw new Error('enable_ad requires details.adId');
      const agId = await getAdGroupId(client, campaignName, adGroupName);
      await client.adGroupAds.update([{
        resource_name: `customers/${customerId}/adGroupAds/${agId}~${details.adId}`,
        status: 'ENABLED',
      }]);
      return `Enabled ad ${details.adId} in ${adGroupName}`;
    }

    case 'update_rsa': {
      // Google Ads RSAs are immutable — must remove old + create new
      if (!details.adId) throw new Error('update_rsa requires details.adId');
      if (!details.headlines || !details.descriptions) throw new Error('update_rsa requires details.headlines and details.descriptions');

      // Use adGroupId directly if available (avoids name mismatch), fall back to name lookup
      const agId = details.adGroupId || await getAdGroupId(client, campaignName, adGroupName);

      // Build headline and description assets
      const headlines = details.headlines.map(h => ({
        text: h.text,
        ...(h.pinnedField ? { pinned_field: h.pinnedField } : {}),
      }));
      const descriptions = details.descriptions.map(d => ({
        text: d.text,
        ...(d.pinnedField ? { pinned_field: d.pinnedField } : {}),
      }));
      const finalUrls = details.finalUrls || [];

      const adResource = `customers/${customerId}/adGroupAds/${agId}~${details.adId}`;

      // Step 1: Pause old ad first (safety — if create fails, ad is paused, not deleted)
      await client.adGroupAds.update([{ resource_name: adResource, status: 'PAUSED' }]);

      // Step 2: Create new ad with updated copy
      try {
        await client.adGroupAds.create([{
          ad_group: `customers/${customerId}/adGroups/${agId}`,
          status: 'ENABLED',
          ad: {
            final_urls: finalUrls,
            responsive_search_ad: { headlines, descriptions },
          },
        }]);
      } catch (createErr) {
        // Re-enable old ad if creation failed
        await client.adGroupAds.update([{ resource_name: adResource, status: 'ENABLED' }]).catch(() => {});
        throw new Error(`Failed to create new RSA (old ad re-enabled): ${createErr.message}`);
      }

      // Step 3: Remove old ad only after successful creation
      await client.adGroupAds.remove([adResource]);
      return `Updated RSA in ${adGroupName}: ${headlines.length} headlines, ${descriptions.length} descriptions`;
    }

    // ── Full account creation mutations ──

    case 'create_campaign': {
      // details: { budgetName, budgetAmount, settings: { networks, biddingStrategy, ... } }
      const d = details || {};
      const settings = d.settings || {};

      // Create or find the budget
      let budgetResource;
      if (d.budgetName) {
        try {
          budgetResource = await getSharedBudgetResourceName(client, d.budgetName);
        } catch {
          // Budget doesn't exist yet — create it
          const amountMicros = Math.round(parseFloat(d.budgetAmount || 20) * 1_000_000);
          const budgetResult = await client.campaignBudgets.create([{
            name: d.budgetName,
            amount_micros: amountMicros,
            explicitly_shared: true,
          }]);
          budgetResource = budgetResult?.results?.[0]?.resource_name || budgetResult?.[0]?.resource_name;
        }
      } else {
        // Individual budget
        const amountMicros = Math.round(parseFloat(d.budgetAmount || 20) * 1_000_000);
        const budgetResult = await client.campaignBudgets.create([{
          name: campaignName,
          amount_micros: amountMicros,
          explicitly_shared: false,
        }]);
        budgetResource = budgetResult?.results?.[0]?.resource_name || budgetResult?.[0]?.resource_name;
      }

      const campResult = await client.campaigns.create([{
        name: campaignName,
        status: settings.status || 'ENABLED',
        advertising_channel_type: 'SEARCH',
        campaign_budget: budgetResource,
        manual_cpc: { enhanced_cpc_enabled: false },
        network_settings: {
          target_google_search: true,
          target_search_network: true,
          target_content_network: false,
        },
        geo_target_type_setting: {
          positive_geo_target_type: 'PRESENCE',
          negative_geo_target_type: 'PRESENCE',
        },
        start_date: settings.startDate || new Date().toISOString().slice(0, 10).replace(/-/g, ''),
      }]);
      const campResource = campResult?.results?.[0]?.resource_name || campResult?.[0]?.resource_name;
      return `Created campaign: ${campaignName}` + (campResource ? ` (${campResource})` : '');
    }

    case 'create_ad_group': {
      const d = details || {};
      const campId = await getCampaignId(client, campaignName);
      const cpcMicros = Math.round(parseFloat(d.defaultCpc || 9) * 1_000_000);
      await client.adGroups.create([{
        campaign: `customers/${customerId}/campaigns/${campId}`,
        name: adGroupName,
        status: 'ENABLED',
        type: 'SEARCH_STANDARD',
        cpc_bid_micros: cpcMicros,
      }]);
      return `Created ad group: ${adGroupName} in ${campaignName} (CPC: $${d.defaultCpc || 9})`;
    }

    case 'create_rsa': {
      const d = details || {};
      if (!d.headlines || !d.descriptions || !d.finalUrl) {
        throw new Error('create_rsa requires details.headlines, details.descriptions, and details.finalUrl');
      }
      const agId = await getAdGroupId(client, campaignName, adGroupName);
      // All headlines/descriptions UNPINNED (no pinned_field)
      const headlines = d.headlines.map(h => ({ text: typeof h === 'string' ? h : h.text }));
      const descriptions = d.descriptions.map(desc => ({ text: typeof desc === 'string' ? desc : desc.text }));
      await client.adGroupAds.create([{
        ad_group: `customers/${customerId}/adGroups/${agId}`,
        status: 'ENABLED',
        ad: {
          final_urls: [d.finalUrl],
          responsive_search_ad: { headlines, descriptions },
          ...(d.path1 || d.path2 ? { path1: d.path1 || '', path2: d.path2 || '' } : {}),
        },
      }]);
      return `Created RSA in ${adGroupName}: ${headlines.length} headlines, ${descriptions.length} descriptions`;
    }

    case 'set_location_targeting': {
      const d = details || {};
      if (!d.locations || !d.locations.length) throw new Error('set_location_targeting requires details.locations[]');
      const campId = await getCampaignId(client, campaignName);
      const criteria = d.locations.map(loc => ({
        campaign: `customers/${customerId}/campaigns/${campId}`,
        negative: !!loc.negative,
        proximity: {
          geo_point: {
            longitude_in_micro_degrees: Math.round(loc.lng * 1_000_000),
            latitude_in_micro_degrees:  Math.round(loc.lat * 1_000_000),
          },
          radius:       loc.radius,
          radius_units: loc.units || 'MILES',
        },
      }));
      await client.campaignCriteria.create(criteria);
      return `Set ${d.locations.length} location target(s) on ${campaignName}`;
    }

    case 'set_ad_schedule': {
      const d = details || {};
      if (!d.schedule || !d.schedule.length) throw new Error('set_ad_schedule requires details.schedule[]');
      const campId = await getCampaignId(client, campaignName);
      // schedule: [{ dayOfWeek, startHour, startMinute, endHour, endMinute }]
      const criteria = d.schedule.map(s => ({
        campaign: `customers/${customerId}/campaigns/${campId}`,
        ad_schedule: {
          day_of_week: s.dayOfWeek,
          start_hour: s.startHour,
          start_minute: s.startMinute === 30 ? 'THIRTY' : 'ZERO',
          end_hour: s.endHour,
          end_minute: s.endMinute === 30 ? 'THIRTY' : 'ZERO',
        },
      }));
      await client.campaignCriteria.create(criteria);
      return `Set ad schedule on ${campaignName}: ${d.schedule.length} day(s)`;
    }

    default:
      throw new Error(`Unknown change type: "${type}". Supported: pause_campaign, enable_campaign, update_budget, pause_ad_group, enable_ad_group, pause_keyword, enable_keyword, add_keyword, add_negative_keyword, exclude_radius, add_radius, update_keyword_bid, dismiss_recommendation, create_shared_budget, assign_campaign_budget, pause_ad, enable_ad, update_rsa, create_campaign, create_ad_group, create_rsa, set_location_targeting, set_ad_schedule`);
  }
}

module.exports = { applyChange, getCampaignId, getAdGroupId, getSharedBudgetResourceName };
