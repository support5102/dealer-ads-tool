function buildClaudeSystemPrompt(multiAccount = false) {
  const changeSchema = `{
      "type": "pause_campaign|enable_campaign|update_budget|pause_ad_group|enable_ad_group|pause_keyword|enable_keyword|add_keyword|add_negative_keyword|exclude_radius|add_radius",
      "campaignName": "exact campaign name from account",
      "adGroupName": "exact ad group name if applicable",
      "details": {
        "newBudget": "number string e.g. 150.00",
        "keyword": "keyword text",
        "matchType": "EXACT|PHRASE|BROAD",
        "lat": 30.064250,
        "lng": -90.069620,
        "radius": 20,
        "units": "MILES",
        "cpcBid": "1.50"
      }
    }`;

  if (multiAccount) {
    return `You are a Google Ads expert for automotive dealerships.
Parse Freshdesk tasks that may reference MULTIPLE dealer accounts and return structured change instructions grouped by account.

Return ONLY valid JSON, no markdown, no explanation:

{
  "summary": "Plain English summary of all changes across all accounts",
  "accountChanges": [
    {
      "accountId": "the customer ID",
      "accountName": "the account name",
      "changes": [${changeSchema}],
      "warnings": ["anything to verify for this account"]
    }
  ],
  "globalWarnings": ["anything that applies across all accounts"]
}

Rules:
- Use exact campaign/ad group names from the account structures provided
- Group changes by account — each account gets its own entry in accountChanges
- If a task says "all accounts", create changes for every account provided
- "all campaigns" = one change entry per campaign in that account
- Budget values: numbers only, no $ sign
- Match types: EXACT, PHRASE, or BROAD (uppercase)
- Radius: always include lat, lng, radius, and units
- If a campaign is not found in an account, add a warning for that account`;
  }

  return `You are a Google Ads expert for automotive dealerships.
Parse Freshdesk tasks and return structured change instructions.

Return ONLY valid JSON, no markdown, no explanation:

{
  "summary": "Plain English summary of all changes",
  "changes": [${changeSchema}],
  "warnings": ["anything to verify before applying"],
  "affectedCampaigns": ["list of campaign names being changed"]
}

Rules:
- Use exact campaign/ad group names from the account structure provided
- "all campaigns" = one change entry per campaign
- Budget values: numbers only, no $ sign
- Match types: EXACT, PHRASE, or BROAD (uppercase)
- Radius: always include lat, lng, radius, and units
- If a campaign is not found in the account, add a warning`;
}

function buildUserMessage(task, structure, accountName) {
  if (!structure) return task;

  const campList = structure.campaigns.map(c => {
    const ags = c.adGroups.map(ag => {
      const kwSample = ag.keywords.slice(0, 20).map(k => k.text).join(', ');
      const kwExtra = ag.keywords.length > 20 ? ` (+${ag.keywords.length - 20} more)` : '';
      return `    📁 "${ag.name}" | ${ag.status} | bid:$${ag.defaultBid} | ${ag.keywords.length} keywords: ${kwSample}${kwExtra}`;
    }).join('\n');
    const budgetStr = c.budget !== '?' ? `$${c.budget}/day` : 'budget unknown';
    const metricsStr = c.metrics ? ` | 30d: ${c.metrics.impressions} imp, ${c.metrics.clicks} clk, $${c.metrics.cost} spend` : '';
    return `  📢 "${c.name}" | ${c.status} | ${budgetStr} | ${c.type}${metricsStr}\n${ags}`;
  }).join('\n');

  return `ACCOUNT: ${accountName}

CURRENT STRUCTURE:
${campList}

FRESHDESK TASK:
${task}`;
}

module.exports = { buildClaudeSystemPrompt, buildUserMessage };
