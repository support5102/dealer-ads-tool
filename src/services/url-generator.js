'use strict';

/**
 * URL Generator for Dealer Inventory Pages
 *
 * Generates correct inventory URLs for different dealer website platforms.
 * Supports both new and used vehicle inventory URLs.
 *
 * @module url-generator
 */

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

/**
 * Convert a string to a URL-safe slug (lowercase, spaces to hyphens, strip special chars).
 * @param {string} value
 * @returns {string}
 */
function toSlug(value) {
  if (!value) return '';
  return value
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// URL pattern definitions
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} PlatformPatterns
 * @property {function(string, string, Object=): string} new  - Generates new inventory path
 * @property {function(string, string, Object=): string} used - Generates used inventory path
 */

/**
 * URL patterns keyed by platform name.
 * Each platform has a `new` and `used` function that returns the path portion of the URL.
 *
 * @type {Object<string, PlatformPatterns>}
 */
const URL_PATTERNS = {
  autofusion: {
    new:  (make, model) => `/search/New+${make}+${model}+tmM`,
    used: (make, model) => `/search/Used+${make}+${model}+tmM`,
  },
  teamvelocity: {
    new:  (make, model) => `/inventory/new/${make.toLowerCase()}/${toSlug(model)}`,
    used: (make, model) => `/inventory/used/${make.toLowerCase()}/${toSlug(model)}`,
  },
  dealerinspire: {
    new:  (_make, model) => `/new-vehicles/${toSlug(model)}/`,
    used: (_make, model) => `/used-vehicles/${toSlug(model)}/`,
  },
  eprocess: {
    new:  (make, model, opts = {}) => {
      const city  = toSlug(opts.city  || '');
      const state = (opts.state || '').toLowerCase();
      return `/search/new-${toSlug(make)}-${toSlug(model)}-${city}-${state}/?tp=new`;
    },
    used: (make, model, opts = {}) => {
      const city  = toSlug(opts.city  || '');
      const state = (opts.state || '').toLowerCase();
      return `/search/used-${toSlug(make)}-${toSlug(model)}-${city}-${state}/?tp=used`;
    },
  },
  dealeron: {
    new:  (make, model) => `/new-inventory/index.htm?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}`,
    used: (make, model) => `/used-inventory/index.htm?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}`,
  },
  dealercom: {
    new:  (make, model) => `/vcp/new/${make.toLowerCase()}/${toSlug(model)}`,
    used: (make, model) => `/vcp/used/${make.toLowerCase()}/${toSlug(model)}`,
  },
  foxdealer: {
    new:  (_make, model) => `/new-vehicles/${toSlug(model)}`,
    used: (_make, model) => `/used-vehicles/${toSlug(model)}`,
  },
  sincro: {
    new:  (_make, model) => `/new-inventory/?model=${encodeURIComponent(model)}`,
    used: (_make, model) => `/used-inventory/?model=${encodeURIComponent(model)}`,
  },
  savvydealer: {
    new:  (make, model) => `/inventory/new?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}`,
    used: (make, model) => `/inventory/used?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}`,
  },
};

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

/**
 * Heuristics used to detect which platform a URL belongs to.
 * Order matters -- more specific patterns come first.
 * @type {Array<{platform: string, test: function(string): boolean}>}
 */
