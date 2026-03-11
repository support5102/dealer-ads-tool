/**
 * Claude Parser — builds prompts and calls the Anthropic API to parse Freshdesk tasks.
 *
 * Called by: routes/changes.js (POST /api/parse-task)
 * Calls: Anthropic REST API via axios
 *
 * Takes a plain-English Freshdesk task + account structure,
 * sends it to Claude, and returns a structured JSON change plan.
 */

const axios = require('axios');

/**
 * Builds the system prompt that tells Claude how to parse Google Ads tasks.
 *
 * @returns {string} System prompt for Claude
 */
function buildSystemPrompt() {
  return `You are a Google Ads expert for automotive dealerships.
Parse Freshdesk tasks and return structured change instructions.

Return ONLY valid JSON, no markdown, no explanation:

{
  "summary": "Plain English summary of all changes",
  "changes": [
    {
      "type": "pause_campaign|enable_campaign|update_budget|pause_ad_group|enable_ad_group|pause_keyword|enable_keyword|add_keyword|add_negative_keyword|exclude_radius|add_radius|update_bid",
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
    }
  ],
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

/**
 * Builds the user message containing the task and account context.
 *
 * @param {string} task - The Freshdesk task text
 * @param {Object} [structure] - Account structure from getAccountStructure()
 * @param {string} [accountName] - Display name of the selected account
 * @returns {string} Formatted user message for Claude
 */
function buildUserMessage(task, structure, accountName) {
  if (!structure) return task;

  const campList = structure.campaigns.map(c => {
    const ags = c.adGroups.map(ag =>
      `    "${ag.name}" | ${ag.status} | bid:$${ag.defaultBid} | ${ag.keywords.length} keywords`
    ).join('\n');
    return `  "${c.name}" | ${c.status} | $${c.budget}/day | ${c.type}\n${ags}`;
  }).join('\n');

  return `ACCOUNT: ${accountName}

CURRENT STRUCTURE:
${campList}

FRESHDESK TASK:
${task}`;
}

/**
 * Sends a task to Claude for parsing into structured changes.
 *
 * @param {Object} claudeConfig - Claude configuration from config.js
 * @param {string} claudeConfig.apiKey - Anthropic API key
 * @param {string} claudeConfig.model - Claude model ID
 * @param {string} task - The Freshdesk task text
 * @param {Object} [structure] - Account structure
 * @param {string} [accountName] - Account display name
 * @returns {Promise<Object>} Parsed change plan { summary, changes, warnings, affectedCampaigns }
 * @throws {Error} If Claude API call fails or response is not valid JSON
 */
async function parseTask(claudeConfig, task, structure, accountName) {
  const systemPrompt = buildSystemPrompt();
  const userMessage  = buildUserMessage(task, structure, accountName);

  const { data } = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model:      claudeConfig.model,
      max_tokens: 4096,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userMessage }],
    },
    {
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       claudeConfig.apiKey,
        'anthropic-version': '2023-06-01',
      },
    }
  );

  const raw   = data.content?.[0]?.text || '';
  const clean = raw.replace(/```json|```/gi, '').trim();

  try {
    return JSON.parse(clean);
  } catch (err) {
    throw new Error(
      'Claude returned invalid JSON. Raw response: ' + raw.substring(0, 200)
    );
  }
}

module.exports = { buildSystemPrompt, buildUserMessage, parseTask };
