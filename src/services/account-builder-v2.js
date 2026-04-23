/**
 * Account Builder v2 — thin orchestrator that turns a pasted URL (+ optional
 * free-text notes) into a complete Google Ads Editor CSV.
 *
 * Strategy: the heavy lifting (campaign/ad-group/keyword/negative generation,
 * no-pinning, correct CPCs, cross-make sculpting) already lives in
 * src/services/account-builder.js → buildRows(). This module produces the
 * structured `groups[]` input that buildRows() expects, sourced from:
 *
 *   1. OEM catalog (src/data/oem-models.json) — EVERY current new model per
 *      brand. The dealer gets one campaign per model the brand offers.
 *   2. Dealer Site Enricher — dealer name, city/state, lat/lng, platform,
 *      competitors, nearby cities (Claude web_search).
 *   3. Notes parser — operator overrides (budget, skip models, radius, etc.).
 *
 * Mounted by: src/routes/account-builder.js
 *
 * Flow:
 *   buildAccountPlan({url, notes}, claudeConfig)
 *     → enrichFromUrl()
 *     → resolve primary make + full model list from OEM catalog
 *     → apply notes.skipModels filter
 *     → build groups[] (make + baseUrl + siteType + models[])
 *     → call buildRows({dealer, city, state, groups, ...})
 *     → return { plan, rows, csvRowCount, warnings }
 */

'use strict';

const oemCatalog = require('./oem-catalog');
const { enrichFromUrl, parseNotes } = require('./dealer-site-enricher');
const { buildRows } = require('./account-builder');

// ─────────────────────────────────────────────────────────────
// Platform → siteType mapping (for URL pattern resolution)
// ─────────────────────────────────────────────────────────────

const PLATFORM_SITETYPE = {
  'DealerOn':      'dealeron',
  'DealerInspire': 'dealerinspire',
  'Dealer.com':    'dealercom',
  'eProcess':      'eprocess',
  'Fox':           'fox',
  'Sincro':        'sincro',
  'SavvyDealer':   'savvydealer',
  'unknown':       '',
};

// ─────────────────────────────────────────────────────────────
// Model years
// ─────────────────────────────────────────────────────────────

/**
 * Returns { year1, year2 } strings for ad group and keyword generation.
 * Defaults to current calendar year and current + 1 (model-year convention).
 *
 * @param {Date} [now]
 * @returns {{year1:string, year2:string}}
 */
function resolveModelYears(now = new Date()) {
  const yr = now.getFullYear();
  return { year1: String(yr), year2: String(yr + 1) };
}

// ─────────────────────────────────────────────────────────────
// Group construction
// ─────────────────────────────────────────────────────────────

/**
 * Given a make name (alias-tolerant), returns the OEM catalog's full model
 * list shaped as the `models[]` entries buildRows() expects.
 *
 * @param {string} makeName
 * @param {{year1:string, year2:string}} years
 * @param {string[]} [skipModels] - Case-insensitive model names to omit
 * @returns {Array<{name:string, year1:string, year2:string, customUrl:string, stock:string}>}
 */
function modelsForMake(makeName, years, skipModels = []) {
  const models = oemCatalog.getModels(makeName);
  if (!models) return [];

  // Normalize skip tokens and filter empties / single-char fragments.
  // Use substring (contains) matching so casual notes like
  //   "skip: Mustang, Mach-E"
  // correctly filter both "Mustang" AND "Mustang Mach-E".
  const skipTokens = skipModels
    .map(s => String(s).toLowerCase().trim())
    .filter(s => s.length >= 2);

  const shouldSkip = (modelName) => {
    const n = modelName.toLowerCase();
    return skipTokens.some(token => n.includes(token));
  };

  return models
    .filter(name => !shouldSkip(name))
    .map(name => ({
      name,
      year1: years.year1,
      year2: years.year2,
      customUrl: '',
      stock: '',  // unknown — campaigns enable by default in buildRows if stock blank
    }));
}

/**
 * Builds the `groups[]` array for buildRows() from a resolved profile.
 *
 * @param {object} profile - Enriched dealer profile
 * @returns {Array<object>} groups input for buildRows()
 */
function buildGroups(profile) {
  const years = resolveModelYears();
  const overrides = profile.notesOverrides || parseNotes('');

  // Decide which makes to include:
  //  1. explicit notes override wins
  //  2. else use profile.makes[] if populated (multi-brand)
  //  3. else fall back to profile.make (single-brand)
  let makes = [];
  if (overrides.makeOverride) {
    makes = [overrides.makeOverride];
  } else if (Array.isArray(profile.makes) && profile.makes.length > 0) {
    makes = profile.makes;
  } else if (profile.make) {
    makes = [profile.make];
  }

  // Resolve each make through the OEM catalog so we get the canonical
  // display name (e.g. "chevy" → "Chevrolet") and the FULL current lineup.
  const groups = [];
  for (const rawMake of makes) {
    const brand = oemCatalog.getBrand(rawMake);
    if (!brand) continue;

    const models = modelsForMake(brand.displayName, years, overrides.skipModels);
    if (models.length === 0) continue;

    groups.push({
      make:         brand.displayName,
      baseUrl:      profile.websiteUrl || '',
      templateUrl:  '',
      templateModel:'',
      siteType:     PLATFORM_SITETYPE[profile.platform] || '',
      models,
    });
  }

  return groups;
}