const DETECTION_RULES = [
  { platform: 'autofusion',    test: (u) => /\/search\/(New|Used)\+/i.test(u) },
  { platform: 'teamvelocity',  test: (u) => /\/inventory\/(new|used)\/[a-z]+\/[a-z0-9-]+/i.test(u) && !/\?/.test(u) },
  { platform: 'dealerinspire', test: (u) => /\/(new|used)-vehicles\/[a-z0-9-]+\/?$/i.test(u) },
  { platform: 'eprocess',      test: (u) => /\/search\/(new|used)-.*\?tp=(new|used)/i.test(u) },
  { platform: 'dealeron',      test: (u) => /\/(new|used)-inventory\/index\.htm/i.test(u) },
  { platform: 'dealercom',     test: (u) => /\/vcp\/(new|used)\//i.test(u) },
  { platform: 'foxdealer',     test: (u) => /\/(new|used)-vehicles\/[a-z0-9-]+$/i.test(u) },
  { platform: 'sincro',        test: (u) => /\/(new|used)-inventory\/\?model=/i.test(u) },
  { platform: 'savvydealer',   test: (u) => /\/inventory\/(new|used)\?make=/i.test(u) },
];

/**
 * Detect the dealer website platform from an inventory URL.
 *
 * @param {string} url - A full or partial inventory URL.
 * @returns {string|null} The platform key (e.g. 'dealeron') or null if unrecognised.
 */
function detectPlatform(url) {
  if (!url) return null;
  for (const rule of DETECTION_RULES) {
    if (rule.test(url)) return rule.platform;
  }
  return null;
}

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

/**
 * Build an inventory URL for a given platform.
 *
 * @param {string} baseUrl    - The dealer website origin, e.g. "https://www.dealer.com"
 * @param {string} make       - Vehicle make, e.g. "Toyota"
 * @param {string} model      - Vehicle model, e.g. "Camry"
 * @param {Object} [opts]     - Additional options.
 * @param {string} [opts.city]      - Dealer city (needed for eprocess).
 * @param {string} [opts.state]     - Dealer state abbreviation (needed for eprocess).
 * @param {string} [opts.siteType]  - Platform key. Auto-detected from baseUrl if omitted.
 * @param {string} [opts.condition='new'] - 'new' or 'used'.
 * @returns {string} The full inventory URL.
 * @throws {Error} If platform cannot be determined or is unsupported.
 */
function buildInventoryUrl(baseUrl, make, model, opts = {}) {
  const condition = (opts.condition || 'new').toLowerCase();
  const platform  = opts.siteType || detectPlatform(baseUrl);

  if (!platform || !URL_PATTERNS[platform]) {
    throw new Error(`Unsupported or undetectable platform. Provide opts.siteType. Got: ${platform}`);
  }

  if (condition !== 'new' && condition !== 'used') {
    throw new Error(`condition must be "new" or "used", got "${condition}"`);
  }

  const patternFn = URL_PATTERNS[platform][condition];
  const path = patternFn(make, model, opts);

  // Strip trailing slash from baseUrl to avoid double-slash
  const origin = baseUrl.replace(/\/+$/, '');
  return `${origin}${path}`;
}

// ---------------------------------------------------------------------------
// Template parser  (parseTpl)
// ---------------------------------------------------------------------------

/**
 * Take an existing inventory URL and swap in a different make/model,
 * producing a new URL that follows the same platform pattern.
 *
 * This is useful when you have one example URL from a dealer and need to
 * generate URLs for their other models.
 *
 * @param {string} templateUrl - An existing inventory URL to use as a template.
 * @param {string} model       - The new model name to insert.
 * @param {string} make        - The new make name to insert.
 * @returns {string} The updated URL with the new make/model.
 * @throws {Error} If the platform cannot be detected from the template URL.
 */
function parseTpl(templateUrl, model, make) {
  if (!templateUrl) throw new Error('templateUrl is required');

  const platform = detectPlatform(templateUrl);
  if (!platform) {
    throw new Error(`Cannot detect platform from URL: ${templateUrl}`);
  }

  // Determine condition from the URL
  const condition = detectCondition(templateUrl);

  // Extract base origin from the full URL
  let origin;
  try {
    const parsed = new URL(templateUrl);
    origin = parsed.origin;
  } catch {
    // If it's just a path, keep it relative
    const pathStart = templateUrl.indexOf('/');
    origin = pathStart > 0 ? templateUrl.substring(0, pathStart) : '';
  }

  // Rebuild using standard builder -- we need opts for eprocess
  const opts = { siteType: platform, condition };

  // Try to extract city/state from eprocess URLs
  if (platform === 'eprocess') {
    const eprocessMatch = templateUrl.match(/\/search\/(?:new|used)-[a-z0-9-]+-[a-z0-9-]+-([a-z0-9-]+)-([a-z]{2})\//i);
    if (eprocessMatch) {
      opts.city  = eprocessMatch[1];
      opts.state = eprocessMatch[2];
    }
  }

  return buildInventoryUrl(origin, make, model, opts);
}

/**
 * Detect whether a URL points to new or used inventory.
 * @param {string} url
 * @returns {'new'|'used'}
 */
function detectCondition(url) {
  if (!url) return 'new';
  const lower = url.toLowerCase();
  if (lower.includes('used') || lower.includes('tp=used')) return 'used';
  return 'new';
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { buildInventoryUrl, parseTpl, detectPlatform, URL_PATTERNS };
