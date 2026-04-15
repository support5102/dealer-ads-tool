/**
 * Command Center Engine — core orchestrator for the combined Task Manager + Campaign Builder.
 *
 * Called by: routes/command-center.js
 * Calls: Anthropic Claude API, account-builder.js, change-executor.js, freshdesk.js
 *
 * Manages multi-turn conversations with Claude, detects input type (URL, ticket, task, audit),
 * generates structured plans, asks clarifying questions when unsure, and executes approved changes.
 */

const axios = require('axios');
const {
  AD_SCHEDULE_TEMPLATE, NAMING_PATTERNS, MATCH_TYPE_POLICY, DEFAULT_CPC,
  COMPETING_MAKES, ALL_KNOWN_MAKES, UNIVERSAL_NEGATIVES, URL_PATTERNS,
  MAKE_COMBOS, getCompetingMakes,
} = require('./strategy-rules');

// ─────────────────────────────────────────────────────────────
// Input type detection
// ─────────────────────────────────────────────────────────────

/**
 * Detects what kind of input the user provided.
 * @param {string} message - User's input text
 * @returns {'build_account'|'freshdesk_task'|'audit'|'plain_task'}
 */
function detectInputType(message) {
  if (!message) return 'plain_task';
  const lower = message.toLowerCase().trim();

  // Audit request
  if (/\baudit\b/i.test(lower) && /\b(account|campaigns?|this)\b/i.test(lower)) return 'audit';
  if (/\bwhat can (be )?(improved|fixed|better)\b/i.test(lower)) return 'audit';

  // URL paste → build account
  if (/https?:\/\//i.test(message) && /\.(com|net|org|auto|dealer|cars)/i.test(message)) return 'build_account';

  // Freshdesk ticket pattern
  if (/ticket\s*#?\d{4,}/i.test(lower)) return 'freshdesk_task';
  if (/subject:\s*.+/im.test(message) && /requester|description|priority/im.test(message)) return 'freshdesk_task';

  return 'plain_task';
}

// ─────────────────────────────────────────────────────────────
// System prompt builder
// ─────────────────────────────────────────────────────────────

const STRATEGY_RULES_BLOCK = `
## SAVVY DEALER GOOGLE ADS STRATEGY RULES (MANDATORY)

### Campaign Naming
- Model campaigns: "{Dealer} - New - {Make} - {Model}" or "{Dealer} - Used - {Model}"
- Non-model: "{Dealer} - {Category}" (e.g., Brand, General Terms, Competitor, Regional)
- PMax: "PMax: VLA Ads - {Segment}"
- Ad Groups: "SD: {Keyword Theme}" (model), "SDG: {Theme}" (general), "SDB: {Dealer} Brand" (brand)

### Keywords — STRICT RULES
- ONLY Exact + Phrase match. NEVER Broad match.
- 2 keywords per ad group (1 Exact + 1 Phrase of same term)
- Ad-group-level negatives for traffic sculpting (sale vs lease vs generic)
- Campaign-level negatives for competing makes
- Universal negatives via shared list

### Bidding — STRICT RULES
- ALL Search campaigns: Manual CPC, Enhanced CPC DISABLED
- Brand campaign ad groups: Max CPC $3.00
- ALL other keyword campaigns ad groups: Max CPC $9.00
- Keywords NEVER get keyword-level CPC overrides — always inherit from ad group
- PMax: Maximize Conversions, NO target CPA

### Ad Copy — STRICT RULES
- 15 headlines per RSA (MAX 30 chars each — count EVERY character)
- 4 descriptions per RSA (MAX 90 chars each)
- ALL headline positions MUST be unpinned ("-"). NO PINNING EVER.
- Headlines 1-5: model-specific, 6-10: value/offer, 11-15: dealer/location
- NEVER ENABLE AUTOMATICALLY CREATED ASSETS on any campaign:
  AI Max=Disabled, Text customization=Disabled, Final URL expansion=Disabled,
  Image enhancement=Disabled, Image generation=Disabled, Landing page images=Disabled,
  Video enhancement=Disabled

### Brand Campaign — STRICT RULES
- Keywords are ONLY the dealership name variations. NEVER include OEM make names.
- Example: "Thayer CDJR" → keywords: [Thayer CDJR], "Thayer CDJR" ONLY
- NEVER: [Dodge], [Chrysler], [Ram], [Jeep] as brand keywords
- Negative out: all nearby competing dealerships, all sibling dealer group names,
  all makes the dealer doesn't sell new

### Targeting — STRICT RULES
- Location targeting: "Location of presence" ONLY (never "presence or interest")
- Exclusion method: "Location of presence"
- Radius: 15-25mi around dealership
- Language: English only
- SAME targeting across all campaigns in the account

### Ad Scheduling
- Monday-Friday: 8:30 AM - 7:00 PM
- Saturday: 8:30 AM - 8:30 PM
- Sunday: OFF
- Same schedule on ALL campaigns

### Negative Keyword Strategy
- Cross-campaign sculpting: every campaign negatives out other campaigns' keywords
- Cross-make negatives at campaign level for all non-dealer makes
- Any make the dealer ISN'T selling new → negatived on all new campaigns
- Group dealer sibling names → negatived on brand campaign
- Nearby competing dealerships → negatived on brand campaign
- "New" negatived on used campaigns, "Used" negatived on new campaigns

### Budget
- Shared budgets for related campaign groups
- Individual budgets for PMax
- Max 5 enabled campaigns per shared budget
`;

/**
 * Builds the Claude system prompt based on the conversation mode.
 * @param {'build_account'|'freshdesk_task'|'audit'|'plain_task'} mode
 * @param {Object} [context] - Dealer context, account structure, etc.
 * @returns {string}
 */
function buildSystemPrompt(mode, context = {}) {
  const base = `You are a Google Ads expert for automotive dealerships, working for SavvyDealer agency.
You help manage dealer PPC accounts with precision and accuracy.

RESPONSE FORMAT: Always return ONLY valid JSON matching this schema:
{
  "status": "need_info" | "plan_ready" | "clarifying",
  "message": "Human-readable message to show the user (markdown allowed)",
  "questions": [],
  "plan": null,
  "confidence": 0.0-1.0
}

When status = "need_info": Set questions array with things you need to know.
When status = "plan_ready": Set plan object with summary + changes array (see CHANGE SCHEMA below).
When status = "clarifying": You're responding to a follow-up, asking for more detail.

WHEN UNSURE (confidence < 0.8): ALWAYS ask questions before generating a plan.

### CHANGE SCHEMA (MANDATORY for plan.changes array)
Each change in plan.changes MUST use one of these exact types with the exact fields shown:

CREATE A CAMPAIGN:
{"type":"create_campaign","campaignName":"Dealer - Campaign Name","budgetName":"Main","budgetAmount":20,"status":"Enabled"}

CREATE AN AD GROUP:
{"type":"create_ad_group","campaignName":"Dealer - Campaign Name","adGroupName":"SD: Ad Group Name","defaultCpc":9}

ADD A KEYWORD (one entry per keyword per match type):
{"type":"add_keyword","campaignName":"Dealer - Campaign Name","adGroupName":"SD: Ad Group Name","keyword":"keyword text","matchType":"Exact"}
{"type":"add_keyword","campaignName":"Dealer - Campaign Name","adGroupName":"SD: Ad Group Name","keyword":"keyword text","matchType":"Phrase"}

ADD A NEGATIVE KEYWORD:
{"type":"add_negative","campaignName":"Dealer - Campaign Name","adGroupName":"SD: Ad Group Name","keyword":"negative term","matchType":"Negative Phrase"}

CREATE AN RSA AD:
{"type":"create_rsa","campaignName":"Dealer - Campaign Name","adGroupName":"SD: Ad Group Name","headlines":["H1","H2","H3","H4","H5","H6","H7","H8","H9","H10","H11","H12","H13","H14","H15"],"descriptions":["D1","D2","D3","D4"],"finalUrl":"https://example.com","path1":"Path1","path2":"Path2"}

IMPORTANT: Headlines must be 30 chars max. Descriptions must be 90 chars max. Generate ALL 15 headlines and ALL 4 descriptions.

SET LOCATION:
{"type":"set_location","campaignName":"Dealer - Campaign Name","lat":30.123,"lng":-90.456,"radius":20}

PAUSE/ENABLE:
{"type":"pause_campaign","campaignName":"Campaign Name"}
{"type":"enable_campaign","campaignName":"Campaign Name"}

You MUST use these exact type values. Do NOT invent new types like "campaign_creation" or "ad_group_creation". Use the exact types above.
Common things to verify: website platform, dealer group membership, stock levels,
which models to include/exclude, budget preferences, existing campaigns to keep.

${STRATEGY_RULES_BLOCK}
`;

  if (mode === 'build_account') {
    return base + `
## MODE: BUILD FULL ACCOUNT
The user is pasting a dealer homepage URL. You need to:
1. Use web_search to fetch the page and extract: dealer name, city, state, makes, platform type
2. Ask clarifying questions: Is this dealer part of a group? Any models to exclude? Budget preference?
3. Generate a full account build plan with all campaigns, ad groups, keywords, and ads

When generating the plan, include every campaign with its ad groups listed. The plan.changes array
should contain high-level entries like:
{ "type": "create_campaign", "campaignName": "...", "details": { ... } }

The user wants to see EVERYTHING before approving.
`;
  }

  if (mode === 'freshdesk_task') {
    return base + `
## MODE: FRESHDESK TICKET
The user is pasting a Freshdesk ticket. Parse the ticket to understand:
- What account/dealer is this about?
- What changes are being requested?
- Generate a structured plan of Google Ads changes

If the ticket is ambiguous, ask clarifying questions before generating the plan.
${context.accountStructure ? '\n## CURRENT ACCOUNT STRUCTURE\n' + JSON.stringify(context.accountStructure, null, 2).slice(0, 10000) : ''}
`;
  }

  if (mode === 'audit') {
    return base + `
## MODE: ACCOUNT AUDIT
The user wants you to audit the current account. Analyze the structure and check for:
- Match type violations (any Broad match keywords)
- Missing negatives (campaigns without cross-make negatives)
- Headline pinning issues
- Automatically created assets enabled
- Inconsistent targeting across campaigns
- Inconsistent ad schedules
- Budget name issues
- Stale/paused campaign cleanup opportunities
- Missing ad groups per model (should be 16 new, 4 used per strategy)
- CPC out of range for campaign type
- Brand campaign with OEM make keywords (should be dealer name ONLY)

Present findings as actionable items the user can approve for fixing.
${context.accountStructure ? '\n## CURRENT ACCOUNT STRUCTURE\n' + JSON.stringify(context.accountStructure, null, 2).slice(0, 10000) : ''}
`;
  }

  // plain_task
  return base + `
## MODE: TASK EXECUTION
The user is describing a task in plain English. Parse it into structured Google Ads changes.
Supported change types: pause_campaign, enable_campaign, update_budget, pause_ad_group,
enable_ad_group, pause_keyword, enable_keyword, add_keyword, add_negative_keyword,
exclude_radius, add_radius, update_keyword_bid, create_campaign, create_ad_group, create_rsa,
set_location_targeting, set_ad_schedule, create_shared_budget, assign_campaign_budget,
dismiss_recommendation, pause_ad, enable_ad, update_rsa.

When user says "create X", generate the full structure (campaigns, ad groups, keywords, ads)
and show it in detail for approval before executing.
${context.accountStructure ? '\n## CURRENT ACCOUNT STRUCTURE\n' + JSON.stringify(context.accountStructure, null, 2).slice(0, 10000) : ''}
`;
}

// ─────────────────────────────────────────────────────────────
// Claude API caller
// ─────────────────────────────────────────────────────────────

/**
 * Calls the Anthropic Claude API with conversation history.
 * @param {string} systemPrompt
 * @param {Array<{role: string, content: string}>} messages
 * @param {Object} config - { apiKey, model, maxTokens }
 * @param {Array} [tools] - Optional tools (web_search)
 * @returns {Promise<string>} Raw text response from Claude
 */
async function callClaude(systemPrompt, messages, config, tools) {
  const body = {
    model: config.model || 'claude-sonnet-4-20250514',
    max_tokens: config.maxTokens || 4096,
    system: systemPrompt,
    messages,
  };
  if (tools && tools.length) body.tools = tools;

  const resp = await axios.post('https://api.anthropic.com/v1/messages', body, {
    headers: {
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    timeout: 120000,
  });

  const content = resp.data.content || [];

  // Handle tool_use responses (e.g., web_search) — extract text from all blocks
  const textParts = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      textParts.push(block.text);
    } else if (block.type === 'tool_result' && block.content) {
      // Tool results can contain nested text
      if (typeof block.content === 'string') textParts.push(block.content);
      else if (Array.isArray(block.content)) {
        block.content.filter(b => b.type === 'text').forEach(b => textParts.push(b.text));
      }
    }
  }

  const result = textParts.join('');
  if (!result) {
    // If Claude only returned tool_use blocks (needs to continue), return a fallback
    console.warn('[CC] Claude returned no text content. Stop reason:', resp.data.stop_reason, 'Content types:', content.map(b => b.type));
    return JSON.stringify({
      status: 'clarifying',
      message: 'I\'m processing your request. Please give me a moment...',
      questions: [],
      confidence: 0.5,
    });
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// Response parsing
// ─────────────────────────────────────────────────────────────

/**
 * Parse Claude's JSON response, handling markdown code fences.
 * @param {string} text
 * @returns {Object|null}
 */
function parseResponse(text) {
  if (!text) return null;
  const clean = String(text).replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
  // Try full parse
  try { return JSON.parse(clean); } catch {}
  // Try extracting JSON object
  const s = clean.indexOf('{');
  const e = clean.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(clean.slice(s, e + 1)); } catch {}
  }
  return null;
}

/**
 * Process Claude's response and determine next action.
 * @param {string} rawResponse - Claude's raw text
 * @param {Object} session - Conversation session state
 * @returns {Object} { type: 'questions'|'plan'|'message'|'error', ... }
 */
function processResponse(rawResponse, session) {
  const parsed = parseResponse(rawResponse);

  if (!parsed) {
    return {
      type: 'message',
      message: String(rawResponse || 'No response received'),
    };
  }

  if (parsed.status === 'need_info') {
    session.pendingQuestions = parsed.questions || [];
    return {
      type: 'questions',
      message: parsed.message || 'I need some more information:',
      questions: parsed.questions || [],
      confidence: parsed.confidence || 0,
    };
  }

  if (parsed.status === 'plan_ready') {
    // Force questions if confidence is too low
    if (parsed.confidence < 0.8 && parsed.questions && parsed.questions.length > 0) {
      session.pendingQuestions = parsed.questions;
      return {
        type: 'questions',
        message: (parsed.message || '') + '\n\nBefore I proceed, I want to verify:',
        questions: parsed.questions,
        confidence: parsed.confidence,
      };
    }

    session.pendingPlan = parsed.plan;
    return {
      type: 'plan',
      message: parsed.message || 'Here is my plan:',
      plan: parsed.plan,
      confidence: parsed.confidence || 1,
    };
  }

  // clarifying or other
  return {
    type: 'message',
    message: parsed.message || rawResponse,
    confidence: parsed.confidence || 0,
  };
}

// ─────────────────────────────────────────────────────────────
// Session management
// ─────────────────────────────────────────────────────────────

/**
 * Creates a fresh conversation session.
 * @returns {Object}
 */
function createSession() {
  return {
    messages: [],
    detectedMode: null,
    dealerContext: null,
    accountStructure: null,
    pendingPlan: null,
    pendingQuestions: [],
    customerId: null,
  };
}

/**
 * Main message handler — processes user input through the conversation.
 * @param {Object} session - Conversation session from Express session
 * @param {string} userMessage - User's input text
 * @param {Object} config - { apiKey, model }
 * @param {Object} [context] - { accountStructure, customerId }
 * @returns {Promise<Object>} Response to render in the UI
 */
async function handleMessage(session, userMessage, config, context = {}) {
  // Detect mode on first message
  if (!session.detectedMode) {
    session.detectedMode = detectInputType(userMessage);
  }

  // Update context if provided
  if (context.accountStructure) session.accountStructure = context.accountStructure;
  if (context.customerId) session.customerId = context.customerId;

  // Add user message to history
  session.messages.push({ role: 'user', content: userMessage });

  // Build system prompt
  const systemPrompt = buildSystemPrompt(session.detectedMode, {
    dealerContext: session.dealerContext,
    accountStructure: session.accountStructure,
  });

  // No tools for now — avoid tool_use/tool_result conversation state issues
  // Claude can extract dealer info from its training knowledge when given a URL
  const tools = undefined;

  // Call Claude — keep only the last few messages to avoid context issues
  // Trim conversation to last 10 messages to prevent tool_use/tool_result mismatch
  const trimmedMessages = session.messages.slice(-10);

  let rawResponse;
  try {
    rawResponse = await callClaude(systemPrompt, trimmedMessages, config, tools);
  } catch (claudeErr) {
    // Extract useful error info from axios errors
    const errMsg = claudeErr.response?.data?.error?.message || claudeErr.message || String(claudeErr);
    console.error('[CC] Claude API error:', errMsg);
    // Remove the failed user message so conversation isn't corrupted
    session.messages.pop();
    throw new Error('Claude API error: ' + errMsg);
  }

  if (!rawResponse) {
    session.messages.pop(); // remove user message if no response
    return { type: 'message', message: 'No response from Claude. Please try again.' };
  }

  // Add assistant response to history as plain text
  session.messages.push({ role: 'assistant', content: rawResponse });

  // Process the response
  const result = processResponse(rawResponse, session);
  return result;
}

// ─────────────────────────────────────────────────────────────
// Ad schedule helper (for create_campaign flows)
// ─────────────────────────────────────────────────────────────

/**
 * Returns the standard Savvy Dealer ad schedule as Google Ads Editor format string.
 * @returns {string}
 */
function getAdScheduleString() {
  return '(Monday[08:30-19:00]);(Tuesday[08:30-19:00]);(Wednesday[08:30-19:00]);(Thursday[08:30-19:00]);(Friday[08:30-19:00]);(Saturday[08:30-20:30])';
}

/**
 * Returns ad schedule as an array for the set_ad_schedule change type.
 * @returns {Array<Object>}
 */
function getAdScheduleChanges() {
  const days = [
    { dayOfWeek: 'MONDAY',    startHour: 8, startMinute: 30, endHour: 19, endMinute: 0 },
    { dayOfWeek: 'TUESDAY',   startHour: 8, startMinute: 30, endHour: 19, endMinute: 0 },
    { dayOfWeek: 'WEDNESDAY', startHour: 8, startMinute: 30, endHour: 19, endMinute: 0 },
    { dayOfWeek: 'THURSDAY',  startHour: 8, startMinute: 30, endHour: 19, endMinute: 0 },
    { dayOfWeek: 'FRIDAY',    startHour: 8, startMinute: 30, endHour: 19, endMinute: 0 },
    { dayOfWeek: 'SATURDAY',  startHour: 8, startMinute: 30, endHour: 20, endMinute: 30 },
  ];
  return days;
}

module.exports = {
  detectInputType,
  buildSystemPrompt,
  callClaude,
  parseResponse,
  processResponse,
  createSession,
  handleMessage,
  getAdScheduleString,
  getAdScheduleChanges,
  STRATEGY_RULES_BLOCK,
};