// ─────────────────────────────────────────────────────────────
// Main orchestration
// ─────────────────────────────────────────────────────────────

/**
 * Build a full account plan from a dealer URL + optional notes.
 *
 * @param {{url:string, notes?:string}} input
 * @param {{apiKey:string, model:string}} claudeConfig
 * @param {object} [deps] - Test seams
 * @returns {Promise<{
 *   profile: object,
 *   groups: Array<object>,
 *   rows: Array<object>,
 *   plan: {
 *     dealer: string,
 *     city: string,
 *     state: string,
 *     platform: string,
 *     makes: string[],
 *     campaignCount: number,
 *     adGroupCount: number,
 *     keywordCount: number,
 *     modelCampaignCount: number,
 *     usedModelCount: number,
 *   },
 *   warnings: string[]
 * }>}
 */
async function buildAccountPlan(input, claudeConfig, deps = {}) {
  if (!input || !input.url) {
    throw new Error('buildAccountPlan: input.url is required');
  }

  const enricher = deps.enrichFromUrl || enrichFromUrl;
  const builder  = deps.buildRows     || buildRows;

  // 1. Enrich URL (calls Claude web_search)
  const profile = await enricher(claudeConfig, input.url, input.notes);

  // 2. Parse notes deterministically here (don't depend on enricher attaching it).
  //    If enricher already populated notesOverrides, re-parse anyway so the source
  //    of truth is always the caller's input.notes.
  profile.notesOverrides = parseNotes(input.notes || '');

  // 3. Build groups from OEM catalog
  const groups = buildGroups(profile);

  if (groups.length === 0) {
    throw new Error(
      `Could not resolve make for dealer at ${input.url}. ` +
      `Enricher returned make="${profile.make}", makes=${JSON.stringify(profile.makes)}. ` +
      `Add a 'make: Ford' line to the notes to override.`
    );
  }

  // 4. Apply operator radius override if provided
  const overrides = profile.notesOverrides;
  const radius = overrides.radius || 20;  // 20mi default matches strategy guide 15-25mi
  const locations = (profile.lat != null && profile.lng != null)
    ? [{ lat: profile.lat, lng: profile.lng, radius }]
    : [];

  // 5. Call proven CSV builder
  const rows = builder({
    dealer:       profile.dealerName || '',
    city:         profile.city || '',
    state:        profile.state || '',
    groups,
    startDate:    new Date().toISOString().slice(0, 10),
    competitors:  profile.competitors || [],
    locations,
    nearbyCities: profile.nearbyCities || [],
    dealerGroup:  profile.dealerGroup || [],
  });

  // 6. Compute plan summary for preview
  const plan = summarizePlan(rows, groups, profile);

  // 7. Accumulate warnings
  const warnings = [...(profile.warnings || [])];
  if (!profile.lat || !profile.lng) {
    warnings.push('No geo coordinates found — Location rows skipped. Add manually in Ads Editor.');
  }
  if (!profile.city) warnings.push('City not detected.');
  if (!profile.state) warnings.push('State not detected.');
  if (overrides.monthlyBudget) {
    warnings.push(
      `Note specified monthly budget $${overrides.monthlyBudget}. ` +
      `This tool does NOT set budgets — configure shared budgets in Ads Editor per the ` +
      `${Math.round(overrides.monthlyBudget * 0.27 / 30)}~${Math.round(overrides.monthlyBudget * 0.30 / 30)}/day ` +
      `New-Search allocation from the strategy guide.`
    );
  }

  return { profile, groups, rows, plan, warnings };
}

/**
 * Summarize the produced rows into a plan object for the preview UI.
 *
 * @param {Array<object>} rows
 * @param {Array<object>} groups
 * @param {object} profile
 * @returns {object}
 */
function summarizePlan(rows, groups, profile) {
  const campaignNames = new Set();
  const adGroupKeys   = new Set();
  let keywordCount    = 0;
  let adCount         = 0;
  let negativeCount   = 0;

  for (const row of rows) {
    const c = row['Campaign'];
    const ag = row['Ad Group'];
    const criterion = row['Criterion Type'];
    const adType    = row['Ad type'];
    const kw        = row['Keyword'];

    if (c) campaignNames.add(c);
    if (c && ag) adGroupKeys.add(c + '\u0001' + ag);

    if (adType === 'Responsive search ad') adCount++;
    if (kw && criterion) {
      if (criterion.startsWith('Negative')) negativeCount++;
      else keywordCount++;
    }
  }

  const modelCampaignCount = [...campaignNames].filter(n => / - New - /.test(n) && !/ - General Terms$/.test(n)).length;

  const totalModels = groups.reduce((sum, g) => sum + g.models.length, 0);

  return {
    dealer:             profile.dealerName || '',
    city:               profile.city || '',
    state:              profile.state || '',
    platform:           profile.platform || 'unknown',
    makes:              groups.map(g => g.make),
    campaignCount:      campaignNames.size,
    adGroupCount:       adGroupKeys.size,
    keywordCount,
    adCount,
    negativeCount,
    modelCampaignCount,
    totalModelsInCatalog: totalModels,
  };
}

module.exports = {
  buildAccountPlan,
  // Exposed for unit tests
  _internal: { buildGroups, modelsForMake, resolveModelYears, summarizePlan },
};
