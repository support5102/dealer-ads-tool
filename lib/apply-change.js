const VALID_MATCH_TYPES = ['EXACT', 'PHRASE'];

function gaqlEscape(str) {
  if (!str || typeof str !== 'string') throw new Error('Empty or invalid GAQL value');
  if (str.length > 500) throw new Error('GAQL value too long (max 500 chars)');
  return str.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

async function applyChange(client, change, dryRun) {
  const { type, campaignName, adGroupName, details } = change;

  // Validate match type if present
  if (details?.matchType && !VALID_MATCH_TYPES.includes(details.matchType)) {
    throw new Error(`Invalid match type: ${details.matchType}. Must be EXACT or PHRASE only (BROAD is forbidden)`);
  }

  if (dryRun) {
    return `[DRY RUN] Would ${type} — ${campaignName || ''}${adGroupName ? ' > ' + adGroupName : ''}`;
  }

  // Look up campaign resource name
  const getCampaignId = async (name) => {
    const rows = await client.query(`
      SELECT campaign.id, campaign.name
      FROM campaign
      WHERE campaign.name = '${gaqlEscape(name)}'
        AND campaign.status != 'REMOVED'
      LIMIT 1
    `);
    if (!rows.length) throw new Error(`Campaign not found: "${name}"`);
    return String(rows[0].campaign.id);
  };

  const getAdGroupId = async (campName, agName) => {
    const rows = await client.query(`
      SELECT ad_group.id
      FROM ad_group
      WHERE campaign.name = '${gaqlEscape(campName)}'
        AND ad_group.name = '${gaqlEscape(agName)}'
        AND ad_group.status != 'REMOVED'
      LIMIT 1
    `);
    if (!rows.length) throw new Error(`Ad group not found: "${agName}" in "${campName}"`);
    return String(rows[0].ad_group.id);
  };

  switch (type) {

    case 'pause_campaign': {
      const id = await getCampaignId(campaignName);
      await client.campaigns.update([{ resource_name: `customers/${client.credentials.customer_id}/campaigns/${id}`, status: 'PAUSED' }]);
      return `Paused campaign: ${campaignName}`;
    }

    case 'enable_campaign': {
      const id = await getCampaignId(campaignName);
      await client.campaigns.update([{ resource_name: `customers/${client.credentials.customer_id}/campaigns/${id}`, status: 'ENABLED' }]);
      return `Enabled campaign: ${campaignName}`;
    }

    case 'update_budget': {
      const id = await getCampaignId(campaignName);
      const rows = await client.query(`
        SELECT campaign_budget.resource_name, campaign_budget.amount_micros
        FROM campaign
        WHERE campaign.id = ${id}
        LIMIT 1
      `);
      if (!rows.length) throw new Error('Budget not found');
      const budgetResource = rows[0].campaign_budget.resource_name;
      const newAmountMicros = Math.round(parseFloat(details.newBudget) * 1_000_000);
      await client.campaignBudgets.update([{
        resource_name:  budgetResource,
        amount_micros:  newAmountMicros,
      }]);
      return `Updated budget for "${campaignName}" to $${details.newBudget}/day`;
    }

    case 'pause_ad_group': {
      const agId = await getAdGroupId(campaignName, adGroupName);
      await client.adGroups.update([{
        resource_name: `customers/${client.credentials.customer_id}/adGroups/${agId}`,
        status: 'PAUSED'
      }]);
      return `Paused ad group: ${adGroupName} in ${campaignName}`;
    }

    case 'enable_ad_group': {
      const agId = await getAdGroupId(campaignName, adGroupName);
      await client.adGroups.update([{
        resource_name: `customers/${client.credentials.customer_id}/adGroups/${agId}`,
        status: 'ENABLED'
      }]);
      return `Enabled ad group: ${adGroupName} in ${campaignName}`;
    }

    case 'pause_keyword': {
      const rows = await client.query(`
        SELECT ad_group_criterion.resource_name
        FROM ad_group_criterion
        WHERE campaign.name = '${gaqlEscape(campaignName)}'
          AND ad_group_criterion.keyword.text = '${gaqlEscape(details.keyword)}'
          AND ad_group_criterion.keyword.match_type = '${details.matchType}'
        LIMIT 1
      `);
      if (!rows.length) throw new Error(`Keyword not found: ${details.keyword}`);
      await client.adGroupCriteria.update([{
        resource_name: rows[0].ad_group_criterion.resource_name,
        status: 'PAUSED'
      }]);
      return `Paused keyword: [${details.matchType}] "${details.keyword}"`;
    }

    case 'enable_keyword': {
      const rows = await client.query(`
        SELECT ad_group_criterion.resource_name
        FROM ad_group_criterion
        WHERE campaign.name = '${gaqlEscape(campaignName)}'
          AND ad_group_criterion.keyword.text = '${gaqlEscape(details.keyword)}'
          AND ad_group_criterion.keyword.match_type = '${details.matchType}'
        LIMIT 1
      `);
      if (!rows.length) throw new Error(`Keyword not found: ${details.keyword}`);
      await client.adGroupCriteria.update([{
        resource_name: rows[0].ad_group_criterion.resource_name,
        status: 'ENABLED'
      }]);
      return `Enabled keyword: [${details.matchType}] "${details.keyword}"`;
    }

    case 'add_negative_keyword': {
      const campId = await getCampaignId(campaignName);
      await client.campaignCriteria.create([{
        campaign:  `customers/${client.credentials.customer_id}/campaigns/${campId}`,
        negative:  true,
        keyword: {
          text:       details.keyword,
          match_type: details.matchType || 'EXACT',
        }
      }]);
      return `Added negative keyword [${details.matchType}] "${details.keyword}" to ${campaignName}`;
    }

    case 'add_keyword': {
      const agId = await getAdGroupId(campaignName, adGroupName);
      const mt = details.matchType || 'PHRASE';
      await client.adGroupCriteria.create([{
        ad_group:  `customers/${client.credentials.customer_id}/adGroups/${agId}`,
        status:    'ENABLED',
        keyword: {
          text:       details.keyword,
          match_type: mt,
        },
        ...(details.cpcBid ? { cpc_bid_micros: Math.round(parseFloat(details.cpcBid) * 1_000_000) } : {}),
      }]);
      return `Added keyword [${mt}] "${details.keyword}" to ${adGroupName}`;
    }

    case 'exclude_radius': {
      const campId = await getCampaignId(campaignName);
      await client.campaignCriteria.create([{
        campaign: `customers/${client.credentials.customer_id}/campaigns/${campId}`,
        negative: true,
        proximity: {
          geo_point: { longitude_in_micro_degrees: Math.round(details.lng * 1_000_000), latitude_in_micro_degrees: Math.round(details.lat * 1_000_000) },
          radius:      details.radius,
          radius_units: details.units || 'MILES',
        }
      }]);
      return `Excluded ${details.radius}mi radius from ${campaignName}`;
    }

    case 'add_radius': {
      const campId = await getCampaignId(campaignName);
      await client.campaignCriteria.create([{
        campaign: `customers/${client.credentials.customer_id}/campaigns/${campId}`,
        negative: false,
        proximity: {
          geo_point: { longitude_in_micro_degrees: Math.round(details.lng * 1_000_000), latitude_in_micro_degrees: Math.round(details.lat * 1_000_000) },
          radius:      details.radius,
          radius_units: details.units || 'MILES',
        }
      }]);
      return `Added ${details.radius}mi radius targeting to ${campaignName}`;
    }

    default:
      throw new Error(`Unknown change type: ${type}`);
  }
}

module.exports = { applyChange, gaqlEscape, VALID_MATCH_TYPES };
