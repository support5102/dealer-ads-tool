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

ADD A NEGATIVE KEYWORD (campaign-level — adGroupName is NEVER used here):
  PREFERRED — wildcard matcher (server expands against account structure):
    {"type":"add_negative_keyword","campaignsMatching":{"contains":" - New - "},"keyword":"2010","matchType":"Negative Phrase"}
    {"type":"add_negative_keyword","campaignsMatching":"all","keyword":"wrangler","matchType":"Negative Exact"}
    {"type":"add_negative_keyword","campaignsMatching":{"contains":"Jeep"},"keyword":"...","matchType":"..."}
    {"type":"add_negative_keyword","campaignsMatching":{"contains":" - New - ","notContains":"Brand"},"keyword":"...","matchType":"..."}

  EXPLICIT LIST (when targets don't share a substring pattern):
    {"type":"add_negative_keyword","campaignNames":["Camp A","Camp B","Camp C"],"keyword":"...","matchType":"..."}

  SINGLE CAMPAIGN ONLY (rarely correct — almost every negative-keyword request is bulk):
    {"type":"add_negative_keyword","campaignName":"Camp A","keyword":"...","matchType":"..."}

For ANY negative keyword that should hit more than one campaign, use 'campaignsMatching' (preferred) or 'campaignNames' (explicit list). NEVER emit multiple separate change rows that differ only in campaignName — that is always a bug. The matcher form lets you cover 47 new-model campaigns in ONE row.

CREATE AN RSA AD:
{"type":"create_rsa","campaignName":"Dealer - Campaign Name","adGroupName":"SD: Ad Group Name","headlines":["H1","H2","H3","H4","H5","H6","H7","H8","H9","H10","H11","H12","H13","H14","H15"],"descriptions":["D1","D2","D3","D4"],"finalUrl":"https://example.com","path1":"Path1","path2":"Path2"}

IMPORTANT: Headlines must be 30 chars max. Descriptions must be 90 chars max. Generate ALL 15 headlines and ALL 4 descriptions.

SET LOCATION:
{"type":"set_location","campaignName":"Dealer - Campaign Name","lat":30.123,"lng":-90.456,"radius":20}

PAUSE/ENABLE:
{"type":"pause_campaign","campaignName":"Campaign Name"}
{"type":"enable_campaign","campaignName":"Campaign Name"}

UPDATE A CAMPAIGN BUDGET (new daily amount in dollars; engine resolves the budget resource from campaignName):
{"type":"update_budget","campaignName":"Campaign Name","details":{"newBudget":24}}

  CRITICAL: when the account structure shows a SHARED budget covering multiple campaigns, updating ANY one campaign's budget mutates the shared resource for ALL of them. Emit ONLY ONE update_budget row per shared budget — use any one of its member campaigns. Do NOT emit one row per campaign sharing a budget; that double-writes the same resource.

  For STANDALONE budgets, emit one update_budget row per campaign with the desired per-campaign amount.

  Examples — given account structure showing "Ram Combined Budget" shared by Ram 1500 + Ram 2500 at $32/day:
    Correct: ONE row {"type":"update_budget","campaignName":"Bob Weaver Auto - New - Ram - 1500","details":{"newBudget":32}}  // updates shared budget to $32 — covers both Ram campaigns
    Wrong:   TWO rows updating Ram 1500 to $16 and Ram 2500 to $16  // last write wins; budget ends at $16 not $32

  Given two standalone budgets for Grand Cherokee ($24) and Wrangler ($24):
    Correct: TWO rows, each with its own newBudget value.

CREATE A NEW SHARED BUDGET (and assign campaigns to it):
{"type":"create_shared_budget","details":{"budgetName":"CDJR Combined","dailyAmount":64,"campaignNames":["Camp A","Camp B"]}}

ASSIGN AN EXISTING SHARED BUDGET TO A CAMPAIGN:
{"type":"assign_campaign_budget","campaignName":"Camp Name","details":{"budgetName":"Existing Shared Budget Name"}}

NEVER reference budget names that don't appear in the SHARED BUDGETS section of the account structure. If the user asks to "modify existing" and no matching shared budget exists in the structure, the budgets are standalone — emit per-campaign update_budget rows.

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

When the ticket says "all models", "all campaigns", "all new campaigns",
"every model", or similar broad language, you MUST enumerate every matching
campaign from the account structure below — do NOT sample, do NOT pick a
representative subset, do NOT pick only the most-popular models. List the
change for EVERY campaign that matches the scope. If a ticket asks for 17
negatives across all new-model campaigns and there are 10 new-model
campaigns, the plan has 170 changes, not 30.

NEGATIVE KEYWORDS ARE CAMPAIGN-LEVEL BY DEFAULT. When generating
add_negative_keyword changes, OMIT the adGroupName field — emit exactly
one change row per (campaignName, keyword, matchType) combination. The
executor adds negatives at the campaign level which applies to every ad
group in that campaign automatically. Adding the same negative per ad
group is redundant and produces duplicate-looking rows in the plan UI.
Only set adGroupName for negatives when the user explicitly asks for
ad-group-specific traffic sculpting (e.g., "negative 'lease' on the
sale-themed ad groups only").

COUNT CHANGES AT THE CAMPAIGN LEVEL when estimating or describing scope
to the user. NEVER multiply by ad-group count when describing how many
negative-keyword changes a request will produce. Correct math: 44
campaigns × 15 keywords = 660 changes. WRONG math: 44 campaigns × 16
ad groups × 15 keywords = 10,560 changes. The number of ad groups
inside a campaign is irrelevant to the change count — the negative is
applied once per campaign. If you find yourself describing a number in
the thousands or tens of thousands for a negative-keyword request,
stop and recompute at the campaign level — it is almost certainly
wrong. Just emit the plan; don't ask the user to choose between
"complete list" and "sample" — there is no sample mode.

USE THE WILDCARD MATCHER for bulk negative-keyword changes. The
preferred form is 'campaignsMatching', which the server expands
against the live account structure — you never have to enumerate
campaign names by hand:

  // All new-model campaigns (matches " - New - " substring):
  { "type": "add_negative_keyword",
    "campaignsMatching": { "contains": " - New - " },
    "keyword": "2010", "matchType": "Negative Phrase" }

  // Every campaign in the account:
  { "type": "add_negative_keyword",
    "campaignsMatching": "all",
    "keyword": "wrangler", "matchType": "Negative Exact" }

  // All Jeep campaigns only:
  { "type": "add_negative_keyword",
    "campaignsMatching": { "contains": "Jeep" },
    "keyword": "...", "matchType": "..." }

  // All new-model campaigns EXCEPT brand:
  { "type": "add_negative_keyword",
    "campaignsMatching": { "contains": " - New - ", "notContains": "Brand" },
    "keyword": "...", "matchType": "..." }

Substring matching is case-insensitive. 'contains' can be a string
or array (AND semantics — all substrings must appear). 'notContains'
works the same way for exclusions.

USE 'campaignsMatching' WHENEVER THE REQUEST IS "ACROSS ALL X
CAMPAIGNS." It's vastly more reliable than enumerating campaign
names and the server stays correct as campaigns are added/removed.
Look at the account structure section to confirm which substring
will match your intent, then emit ONE row per (keyword, matchType)
combination using the matcher.

For explicit fan-out (when you need to target a specific custom
subset), use 'campaignNames' as an array of names instead — but
prefer 'campaignsMatching' for any "all of type X" request.

  // ONE row that covers 44 campaigns:
  { "type": "add_negative_keyword",
    "campaignNames": ["Bob Weaver Auto - New - Chevrolet - Blazer",
                      "Bob Weaver Auto - New - Chevrolet - Equinox",
                      ... 42 more ...],
    "keyword": "2010", "matchType": "Negative Phrase" }

  // Same thing the WRONG way (44 separate rows, blows the token budget):
  { "type": "add_negative_keyword",
    "campaignName": "Bob Weaver Auto - New - Chevrolet - Blazer",
    "keyword": "2010", "matchType": "Negative Phrase" },
  { "type": "add_negative_keyword",
    "campaignName": "Bob Weaver Auto - New - Chevrolet - Equinox",
    "keyword": "2010", "matchType": "Negative Phrase" }, ...

For 15 year-negatives across 44 campaigns, emit 15 fan-out rows (one
per year, each listing all 44 campaigns). For a single keyword across
all 55 campaigns in the account, emit 1 fan-out row. The summary you
describe to the user should still cite the materialised row count
(e.g. "660 negative-keyword additions across 44 campaigns"), but the
JSON you EMIT must use the fan-out form.

SELF-CHECK BEFORE EMITTING: after writing your changes array, scan it
for any negative-keyword change where 'campaignName' (singular) is
set. For each one, ask: "does this same keyword apply to other
campaigns in this ticket too?" If yes, you MUST consolidate them into
ONE fan-out row with 'campaignNames' listing every target campaign.
If your scope description says "across all 44 new-model campaigns"
but your changes array only references one model campaign for that
keyword, the plan is INCOMPLETE — fix it before returning. The
fan-out array must literally contain every campaign name you said
the change applies to. Never use one campaign as a "representative
example" — list them all explicitly.

If the ticket is ambiguous, ask clarifying questions before generating the plan.
${context.accountStructure ? '\n## CURRENT ACCOUNT STRUCTURE\n' + summariseAccountStructure(context.accountStructure) : ''}
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
${context.accountStructure ? '\n## CURRENT ACCOUNT STRUCTURE\n' + summariseAccountStructure(context.accountStructure) : ''}
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

When the user's task says "all models", "all campaigns", "every campaign",
or similar broad scope, enumerate every matching campaign from the account
structure below — do NOT sample or pick a subset.
${context.accountStructure ? '\n## CURRENT ACCOUNT STRUCTURE\n' + summariseAccountStructure(context.accountStructure) : ''}
`;
}

// ─────────────────────────────────────────────────────────────
// Account structure summariser
// ─────────────────────────────────────────────────────────────

/**
 * Compact, token-efficient representation of an account's campaigns + ad groups.
 *
 * Full JSON.stringify of an account-structure object (50 campaigns × 16 ad
 * groups × keywords × ads × extensions) blows past 30-50 KB and used to be
 * truncated at 10 KB, silently hiding ~80% of campaigns from Claude. That's
 * why "add negatives to all models" plans only covered the first 3-4
 * campaigns — the rest didn't make it into the system prompt.
 *
 * This summary keeps every campaign and every ad-group name (the part Claude
 * actually needs to enumerate "all models") but drops keyword bodies, ad
 * copy, and extension content. For a 50-campaign account it's ~3-5 KB, so
 * a 60 KB hard cap on the result is more than enough headroom for the full
 * MCC structure.
 */
function summariseAccountStructure(structure) {
  if (!structure) return '';
  const lines = [];
  const customerName = structure.customerName || structure.name || '';
  const customerId = structure.customerId || structure.id || '';
  if (customerName || customerId) {
    lines.push(`Account: ${customerName}${customerId ? ` (${customerId})` : ''}`);
  }
  const campaigns = Array.isArray(structure.campaigns) ? structure.campaigns : [];
  lines.push(`Total campaigns: ${campaigns.length}`);
  lines.push('');

  // Group campaigns by shared budget so Claude can see who shares what.
  // explicitlyShared budgets matter for reallocation: updating ONE campaign's
  // budget mutates the shared resource for ALL campaigns on it.
  const sharedBudgets = new Map(); // resource -> { name, amount, members[] }
  for (const c of campaigns) {
    if (c.budgetShared && c.budgetResource) {
      const key = c.budgetResource;
      if (!sharedBudgets.has(key)) {
        sharedBudgets.set(key, {
          name: c.budgetName || '(unnamed)',
          amount: c.budget,
          members: [],
        });
      }
      sharedBudgets.get(key).members.push(c.name);
    }
  }
  if (sharedBudgets.size) {
    lines.push('SHARED BUDGETS (campaigns listed under each share the same budget — updating one updates them all):');
    for (const b of sharedBudgets.values()) {
      lines.push(`  - "${b.name}" $${b.amount}/day → ${b.members.join(', ')}`);
    }
    lines.push('');
  }

  for (const c of campaigns) {
    const status = c.status ? ` [${c.status}]` : '';
    const channel = c.advertisingChannelType || c.channelType || c.type || '';
    const budgetAmount = (c.budget != null && c.budget !== '?') ? ` $${c.budget}/day` : '';
    const budgetIdent = c.budgetShared
      ? ` (shared budget: "${c.budgetName || '?'}")`
      : (c.budgetName ? ` (standalone budget: "${c.budgetName}")` : '');
    lines.push(`Campaign: ${c.name || c.campaignName || '(unnamed)'}${status}${channel ? ` (${channel})` : ''}${budgetAmount}${budgetIdent}`);
    const adGroups = Array.isArray(c.adGroups) ? c.adGroups : [];
    if (adGroups.length === 0) {
      lines.push(`  (no ad groups)`);
    } else {
      for (const ag of adGroups) {
        const agStatus = ag.status ? ` [${ag.status}]` : '';
        const kwCount = Array.isArray(ag.keywords) ? ag.keywords.length : 0;
        lines.push(`  Ad group: ${ag.name || ag.adGroupName || '(unnamed)'}${agStatus}${kwCount ? ` — ${kwCount} keywords` : ''}`);
      }
    }
    lines.push('');
  }
  const sharedSets = Array.isArray(structure.sharedSets) ? structure.sharedSets : [];
  if (sharedSets.length) {
    lines.push('Shared negative lists:');
    for (const s of sharedSets) {
      lines.push(`  - ${s.name || s.setName || '(unnamed)'}${s.count != null ? ` (${s.count} items)` : ''}`);
    }
  }
  return lines.join('\n').slice(0, 60_000);
}

// ─────────────────────────────────────────────────────────────
// Conversation history sanitisation
// ─────────────────────────────────────────────────────────────

/**
 * Strips the verbose 'changes' array from a prior assistant turn so Claude
 * doesn't pattern-match on its format when generating the next plan.
 *
 * Why this matters: Claude very aggressively copies the structural format
 * of prior turns. If history shows 660 rows of per-row {campaignName, keyword},
 * the next plan reproduces that format even when the system prompt says
 * "use campaignsMatching." Stripping the array out of history breaks the
 * mimicry while preserving narrative continuity for follow-ups.
 *
 * Returns the original content unchanged if no JSON plan is detected.
 */
function sanitizeAssistantForHistory(content) {
  // Detect the JSON block (Claude usually responds with prose + a ```json block,
  // or a bare JSON object). Try both.
  const codeBlockMatch = content.match(/```json\s*([\s\S]*?)```/);
  const rawJsonMatch = !codeBlockMatch ? content.match(/(\{[\s\S]*\})/) : null;
  const jsonStr = codeBlockMatch ? codeBlockMatch[1] : (rawJsonMatch ? rawJsonMatch[1] : null);
  if (!jsonStr) return content;

  let parsed;
  try { parsed = JSON.parse(jsonStr); } catch { return content; }
  if (!parsed || !parsed.plan || !Array.isArray(parsed.plan.changes)) return content;

  const count = parsed.plan.changes.length;
  // CRITICAL: must remain an empty ARRAY, not a string. Claude pattern-matches
  // the shape of prior turns; if 'changes' is a string in history it emits a
  // string in its next response, which crashes the UI (changeList.forEach is
  // not a function). Empty array keeps the type contract intact.
  parsed.plan.changes = [];
  parsed.plan._historyNote =
    `[${count} change rows from this prior turn elided from history. ` +
    `Generate fresh changes per the system-prompt schema; do not try to ` +
    `reproduce the prior plan structure verbatim.]`;
  const sanitizedJson = JSON.stringify(parsed, null, 2);

  if (codeBlockMatch) {
    return content.replace(codeBlockMatch[0], '```json\n' + sanitizedJson + '\n```');
  }
  return content.replace(rawJsonMatch[0], sanitizedJson);
}

// ─────────────────────────────────────────────────────────────
// Plan normalisation
// ─────────────────────────────────────────────────────────────

/**
 * Collapses ad-group-scoped negative-keyword rows into campaign-level entries.
 * For every (campaignName, keyword, matchType) tuple in the plan we keep ONE
 * change row with adGroupName stripped. Other change types pass through
 * unchanged.
 *
 * Run on every plan returned from Claude before storing on the session, so
 * the UI count, the Apply loop, and the CSV exporter all see the same clean
 * list. Without this a Bob-Weaver-CDJR-style ticket can balloon into
 * thousands of duplicate criteria when Claude emits one row per ad group.
 */
/**
 * Expands a `campaignsMatching` selector into a list of campaign names.
 * Matcher forms:
 *   - "all" (string) — every campaign in the account
 *   - { contains: "X" } — name contains substring X (case-insensitive)
 *   - { contains: ["X","Y"] } — name contains ALL of X and Y (AND semantics)
 *   - { notContains: "Z" } — excludes names containing Z
 *   - combined: { contains: " - New - ", notContains: "Brand" }
 *
 * Used so Claude can target "all new-model campaigns" without enumerating
 * all 47 names — which it consistently fails to do reliably. The server
 * resolves the matcher against the live account structure so it stays
 * correct as campaigns are added/removed.
 */
function expandCampaignMatcher(matcher, accountStructure) {
  if (!accountStructure || !Array.isArray(accountStructure.campaigns)) return [];
  const all = accountStructure.campaigns.map(c => c.name).filter(Boolean);

  if (typeof matcher === 'string') {
    return matcher.toLowerCase() === 'all' ? all : [];
  }
  if (!matcher || typeof matcher !== 'object') return [];

  const toArr = v => (v == null ? [] : (Array.isArray(v) ? v : [v]));
  const contains = toArr(matcher.contains).map(s => String(s).toLowerCase());
  const notContains = toArr(matcher.notContains).map(s => String(s).toLowerCase());

  return all.filter(name => {
    const lower = name.toLowerCase();
    for (const s of contains) if (!lower.includes(s)) return false;
    for (const s of notContains) if (lower.includes(s)) return false;
    return true;
  });
}

function normalisePlanChanges(changes, accountStructure) {
  const NEGATIVE_TYPES = new Set(['add_negative_keyword', 'add_negative']);
  const seenNegatives = new Set();
  const result = [];
  for (const c of changes) {
    if (NEGATIVE_TYPES.has(c.type)) {
      const matchType =
        (c.matchType || (c.details && c.details.matchType) || 'Negative Phrase').trim();
      const keyword =
        (c.keyword || (c.details && c.details.keyword) || '').trim();

      // Resolve campaign list. Priority:
      //   1. campaignsMatching (wildcard, expanded against account structure)
      //   2. campaignNames / campaigns array (explicit fan-out)
      //   3. campaignName (single string)
      // (1) is the preferred form for bulk negatives; Claude has repeatedly
      // failed to reliably enumerate 40+ campaign names by hand even with
      // explicit prompt instruction. The server-side matcher is deterministic.
      let campaignList;
      if (c.campaignsMatching) {
        campaignList = expandCampaignMatcher(c.campaignsMatching, accountStructure);
        if (campaignList.length === 0 && c.campaignName) {
          campaignList = [c.campaignName];
        }
      } else if (Array.isArray(c.campaignNames) || Array.isArray(c.campaigns)) {
        const fanOut = c.campaignNames || c.campaigns;
        campaignList = fanOut.filter(Boolean).map(s => String(s).trim()).filter(Boolean);
      } else {
        campaignList = c.campaignName ? [String(c.campaignName)] : [];
      }

      for (const campaignName of campaignList) {
        if (!campaignName) continue;
        const key = `${campaignName}|${keyword}|${matchType}`;
        if (seenNegatives.has(key)) continue;
        seenNegatives.add(key);
        const normalised = {
          ...c,
          campaignName,
          adGroupName: undefined,
          campaignNames: undefined,
          campaigns: undefined,
          campaignsMatching: undefined,
        };
        if (!normalised.keyword) normalised.keyword = keyword;
        if (!normalised.matchType) normalised.matchType = matchType;
        result.push(normalised);
      }
    } else {
      result.push(c);
    }
  }
  return result;
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
    // 32768 covers the largest realistic plan. With the campaignNames fan-out
    // form, even a 715-row plan only needs ~3-4k tokens of source rows + a
    // narrative summary. The previous 16384 cap was hit when Claude wrote
    // some negative-keyword changes in per-row form instead of fan-out form,
    // truncating the latter half of new-model campaigns in ticket #295249.
    // Headroom prevents that even if Claude regresses on fan-out compliance.
    max_tokens: config.maxTokens || 32768,
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
    // 4 minutes — Claude Sonnet generates output at ~75 tokens/sec, so a full
    // 16384-token plan takes ~3.5 minutes worst-case. Stay under Cloud Run's
    // default 5-minute request timeout so we don't trade one timeout for another.
    timeout: 240000,
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

    // Normalise the plan before storing — dedupe ad-group-level negative rows
    // into campaign-level entries so the UI, Apply path, and CSV exporter all
    // see the same, clean list. Source of truth for negative-keyword scope is
    // 'campaign-level by default' per the SavvyDealer strategy; the executor
    // already applies via campaignCriteria so ad-group rows would create
    // duplicate criteria and noisy plan rows.
    // Defensive coercion: if Claude returned 'changes' as something other than
    // an array (e.g. a string description), normalise to an empty array so the
    // UI doesn't crash on changeList.forEach. The plan body's narrative text
    // is preserved so the user can see what Claude attempted.
    if (parsed.plan && parsed.plan.changes != null && !Array.isArray(parsed.plan.changes)) {
      console.warn('[CC plan] Claude returned non-array changes — coercing to []. Type was:',
        typeof parsed.plan.changes);
      parsed.plan.changes = [];
    }
    if (parsed.plan && Array.isArray(parsed.plan.changes)) {
      // Diagnostic logging — debug why bulk-negative plans regress to per-row form.
      const negChanges = parsed.plan.changes.filter(c => c.type === 'add_negative_keyword' || c.type === 'add_negative');
      const matcherForms = negChanges.filter(c => c.campaignsMatching).length;
      const arrayForms = negChanges.filter(c => Array.isArray(c.campaignNames) || Array.isArray(c.campaigns)).length;
      const singleForms = negChanges.filter(c => !c.campaignsMatching && !Array.isArray(c.campaignNames) && !Array.isArray(c.campaigns)).length;
      const structPresent = !!(session.accountStructure && Array.isArray(session.accountStructure.campaigns));
      const structCount = structPresent ? session.accountStructure.campaigns.length : 0;
      console.log(`[CC plan] raw negatives: ${negChanges.length} total | matcher=${matcherForms} array=${arrayForms} single=${singleForms} | structure: ${structPresent ? structCount + ' campaigns' : 'MISSING'}`);
      if (negChanges.length > 0 && negChanges.length < 50) {
        console.log('[CC plan] negative rows:', JSON.stringify(negChanges.map(c => ({
          type: c.type, kw: c.keyword, mt: c.matchType,
          cm: c.campaignsMatching, names: c.campaignNames, name: c.campaignName,
        })), null, 0));
      }

      parsed.plan.changes = normalisePlanChanges(parsed.plan.changes, session.accountStructure);
      console.log(`[CC plan] after normalise: ${parsed.plan.changes.length} total changes`);
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

  // Call Claude — keep only the last few messages to avoid context issues.
  // Trim conversation to last 10 messages to prevent tool_use/tool_result mismatch.
  //
  // CRITICAL: strip the heavy 'changes' arrays from prior assistant turns before
  // sending them back to Claude. When the history contains big per-row plans
  // from earlier prompts, Claude pattern-matches that format and emits per-row
  // even after we tell it to use 'campaignsMatching'. The narrative + status
  // is enough context for follow-ups; the structural details are stored
  // separately in session.pendingPlan. Session.messages stays raw on the
  // server for debugging; only the wire copy to Claude is sanitised.
  const trimmedMessages = session.messages.slice(-10).map(m => {
    if (m.role !== 'assistant' || typeof m.content !== 'string') return m;
    return { role: 'assistant', content: sanitizeAssistantForHistory(m.content) };
  });

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
