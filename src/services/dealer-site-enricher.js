/**
 * Dealer Site Enricher — turns a dealer URL (+ optional free-text notes)
 * into a structured dealer profile the Account Builder can consume.
 *
 * Called by: src/services/account-builder-v2.js (and routes/account-builder.js)
 * Calls: Anthropic REST API via axios (web_search tool for live site data)
 *
 * Output shape (all fields may be null if undetectable):
 *   {
 *     dealerName:    string,
 *     websiteUrl:    string,
 *     platform:      'DealerOn' | 'DealerInspire' | 'Dealer.com' | 'eProcess' |
 *                    'Fox' | 'Sincro' | 'SavvyDealer' | 'unknown',
 *     make:          string,            // primary make (e.g. "Ford")
 *     makes:         string[],          // all makes detected (for multi-brand dealers)
 *     city:          string,
 *     state:         string,            // 2-letter code
 *     address:       string,
 *     phone:         string,
 *     lat:           number,
 *     lng:           number,
 *     competitors:   string[],          // nearby competing dealers (same make)
 *     nearbyCities:  string[],          // market-radius cities for Regional campaign
 *     dealerGroup:   string[],          // sibling dealers if parent group detected
 *     notesOverrides: {
 *       monthlyBudget: number | null,
 *       skipModels:    string[],
 *       radius:        number | null,
 *       geoExclusions: string[],
 *       makeOverride:  string | null,
 *       flags:         { commercial?: boolean, usedHeavy?: boolean }
 *     },
 *     warnings: string[]                // anything Claude could not confirm
 *   }
 */

'use strict';

const axios = require('axios');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_TIMEOUT_MS = 90_000;  // web_search can be slow

// ─────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────

function enricherSystemPrompt() {
  return `You are an automotive Google Ads data gatherer. Given a dealer website URL (and optionally free-text notes), use web_search to find the dealer's public info and return a single JSON object.

Return ONLY raw JSON — no markdown, no code fences, no explanation.

Schema (all fields nullable if unknown; never invent values):
{
  "dealerName":   string,     // e.g. "Alan Jay Ford of Sebring" — legal/marketing name
  "websiteUrl":   string,     // canonical homepage URL the dealer uses
  "platform":     "DealerOn" | "DealerInspire" | "Dealer.com" | "eProcess" | "Fox" | "Sincro" | "SavvyDealer" | "unknown",
  "make":         string,     // PRIMARY new-vehicle make, e.g. "Ford", "Chevrolet"
  "makes":        string[],   // ALL new-vehicle makes sold (multi-brand stores)
  "city":         string,
  "state":        string,     // 2-letter USPS
  "address":      string,     // street address
  "phone":        string,
  "lat":          number,
  "lng":          number,
  "competitors":  string[],   // up to 3 nearby same-make competitors (dealership names)
  "nearbyCities": string[],   // up to 5 cities within ~25 miles for Regional campaigns
  "dealerGroup":  string[],   // sibling dealer names if part of a group (else [])
  "warnings":     string[]    // anything you could not verify
}

Platform detection hints (check page source if needed):
- DealerOn        → URLs contain "/Inventory/" or "/searchnew.aspx"; footer mentions DealerOn
- DealerInspire   → URL patterns use "/new-vehicles/" or "/inventory/new/"; <meta generator> DealerInspire
- Dealer.com      → URL uses "/new-inventory/" and Cox Automotive footer
- eProcess        → URL patterns include "/vehiclesearchresults" or "/inventory.htm"
- Fox Dealer      → Fox Dealer Interactive footer or "/new-inventory/"
- Sincro          → Sincro (formerly CDK Global) footer
- SavvyDealer     → savvydealer.com hosting, custom SRP patterns

Rules:
- Prefer the dealer's own canonical name from schema.org LocalBusiness or <title>.
- For "makes", list every new-vehicle brand on the homepage new-inventory dropdown.
- If notes contain explicit overrides (budget, skip models, geo), reflect them in the notes passed through — do NOT encode them in this JSON; just focus on site facts.
- NEVER invent geo coordinates; only return lat/lng you actually found (Google Maps / schema.org).
- Use web_search liberally. This is a one-shot call — be thorough.
`;
}

function enricherUserPrompt(url, notes) {
  let msg = `Dealer website: ${url}\n\nResearch this dealer and return the JSON profile.`;
  if (notes && String(notes).trim().length > 0) {
    msg += `\n\nOperator notes about this dealer (use as hints to disambiguate — the actual overrides are parsed separately):\n${String(notes).trim()}`;
  }
  return msg;
}

// ─────────────────────────────────────────────────────────────
// Notes parsing (deterministic, no API call)
// ─────────────────────────────────────────────────────────────

/**
 * Extracts structured overrides from free-text notes.
 * Pure + deterministic — no network calls, regex-only.
 *
 * @param {string} notes
 * @returns {{
 *   monthlyBudget: number|null,
 *   skipModels: string[],
 *   radius: number|null,
 *   geoExclusions: string[],
 *   makeOverride: string|null,
 *   flags: {commercial?:boolean, usedHeavy?:boolean}
 * }}
 */
