'use strict';

/**
 * RSA Headline & Description Generator for Google Ads campaigns.
 *
 * Strictly enforces:
 *   - Headlines: max 30 characters
 *   - Descriptions: max 90 characters
 *   - NO pinning (all positions are "-")
 *   - Case-insensitive deduplication
 *
 * @module headline-generator
 */

/** @type {Record<string, string>} Short aliases for long OEM make names */
const MAKE_ALIASES = {
  'Chevrolet': 'Chevy',
  'Volkswagen': 'VW',
  'Mercedes-Benz': 'Mercedes',
};

/* -------------------------------------------------------------------------- */
/*  Helper utilities                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Truncate text to fit within maxLen, cutting at the last word boundary.
 * Never returns a string longer than maxLen.
 *
 * @param {string} text
 * @param {number} [maxLen=30]
 * @returns {string}
 */
function fitHeadline(text, maxLen = 30) {
  if (!text) return '';
  text = text.trim();
  if (text.length <= maxLen) return text;

  // Cut at last space that fits
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > 0) {
    return truncated.slice(0, lastSpace).trim();
  }
  // Single long word -- hard truncate
  return truncated.trim();
}

/**
 * Truncate text to fit within maxLen, cutting at the last word boundary.
 * Never returns a string longer than maxLen.
 *
 * @param {string} text
 * @param {number} [maxLen=90]
 * @returns {string}
 */
function fitDescription(text, maxLen = 90) {
  if (!text) return '';
  text = text.trim();
  if (text.length <= maxLen) return text;

  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > 0) {
    return truncated.slice(0, lastSpace).trim();
  }
  return truncated.trim();
}

/**
 * Remove duplicate headlines (case-insensitive). Returns an array of unique
 * headlines preserving original order.
 *
 * @param {string[]} headlines
 * @returns {string[]}
 */
function deduplicateHeadlines(headlines) {
  const seen = new Set();
  const result = [];
  for (const h of headlines) {
    const key = h.toLowerCase().trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(h);
    }
  }
  return result;
}

/**
 * Attempt to produce a headline that fits 30 chars using progressive
 * abbreviation strategies:
 *   1. Full form
 *   2. Use short alias for make
 *   3. Drop year
 *   4. Word-boundary truncation
 *
 * @param {string} template - A template string with optional {year}, {make}, {model}
 * @param {object} opts
 * @param {string} [opts.year]
 * @param {string} [opts.make]
 * @param {string} [opts.model]
 * @param {string} [opts.short] - Short alias for make
 * @param {string} [opts.dealer]
 * @param {string} [opts.city]
 * @param {number} [maxLen=30]
 * @returns {string}
 */
function smartFitHeadline(template, opts, maxLen = 30) {
  const { year, make, model, short, dealer, city } = opts;

  // Step 1: full form
  let text = template
    .replace(/\{year\}/gi, year || '')
    .replace(/\{make\}/gi, make || '')
    .replace(/\{model\}/gi, model || '')
    .replace(/\{dealer\}/gi, dealer || '')
    .replace(/\{city\}/gi, city || '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (text.length <= maxLen) return text;

  // Step 2: use short alias for make
  if (short && make) {
    text = template
      .replace(/\{year\}/gi, year || '')
      .replace(/\{make\}/gi, short)
      .replace(/\{model\}/gi, model || '')
      .replace(/\{dealer\}/gi, dealer || '')
      .replace(/\{city\}/gi, city || '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (text.length <= maxLen) return text;
  }

  // Step 3: drop year
  text = template
    .replace(/\{year\}\s*/gi, '')
    .replace(/\{make\}/gi, short || make || '')
    .replace(/\{model\}/gi, model || '')
    .replace(/\{dealer\}/gi, dealer || '')
    .replace(/\{city\}/gi, city || '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (text.length <= maxLen) return text;

  // Step 4: word-boundary truncation
  return fitHeadline(text, maxLen);
}

/**
 * Build a padded array of exactly `count` unique headlines. If the candidates
 * list has fewer than `count` unique entries after dedup, generic fillers are
 * appended from the provided pool.
 *
 * @param {string[]} candidates
 * @param {string[]} fillers
 * @param {number} count
 * @returns {string[]}
 */
function buildHeadlineList(candidates, fillers, count) {
  // Ensure every candidate respects the limit
  let all = candidates.map((h) => fitHeadline(h, 30));
  all = deduplicateHeadlines(all.filter(Boolean));

  if (all.length < count) {
    const extras = fillers.map((h) => fitHeadline(h, 30));
    for (const e of extras) {
      if (all.length >= count) break;
      if (!e) continue;
      if (!all.some((h) => h.toLowerCase() === e.toLowerCase())) {
        all.push(e);
      }
    }
  }

  // Final safety: hard-verify every headline
  return all.slice(0, count).map((h) => {
    if (h.length > 30) return fitHeadline(h, 30);
    return h;
  });
}

/**
 * Build a list of exactly `count` descriptions, each verified <= 90 chars.
 *
 * @param {string[]} candidates
 * @param {number} count
 * @returns {string[]}
 */
function buildDescriptionList(candidates, count) {
  return candidates
    .map((d) => fitDescription(d, 90))
    .filter(Boolean)
    .slice(0, count);
}

/* -------------------------------------------------------------------------- */
/*  GENERIC FILLER HEADLINES (no make/model)                                  */
/* -------------------------------------------------------------------------- */

const GENERIC_VALUE_HEADLINES = [
  'Huge Savings & Great Offers',
  'Exclusive Offers Available',
  'Local Incentives Available',
  'Special Financing Options',
  'Amazing Monthly Specials',
  'Low Prices Guaranteed',
  'Top Rated Customer Service',
  'Schedule Your Test Drive',
  'View Our Full Inventory',
  'Shop Online From Home',
  'Browse Our Showroom Today',
  'Find Your Perfect Ride',
];

/* -------------------------------------------------------------------------- */
/*  MODEL campaign generators                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Generate 15 RSA headlines for a Model campaign ad group.
 *
 * @param {object} opts
 * @param {string} opts.dealer - Dealership name
 * @param {string} opts.make  - e.g. "Chevrolet"
 * @param {string} opts.model - e.g. "Silverado"
 * @param {string} opts.year  - e.g. "2026"
 * @param {string} opts.city  - e.g. "Dallas"
 * @param {string} [opts.short] - Short alias, e.g. "Chevy"
 * @returns {string[]} Exactly 15 headlines, each <= 30 chars, unpinned
 */
function generateModelHeadlines(opts) {
  const { dealer, make, model, year, city } = opts;
  const short = opts.short || MAKE_ALIASES[make] || make;

  // Slots 1-5: model-specific
  const modelCandidates = [
    smartFitHeadline('New {year} {make} {model}', { ...opts, short }, 30),
    smartFitHeadline('{year} {model} For Sale', { ...opts, short }, 30),
    smartFitHeadline('{year} {make} {model} Deals', { ...opts, short }, 30),
    smartFitHeadline('Shop {year} {model} Today', { ...opts, short }, 30),
    smartFitHeadline('New {make} {model} In Stock', { ...opts, short }, 30),
    smartFitHeadline('{year} {model} Specials', { ...opts, short }, 30),
    smartFitHeadline('Browse {year} {model} Models', { ...opts, short }, 30),
    smartFitHeadline('{make} {model} Inventory', { ...opts, short }, 30),
  ];

  // Slots 6-10: value / offer
  const valueCandidates = [
    'Huge Savings & Great Offers',
    'Exclusive Offers Available',
    'Local Incentives Available',
    'Special Financing Options',
    'Amazing Monthly Specials',
    'Shop Online From Home',
    'Schedule Your Test Drive',
  ];

  // Slots 11-15: dealer / location
  const dealerCandidates = [
    smartFitHeadline('{dealer}', opts, 30),
    smartFitHeadline('Visit {dealer}', opts, 30),
    smartFitHeadline('Proudly Serving {city}', opts, 30),
    smartFitHeadline('{dealer} - {city}', opts, 30),
    'Visit Our Digital Showroom',
    'Your Local Dealer',
    smartFitHeadline('{city} Auto Dealer', opts, 30),
  ];

  const allCandidates = [
    ...modelCandidates,
    ...valueCandidates,
    ...dealerCandidates,
  ];

  return buildHeadlineList(allCandidates, GENERIC_VALUE_HEADLINES, 15);
}

/**
 * Generate 4 RSA descriptions for a Model campaign ad group.
 *
 * @param {object} opts
 * @param {string} opts.dealer
 * @param {string} opts.make
 * @param {string} opts.model
 * @param {string} opts.year
 * @param {string} opts.city
 * @returns {string[]} Exactly 4 descriptions, each <= 90 chars, unpinned
 */
function generateModelDescriptions(opts) {
  const { dealer, make, model, year, city } = opts;

  const candidates = [
    `View Our New ${year} ${model} Inventory. Awesome Monthly Specials Currently Going On!`,
    'Visit Our Digital Showroom Today For Exclusive Offers & To Schedule Your Test Drive Now!',
    `Huge Savings & Great Offers On The All New ${year} ${make} ${model} In Stock Today!`,
    `Proudly Serving ${city} & Its Surrounding Areas. Only at ${dealer}`,
  ];

  return buildDescriptionList(candidates, 4);
}

/* -------------------------------------------------------------------------- */
/*  BRAND campaign generators                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Generate 15 RSA headlines for a Brand campaign.
 * CRITICAL: Never include OEM make names.
 *
 * @param {object} opts
 * @param {string} opts.dealer
 * @param {string} opts.city
 * @returns {string[]} Exactly 15 headlines, each <= 30 chars, unpinned
 */
function generateBrandHeadlines(opts) {
  const { dealer, city } = opts;

  const candidates = [
    fitHeadline(dealer, 30),
    fitHeadline(`Visit ${dealer}`, 30),
    fitHeadline(`Proudly Serving ${city}`, 30),
    fitHeadline(`${dealer} - ${city}`, 30),
    'Huge Savings & Great Offers',
    'Exclusive Offers Available',
    'Local Incentives Available',
    'Special Financing Options',
    'Amazing Monthly Specials',
    'Visit Our Digital Showroom',
    'Shop Online From Home',
    'Schedule Your Test Drive',
    'Browse Our Inventory',
    'Top Rated Customer Service',
    'Your Local Dealer',
    fitHeadline(`${city} Auto Dealer`, 30),
    'Find Your Perfect Ride',
    'View Our Full Inventory',
    'Low Prices Guaranteed',
  ];

  return buildHeadlineList(candidates, GENERIC_VALUE_HEADLINES, 15);
}

/**
 * Generate 4 RSA descriptions for a Brand campaign.
 * CRITICAL: Never include OEM make names.
 *
 * @param {object} opts
 * @param {string} opts.dealer
 * @param {string} opts.city
 * @returns {string[]} Exactly 4 descriptions, each <= 90 chars, unpinned
 */
function generateBrandDescriptions(opts) {
  const { dealer, city } = opts;

  const candidates = [
    fitDescription(`Browse Our Full New & Pre-Owned Inventory. Awesome Monthly Specials Currently Going On!`, 90),
    'Visit Our Digital Showroom Today For Exclusive Offers & To Schedule Your Test Drive Now!',
    fitDescription(`Huge Savings & Great Offers On All New Vehicles In Stock Today!`, 90),
    fitDescription(`Proudly Serving ${city} & Its Surrounding Areas. Only at ${dealer}`, 90),
  ];

  return buildDescriptionList(candidates, 4);
}

/* -------------------------------------------------------------------------- */
/*  GENERAL TERMS campaign generators                                         */
/* -------------------------------------------------------------------------- */

/**
 * Generate 15 RSA headlines for a General Terms campaign.
 *
 * @param {object} opts
 * @param {string} opts.dealer
 * @param {string} opts.make
 * @param {string} opts.city
 * @returns {string[]} Exactly 15 headlines, each <= 30 chars, unpinned
 */
function generateGeneralHeadlines(opts) {
  const { dealer, make, city } = opts;
  const short = MAKE_ALIASES[make] || make;

  const candidates = [
    fitHeadline(`${short} Dealer In ${city}`, 30),
    fitHeadline(`New ${short} Vehicles`, 30),
    fitHeadline(`Shop ${short} Inventory`, 30),
    fitHeadline(`${short} Specials Near You`, 30),
    fitHeadline(`${short} Deals In ${city}`, 30),
    fitHeadline(dealer, 30),
    fitHeadline(`Visit ${dealer}`, 30),
    fitHeadline(`Proudly Serving ${city}`, 30),
    'Huge Savings & Great Offers',
    'Exclusive Offers Available',
    'Local Incentives Available',
    'Special Financing Options',
    'Amazing Monthly Specials',
    'Visit Our Digital Showroom',
    'Schedule Your Test Drive',
    'Shop Online From Home',
    fitHeadline(`${city} Auto Dealer`, 30),
    'Browse Our Inventory',
    'Your Local Dealer',
  ];

  return buildHeadlineList(candidates, GENERIC_VALUE_HEADLINES, 15);
}

/**
 * Generate 4 RSA descriptions for a General Terms campaign.
 *
 * @param {object} opts
 * @param {string} opts.dealer
 * @param {string} opts.make
 * @param {string} opts.city
 * @returns {string[]} Exactly 4 descriptions, each <= 90 chars, unpinned
 */
function generateGeneralDescriptions(opts) {
  const { dealer, make, city } = opts;
  const short = MAKE_ALIASES[make] || make;

  const candidates = [
    fitDescription(`Browse Our Full ${short} Inventory. Awesome Monthly Specials Currently Going On!`, 90),
    'Visit Our Digital Showroom Today For Exclusive Offers & To Schedule Your Test Drive Now!',
    fitDescription(`Huge Savings & Great Offers On All New ${short} Vehicles In Stock Today!`, 90),
    fitDescription(`Proudly Serving ${city} & Its Surrounding Areas. Only at ${dealer}`, 90),
  ];

  return buildDescriptionList(candidates, 4);
}

/* -------------------------------------------------------------------------- */
/*  COMPETITOR campaign generators                                            */
/* -------------------------------------------------------------------------- */

/**
 * Generate 15 RSA headlines for a Competitor campaign.
 *
 * @param {object} opts
 * @param {string} opts.dealer
 * @param {string} opts.make
 * @param {string} opts.city
 * @returns {string[]} Exactly 15 headlines, each <= 30 chars, unpinned
 */
function generateCompetitorHeadlines(opts) {
  const { dealer, make, city } = opts;
  const short = MAKE_ALIASES[make] || make;

  const candidates = [
    fitHeadline(`Compare ${short} Models`, 30),
    fitHeadline(`Why Choose ${short}?`, 30),
    fitHeadline(`Switch To ${short} Today`, 30),
    fitHeadline(`${short} vs The Competition`, 30),
    fitHeadline(`Explore New ${short} Vehicles`, 30),
    fitHeadline(dealer, 30),
    fitHeadline(`Visit ${dealer}`, 30),
    fitHeadline(`Proudly Serving ${city}`, 30),
    'Huge Savings & Great Offers',
    'Exclusive Offers Available',
    'Special Financing Options',
    'Amazing Monthly Specials',
    'Schedule Your Test Drive',
    'Visit Our Digital Showroom',
    'Top Rated Customer Service',
    'Shop Online From Home',
    fitHeadline(`${city} Auto Dealer`, 30),
    'Your Local Dealer',
  ];

  return buildHeadlineList(candidates, GENERIC_VALUE_HEADLINES, 15);
}

/**
 * Generate 4 RSA descriptions for a Competitor campaign.
 *
 * @param {object} opts
 * @param {string} opts.dealer
 * @param {string} opts.make
 * @param {string} opts.city
 * @returns {string[]} Exactly 4 descriptions, each <= 90 chars, unpinned
 */
function generateCompetitorDescriptions(opts) {
  const { dealer, make, city } = opts;
  const short = MAKE_ALIASES[make] || make;

  const candidates = [
    fitDescription(`See Why ${short} Outperforms The Competition. Browse Our Full Inventory Today!`, 90),
    'Visit Our Digital Showroom Today For Exclusive Offers & To Schedule Your Test Drive Now!',
    fitDescription(`Huge Savings & Great Offers On All New ${short} Vehicles In Stock Today!`, 90),
    fitDescription(`Proudly Serving ${city} & Its Surrounding Areas. Only at ${dealer}`, 90),
  ];

  return buildDescriptionList(candidates, 4);
}

/* -------------------------------------------------------------------------- */
/*  REGIONAL campaign generators                                              */
/* -------------------------------------------------------------------------- */

/**
 * Generate 15 RSA headlines for a Regional campaign.
 *
 * @param {object} opts
 * @param {string} opts.dealer
 * @param {string} opts.make
 * @param {string} opts.city
 * @returns {string[]} Exactly 15 headlines, each <= 30 chars, unpinned
 */
function generateRegionalHeadlines(opts) {
  const { dealer, make, city } = opts;
  const short = MAKE_ALIASES[make] || make;

  const candidates = [
    fitHeadline(`${short} Dealer In ${city}`, 30),
    fitHeadline(`${city} ${short} Dealer`, 30),
    fitHeadline(`New ${short} Near ${city}`, 30),
    fitHeadline(`${short} Inventory In ${city}`, 30),
    fitHeadline(`Shop ${short} In ${city}`, 30),
    fitHeadline(dealer, 30),
    fitHeadline(`Visit ${dealer}`, 30),
    fitHeadline(`Proudly Serving ${city}`, 30),
    fitHeadline(`${dealer} - ${city}`, 30),
    'Huge Savings & Great Offers',
    'Exclusive Offers Available',
    'Local Incentives Available',
    'Special Financing Options',
    'Amazing Monthly Specials',
    'Visit Our Digital Showroom',
    'Schedule Your Test Drive',
    fitHeadline(`${city} Auto Dealer`, 30),
    'Your Local Dealer',
  ];

  return buildHeadlineList(candidates, GENERIC_VALUE_HEADLINES, 15);
}

/**
 * Generate 4 RSA descriptions for a Regional campaign.
 *
 * @param {object} opts
 * @param {string} opts.dealer
 * @param {string} opts.make
 * @param {string} opts.city
 * @returns {string[]} Exactly 4 descriptions, each <= 90 chars, unpinned
 */
function generateRegionalDescriptions(opts) {
  const { dealer, make, city } = opts;
  const short = MAKE_ALIASES[make] || make;

  const candidates = [
    fitDescription(`Your Trusted ${short} Dealer Proudly Serving ${city} & Surrounding Areas!`, 90),
    'Visit Our Digital Showroom Today For Exclusive Offers & To Schedule Your Test Drive Now!',
    fitDescription(`Huge Savings & Great Offers On All New ${short} Vehicles In Stock In ${city}!`, 90),
    fitDescription(`Proudly Serving ${city} & Its Surrounding Areas. Only at ${dealer}`, 90),
  ];

  return buildDescriptionList(candidates, 4);
}

/* -------------------------------------------------------------------------- */
/*  Exports                                                                   */
/* -------------------------------------------------------------------------- */

module.exports = {
  generateModelHeadlines,
  generateModelDescriptions,
  generateBrandHeadlines,
  generateBrandDescriptions,
  generateGeneralHeadlines,
  generateGeneralDescriptions,
  generateCompetitorHeadlines,
  generateCompetitorDescriptions,
  generateRegionalHeadlines,
  generateRegionalDescriptions,
  fitHeadline,
  fitDescription,
  MAKE_ALIASES,
};