function parseNotes(notes) {
  const out = {
    monthlyBudget: null,
    skipModels:    [],
    radius:        null,
    geoExclusions: [],
    makeOverride:  null,
    flags:         {},
  };
  if (!notes || typeof notes !== 'string') return out;
  const text = notes.trim();
  if (!text) return out;

  // Budget: "$5,000", "5000/month", "budget: 8000", "5k"
  const budgetMatch =
    text.match(/budget[:\s]*\$?([\d,]+(?:\.\d+)?)(k)?/i) ||
    text.match(/\$([\d,]+(?:\.\d+)?)\s*(?:\/\s*mo(?:nth)?|\/\s*mo\b|per\s*month)/i) ||
    text.match(/\$([\d,]+)\s*(?:budget|monthly)/i);
  if (budgetMatch) {
    const num = parseFloat(budgetMatch[1].replace(/,/g, ''));
    if (Number.isFinite(num)) {
      out.monthlyBudget = /k/i.test(budgetMatch[2] || '') ? num * 1000 : num;
    }
  }

  // Skip models: "skip: Mustang, Mach-E" / "no mustang" / "exclude camaro"
  const skipMatch = text.match(/(?:skip|exclude|no)[:\s]+([^.\n]+)/i);
  if (skipMatch) {
    out.skipModels = skipMatch[1]
      .split(/[,;]|\band\b/i)
      .map(s => s.trim())
      .filter(s => s.length > 0 && s.length < 40);
  }

  // Radius: "50 mile radius", "radius: 25mi", "25 miles"
  const radiusMatch = text.match(/(\d{1,3})\s*(?:-|\s)?mi(?:le)?s?\s*(?:radius|around|from)?/i) ||
                      text.match(/radius[:\s]+(\d{1,3})/i);
  if (radiusMatch) {
    const r = parseInt(radiusMatch[1], 10);
    if (r > 0 && r <= 200) out.radius = r;
  }

  // Geo exclusions: "no Caribbean", "exclude Mandeville", "not Monroe"
  const geoExclMatches = [...text.matchAll(/(?:no|exclude|not|avoid)\s+([A-Z][A-Za-z\s]{2,30}?)(?=[,.\n]|\band\b|$)/g)];
  for (const m of geoExclMatches) {
    const val = m[1].trim();
    if (val && !out.skipModels.some(s => s.toLowerCase() === val.toLowerCase())) {
      out.geoExclusions.push(val);
    }
  }

  // Make override: "make: Ford", "brand: Chevy"
  const makeMatch = text.match(/(?:make|brand)[:\s]+([A-Za-z\-]+(?:\s[A-Za-z\-]+)?)/i);
  if (makeMatch) out.makeOverride = makeMatch[1].trim();

  // Flags
  if (/commercial|work\s*truck|fleet/i.test(text)) out.flags.commercial = true;
  if (/used[\s-]*heavy|used[\s-]*focused|mostly\s*used/i.test(text)) out.flags.usedHeavy = true;

  return out;
}

// ─────────────────────────────────────────────────────────────
// Claude call
// ─────────────────────────────────────────────────────────────

/**
 * Enriches a dealer URL into a structured profile.
 *
 * @param {{apiKey:string, model:string}} claudeConfig
 * @param {string} url
 * @param {string} [notes]
 * @param {{axiosInstance?:object, timeoutMs?:number}} [deps] - Test seam
 * @returns {Promise<object>} Enriched profile (schema above)
 */
async function enrichFromUrl(claudeConfig, url, notes, deps = {}) {
  if (!url || typeof url !== 'string') {
    throw new Error('enrichFromUrl: url is required');
  }
  if (!claudeConfig || !claudeConfig.apiKey) {
    throw new Error('enrichFromUrl: claude apiKey not configured');
  }

  const ax = deps.axiosInstance || axios;
  const timeout = deps.timeoutMs || DEFAULT_TIMEOUT_MS;

  const payload = {
    model: claudeConfig.model,
    max_tokens: 2048,
    system: enricherSystemPrompt(),
    messages: [{ role: 'user', content: enricherUserPrompt(url, notes) }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
  };

  let response;
  try {
    response = await ax.post(ANTHROPIC_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeConfig.apiKey,
        'anthropic-version': '2023-06-01',
      },
      timeout,
    });
  } catch (err) {
    const details = err.response?.data?.error?.message || err.message;
    throw new Error(`Enricher Claude call failed: ${details}`);
  }

  // Extract text blocks (skip tool_use, tool_result)
  const textBlocks = (response.data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text);
  const raw = textBlocks.join('\n').trim();
  const clean = raw.replace(/```json|```/gi, '').trim();

  // Salvage JSON from any trailing prose
  const firstBrace = clean.indexOf('{');
  const lastBrace  = clean.lastIndexOf('}');
  const jsonStr = firstBrace >= 0 && lastBrace > firstBrace
    ? clean.slice(firstBrace, lastBrace + 1)
    : clean;

  let profile;
  try {
    profile = JSON.parse(jsonStr);
  } catch (parseErr) {
    throw new Error(
      `Enricher returned non-JSON. First 200 chars: ${raw.slice(0, 200)}`
    );
  }

  // Attach parsed notes (deterministic, independent of Claude) and normalize
  profile.notesOverrides = parseNotes(notes);
  profile.warnings = Array.isArray(profile.warnings) ? profile.warnings : [];

  // Sanity defaults for list fields
  for (const k of ['makes', 'competitors', 'nearbyCities', 'dealerGroup']) {
    if (!Array.isArray(profile[k])) profile[k] = [];
  }

  return profile;
}

module.exports = {
  enrichFromUrl,
  parseNotes,
  // Exposed for tests
  _internal: { enricherSystemPrompt, enricherUserPrompt },
};
