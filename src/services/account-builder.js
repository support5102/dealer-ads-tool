'use strict';

/**
 * Account Builder — generates complete Google Ads Editor CSV rows for a full
 * dealer search account.
 *
 * Extracted from client-side builder.html buildRows(), with all bugs fixed per
 * the Savvy Dealer strategy.
 *
 * Campaign types produced:
 *   1. Model campaigns (one per model)
 *   2. General Terms (one per make)
 *   3. Brand (one per account)
 *   4. Competitor (if competitors provided)
 *   5. Regional (if nearby cities provided)
 *
 * Critical rules enforced:
 *   - NO pinned headline/description positions (all "-")
 *   - NO keyword-level Max CPC (inherits from ad group)
 *   - Brand CPC = $3, all others = $9
 *   - Brand keywords = dealer name ONLY, never OEM makes
 *   - All AI features disabled on every campaign
 *   - Targeting: Location of presence only
 *   - Ad schedule: Mon-Fri 8:30-19:00, Sat 8:30-20:30
 *
 * @module account-builder
 */

const { buildInventoryUrl, parseTpl } = require('../services/url-generator');
const {
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
} = require('../services/headline-generator');
const {
  DEFAULT_CPC,
  getCompetingMakes,
  UNIVERSAL_NEGATIVES,
  ALL_KNOWN_MAKES,
  MAKE_COMBOS,
} = require('../services/strategy-rules');
const { blankRow } = require('../utils/ads-editor-columns');

// ---------------------------------------------------------------------------
// MODEL_MASTER — all makes/models
// ---------------------------------------------------------------------------

const MODEL_MASTER = {
  Chrysler: ['Pacifica', 'Pacifica Hybrid', 'Voyager'],
  Dodge: ['Charger', 'Durango', 'Hornet'],
  Jeep: ['Wrangler', 'Gladiator', 'Cherokee', 'Grand Cherokee', 'Grand Cherokee L', 'Compass', 'Renegade', 'Wagoneer', 'Grand Wagoneer'],
  Ram: ['1500', '2500', '3500', 'ProMaster', 'ProMaster City'],
  Chevrolet: ['Silverado 1500', 'Silverado 2500HD', 'Silverado 3500HD', 'Colorado', 'Equinox', 'Trax', 'Trailblazer', 'Blazer', 'Traverse', 'Tahoe', 'Suburban', 'Corvette', 'Malibu', 'Camaro'],
  Buick: ['Encore GX', 'Envista', 'Envision', 'Enclave'],
  GMC: ['Sierra 1500', 'Sierra 2500HD', 'Sierra 3500HD', 'Canyon', 'Terrain', 'Acadia', 'Yukon', 'Yukon XL'],
  Cadillac: ['CT4', 'CT5', 'XT4', 'XT5', 'XT6', 'Escalade', 'Escalade ESV', 'Lyriq'],
  Ford: ['F-150', 'F-250 Super Duty', 'F-350 Super Duty', 'Maverick', 'Ranger', 'Bronco', 'Bronco Sport', 'Escape', 'Explorer', 'Expedition', 'Mustang', 'Mustang Mach-E', 'Edge'],
  Lincoln: ['Corsair', 'Nautilus', 'Aviator', 'Navigator'],
  Toyota: ['Camry', 'Corolla', 'Corolla Hatchback', 'Corolla Cross', 'Crown', 'Prius', 'GR86', 'GR Corolla', 'GR Supra', 'RAV4', 'RAV4 Hybrid', 'RAV4 Prime', 'Highlander', 'Grand Highlander', '4Runner', 'Sequoia', 'Land Cruiser', 'Tacoma', 'Tundra', 'Sienna', 'bZ4X'],
  Lexus: ['IS', 'ES', 'LS', 'RC', 'LC', 'RZ', 'UX', 'NX', 'RX', 'GX', 'LX'],
  Honda: ['Civic', 'Accord', 'HR-V', 'CR-V', 'Passport', 'Pilot', 'Ridgeline', 'Odyssey'],
  Acura: ['Integra', 'TLX', 'MDX', 'RDX', 'ZDX'],
  Hyundai: ['Elantra', 'Sonata', 'Tucson', 'Santa Fe', 'Palisade', 'Kona', 'Venue', 'Santa Cruz', 'Ioniq 5', 'Ioniq 6'],
  Kia: ['Forte', 'K5', 'Sportage', 'Sorento', 'Telluride', 'Soul', 'Seltos', 'Carnival', 'EV6', 'EV9'],
  Genesis: ['G70', 'G80', 'G90', 'GV70', 'GV80', 'GV60'],
  Nissan: ['Sentra', 'Altima', 'Kicks', 'Rogue', 'Murano', 'Pathfinder', 'Armada', 'Frontier', 'Titan', 'Ariya', 'LEAF'],
  Infiniti: ['Q50', 'Q60', 'QX50', 'QX55', 'QX60', 'QX80'],
  Volkswagen: ['Jetta', 'Tiguan', 'Atlas', 'Atlas Cross Sport', 'ID.4', 'Taos', 'Golf GTI', 'Golf R'],
  Audi: ['A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'Q3', 'Q5', 'Q7', 'Q8', 'e-tron GT'],
  Subaru: ['Impreza', 'Legacy', 'Outback', 'Forester', 'Crosstrek', 'Ascent', 'Solterra', 'BRZ', 'WRX'],
  Mazda: ['Mazda3', 'CX-5', 'CX-50', 'CX-70', 'CX-90', 'MX-5 Miata'],
  BMW: ['2 Series', '3 Series', '4 Series', '5 Series', '7 Series', 'X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'iX', 'M3', 'M4'],
  'Mercedes-Benz': ['C-Class', 'E-Class', 'S-Class', 'GLA', 'GLB', 'GLC', 'GLE', 'GLS', 'G-Class'],
  Volvo: ['S60', 'S90', 'XC40', 'XC60', 'XC90', 'EX40', 'EX90'],
  Porsche: ['718', '911', 'Panamera', 'Macan', 'Cayenne', 'Taycan'],
};

// ---------------------------------------------------------------------------
// Ad schedule string (Google Ads Editor format)
// ---------------------------------------------------------------------------

const AD_SCHEDULE =
  '(Monday[08:30-19:00]);(Tuesday[08:30-19:00]);(Wednesday[08:30-19:00]);' +
  '(Thursday[08:30-19:00]);(Friday[08:30-19:00]);(Saturday[08:30-20:30])';

// ---------------------------------------------------------------------------
// Helper: build a campaign row with all mandatory fields
// ---------------------------------------------------------------------------

/**
 * Create a campaign-level row with all required defaults.
 * EVERY campaign row gets AI features disabled, targeting = location of
 * presence, manual CPC, enhanced CPC disabled, broad match off, etc.
 */
function makeCampaignRow(campaignName, opts = {}) {
  const row = blankRow();
  row['Campaign'] = campaignName;
  row['Campaign Type'] = 'Search';
  row['Networks'] = 'Google search';
  row['Budget name'] = opts.budgetName || campaignName;
  row['Budget'] = opts.budget || '';
  row['Budget type'] = 'Daily';
  row['EU political ads'] = "Doesn't have EU political ads";
  row['Standard conversion goals'] = 'Account-level';
  row['Customer acquisition'] = 'Bid equally';
  row['Languages'] = 'en';
  row['Bid Strategy Type'] = 'Manual CPC';
  row['Enhanced CPC'] = 'Disabled';
  row['Broad match keywords'] = 'Off';
  row['Ad rotation'] = 'Optimize for clicks';
  row['Targeting method'] = 'Location of presence';
  row['Exclusion method'] = 'Location of presence';

  // ALL AI features DISABLED on every campaign
  row['AI Max'] = 'Disabled';
  row['Text customization'] = 'Disabled';
  row['Final URL expansion'] = 'Disabled';
  row['Image enhancement'] = 'Disabled';
  row['Image generation'] = 'Disabled';
  row['Landing page images'] = 'Disabled';
  row['Video enhancement'] = 'Disabled';
  row['Brand guidelines'] = 'Disabled';

  row['Campaign Status'] = opts.status || 'Enabled';
  row['Start Date'] = opts.startDate || '';
  row['Ad Schedule'] = AD_SCHEDULE;

  return row;
}

// ---------------------------------------------------------------------------
// Helper: build an ad group row
// ---------------------------------------------------------------------------

function makeAdGroupRow(campaignName, adGroupName, maxCpc) {
  const row = blankRow();
  row['Campaign'] = campaignName;
  row['Ad Group'] = adGroupName;
  row['Max CPC'] = String(maxCpc);
  row['Languages'] = 'All';
  row['Audience targeting'] = 'Audience segments';
  row['Flexible Reach'] = 'Audience segments;Genders;Ages;Parental status;Household incomes';
  row['Max CPM'] = '0.01';
  row['Target CPV'] = '0.01';
  row['Target CPM'] = '0.01';
  row['Optimized targeting'] = 'Disabled';
  row['Strict age and gender targeting'] = 'Disabled';
  row['Search term matching'] = 'Enabled';
  row['Ad Group Type'] = 'Standard';
  row['Campaign Status'] = 'Enabled';
  row['Ad Group Status'] = 'Enabled';
  return row;
}

// ---------------------------------------------------------------------------
// Helper: build a keyword row (NEVER set Max CPC on keywords)
// ---------------------------------------------------------------------------

function makeKeywordRow(campaignName, adGroupName, keyword, criterionType) {
  const row = blankRow();
  row['Campaign'] = campaignName;
  row['Ad Group'] = adGroupName;
  row['Keyword'] = keyword;
  row['Criterion Type'] = criterionType; // 'Exact', 'Phrase', 'Negative Phrase', 'Negative Exact'
  // IMPORTANT: Do NOT set Max CPC — keywords inherit from ad group
  if (criterionType && !criterionType.startsWith('Negative')) {
    row['Campaign Status'] = 'Enabled';
    row['Ad Group Status'] = 'Enabled';
    row['Status'] = 'Enabled';
  }
  return row;
}

// ---------------------------------------------------------------------------
// Helper: build a campaign-level negative keyword row
// ---------------------------------------------------------------------------

function makeCampaignNegativeRow(campaignName, keyword, matchType) {
  const row = blankRow();
  row['Campaign'] = campaignName;
  row['Keyword'] = keyword;
  row['Criterion Type'] = matchType; // 'Negative Phrase' or 'Negative Exact'
  return row;
}

// ---------------------------------------------------------------------------
// Helper: build an RSA ad row — ALL positions are "-" (NEVER pinned)
// ---------------------------------------------------------------------------

function makeAdRow(campaignName, adGroupName, headlines, descriptions, finalUrl, path1, path2) {
  const row = blankRow();
  row['Campaign'] = campaignName;
  row['Ad Group'] = adGroupName;
  row['Ad type'] = 'Responsive search ad';

  // Fill headlines 1-15
  for (let i = 0; i < 15; i++) {
    const num = i + 1;
    row[`Headline ${num}`] = (headlines && headlines[i]) || '';
    row[`Headline ${num} position`] = '-'; // NEVER pinned
  }

  // Fill descriptions 1-4
  for (let i = 0; i < 4; i++) {
    const num = i + 1;
    row[`Description ${num}`] = (descriptions && descriptions[i]) || '';
    row[`Description ${num} position`] = '-'; // NEVER pinned
  }

  row['Path 1'] = path1 || '';
  row['Path 2'] = path2 || '';
  row['Final URL'] = finalUrl || '';
  row['Campaign Status'] = 'Enabled';
  row['Ad Group Status'] = 'Enabled';
  row['Status'] = 'Enabled';
  return row;
}

// ---------------------------------------------------------------------------
// Helper: build a location/radius row
// ---------------------------------------------------------------------------

function makeLocationRow(campaignName, lat, lng, radius) {
  const row = blankRow();
  row['Campaign'] = campaignName;
  row['Location'] = `(${radius}mi:${Number(lat).toFixed(6)}:${Number(lng).toFixed(6)})`;
  row['Radius'] = String(radius);
  row['Unit'] = 'mi';
  row['Campaign Status'] = 'Enabled';
  row['Status'] = 'Enabled';
  return row;
}

// ---------------------------------------------------------------------------
// Helper: resolve the final URL for a model
// ---------------------------------------------------------------------------

function resolveModelUrl(group, model) {
  // If the model has a custom URL, use it directly
  if (model.customUrl) return model.customUrl;

  // If a template URL is provided, parse it with make/model substitution
  if (group.templateUrl) {
    try {
      return parseTpl(group.templateUrl, model.name, group.make);
    } catch (_) {
      // Fall through to buildInventoryUrl
    }
  }

  // Default: build from baseUrl and siteType
  if (group.baseUrl) {
    try {
      return buildInventoryUrl(group.baseUrl, group.make, model.name, {
        siteType: group.siteType,
        condition: 'new',
      });
    } catch (_) {
      // If all else fails, return baseUrl as-is
      return group.baseUrl;
    }
  }

  return '';
}

// ---------------------------------------------------------------------------
// Helper: collect all makes the dealer sells (lowercased)
// ---------------------------------------------------------------------------

function getDealerMakes(groups) {
  const makes = new Set();
  for (const g of groups) {
    if (g.make) {
      makes.add(g.make.toLowerCase());
      const alias = MAKE_ALIASES[g.make];
      if (alias) makes.add(alias.toLowerCase());
    }
  }
  return makes;
}

// ---------------------------------------------------------------------------
// Helper: collect all model names across all groups (lowercased)
// ---------------------------------------------------------------------------

function getAllModelNames(groups) {
  const names = new Set();
  for (const g of groups) {
    for (const m of (g.models || [])) {
      if (m.name) names.add(m.name.toLowerCase());
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Helper: makes the dealer does NOT sell — used for cross-make negatives
// ---------------------------------------------------------------------------

function getMakesNotSold(dealerMakes) {
  return ALL_KNOWN_MAKES.filter(m => !dealerMakes.has(m));
}

// ---------------------------------------------------------------------------
// Model campaign ad group definitions
// ---------------------------------------------------------------------------

/**
 * Returns 20 ad group definitions for a model campaign:
 *   6 year1 groups, 6 year2 groups, 8 generic groups.
 *
 * Each definition has: { name, keywords: [{text, matchType}] }
 */
function getModelAdGroups(make, model, year1, year2) {
  const short = MAKE_ALIASES[make] || make;
  const adGroups = [];

  // Year-specific groups (6 per year)
  for (const year of [year1, year2]) {
    if (!year) continue;
    adGroups.push({
      name: `${year} ${make} ${model}`,
      keywords: [
        { text: `${year} ${make} ${model}`, type: 'Exact' },
        { text: `${year} ${make} ${model}`, type: 'Phrase' },
      ],
    });
    adGroups.push({
      name: `${year} ${model}`,
      keywords: [
        { text: `${year} ${model}`, type: 'Exact' },
        { text: `${year} ${model}`, type: 'Phrase' },
      ],
    });
    adGroups.push({
      name: `${year} ${model} for sale`,
      keywords: [
        { text: `${year} ${model} for sale`, type: 'Exact' },
        { text: `${year} ${model} for sale`, type: 'Phrase' },
      ],
    });
    // Short alias groups when different from make
    if (short !== make) {
      adGroups.push({
        name: `${year} ${short} ${model}`,
        keywords: [
          { text: `${year} ${short} ${model}`, type: 'Exact' },
          { text: `${year} ${short} ${model}`, type: 'Phrase' },
        ],
      });
      adGroups.push({
        name: `${year} ${short} ${model} for sale`,
        keywords: [
          { text: `${year} ${short} ${model} for sale`, type: 'Exact' },
          { text: `${year} ${short} ${model} for sale`, type: 'Phrase' },
        ],
      });
      adGroups.push({
        name: `${year} ${short} ${model} deals`,
        keywords: [
          { text: `${year} ${short} ${model} deals`, type: 'Exact' },
          { text: `${year} ${short} ${model} deals`, type: 'Phrase' },
        ],
      });
    } else {
      adGroups.push({
        name: `${year} ${make} ${model} for sale`,
        keywords: [
          { text: `${year} ${make} ${model} for sale`, type: 'Exact' },
          { text: `${year} ${make} ${model} for sale`, type: 'Phrase' },
        ],
      });
      adGroups.push({
        name: `${year} ${make} ${model} deals`,
        keywords: [
          { text: `${year} ${make} ${model} deals`, type: 'Exact' },
          { text: `${year} ${make} ${model} deals`, type: 'Phrase' },
        ],
      });
      adGroups.push({
        name: `${year} ${make} ${model} price`,
        keywords: [
          { text: `${year} ${make} ${model} price`, type: 'Exact' },
          { text: `${year} ${make} ${model} price`, type: 'Phrase' },
        ],
      });
    }
  }

  // Generic (no year) groups — 8 groups
  adGroups.push({
    name: `${make} ${model}`,
    keywords: [
      { text: `${make} ${model}`, type: 'Exact' },
      { text: `${make} ${model}`, type: 'Phrase' },
    ],
  });
  adGroups.push({
    name: `new ${make} ${model}`,
    keywords: [
      { text: `new ${make} ${model}`, type: 'Exact' },
      { text: `new ${make} ${model}`, type: 'Phrase' },
    ],
  });
  adGroups.push({
    name: `${model} for sale`,
    keywords: [
      { text: `${model} for sale`, type: 'Exact' },
      { text: `${model} for sale`, type: 'Phrase' },
    ],
  });
  adGroups.push({
    name: `${make} ${model} for sale`,
    keywords: [
      { text: `${make} ${model} for sale`, type: 'Exact' },
      { text: `${make} ${model} for sale`, type: 'Phrase' },
    ],
  });
  adGroups.push({
    name: `${make} ${model} deals`,
    keywords: [
      { text: `${make} ${model} deals`, type: 'Exact' },
      { text: `${make} ${model} deals`, type: 'Phrase' },
    ],
  });
  adGroups.push({
    name: `${make} ${model} lease`,
    keywords: [
      { text: `${make} ${model} lease`, type: 'Exact' },
      { text: `${make} ${model} lease`, type: 'Phrase' },
    ],
  });
  adGroups.push({
    name: `${make} ${model} price`,
    keywords: [
      { text: `${make} ${model} price`, type: 'Exact' },
      { text: `${make} ${model} price`, type: 'Phrase' },
    ],
  });
  adGroups.push({
    name: `${make} ${model} specials`,
    keywords: [
      { text: `${make} ${model} specials`, type: 'Exact' },
      { text: `${make} ${model} specials`, type: 'Phrase' },
    ],
  });

  // If short alias differs, add extra generic alias groups
  if (short !== make) {
    // Replace some generic groups with alias equivalents
    adGroups.push({
      name: `${short} ${model}`,
      keywords: [
        { text: `${short} ${model}`, type: 'Exact' },
        { text: `${short} ${model}`, type: 'Phrase' },
      ],
    });
    adGroups.push({
      name: `new ${short} ${model}`,
      keywords: [
        { text: `new ${short} ${model}`, type: 'Exact' },
        { text: `new ${short} ${model}`, type: 'Phrase' },
      ],
    });
  }

  // Cap at 20 ad groups
  return adGroups.slice(0, 20);
}

// ---------------------------------------------------------------------------
// General Terms ad group definitions
// ---------------------------------------------------------------------------

function getGeneralAdGroups(make) {
  const short = MAKE_ALIASES[make] || make;

  const groups = [
    {
      name: `${make} dealer`,
      keywords: [
        { text: `${make} dealer`, type: 'Exact' },
        { text: `${make} dealer`, type: 'Phrase' },
      ],
    },
    {
      name: `${make} dealership`,
      keywords: [
        { text: `${make} dealership`, type: 'Exact' },
        { text: `${make} dealership`, type: 'Phrase' },
      ],
    },
    {
      name: `${make} near me`,
      keywords: [
        { text: `${make} near me`, type: 'Exact' },
        { text: `${make} near me`, type: 'Phrase' },
      ],
    },
    {
      name: `new ${make} for sale`,
      keywords: [
        { text: `new ${make} for sale`, type: 'Exact' },
        { text: `new ${make} for sale`, type: 'Phrase' },
      ],
    },
    {
      name: `${make} lease deals`,
      keywords: [
        { text: `${make} lease deals`, type: 'Exact' },
        { text: `${make} lease deals`, type: 'Phrase' },
      ],
    },
    {
      name: `${make} financing`,
      keywords: [
        { text: `${make} financing`, type: 'Exact' },
        { text: `${make} financing`, type: 'Phrase' },
      ],
    },
    {
      name: `${make} specials`,
      keywords: [
        { text: `${make} specials`, type: 'Exact' },
        { text: `${make} specials`, type: 'Phrase' },
      ],
    },
    {
      name: `${make} deals`,
      keywords: [
        { text: `${make} deals`, type: 'Exact' },
        { text: `${make} deals`, type: 'Phrase' },
      ],
    },
  ];

  // Add short alias groups if different
  if (short !== make) {
    groups.push({
      name: `${short} dealer`,
      keywords: [
        { text: `${short} dealer`, type: 'Exact' },
        { text: `${short} dealer`, type: 'Phrase' },
      ],
    });
    groups.push({
      name: `${short} dealership`,
      keywords: [
        { text: `${short} dealership`, type: 'Exact' },
        { text: `${short} dealership`, type: 'Phrase' },
      ],
    });
    groups.push({
      name: `${short} near me`,
      keywords: [
        { text: `${short} near me`, type: 'Exact' },
        { text: `${short} near me`, type: 'Phrase' },
      ],
    });
    groups.push({
      name: `${short} for sale`,
      keywords: [
        { text: `${short} for sale`, type: 'Exact' },
        { text: `${short} for sale`, type: 'Phrase' },
      ],
    });
  } else {
    // Fill to 12 with year-based groups
    groups.push({
      name: `new ${make} inventory`,
      keywords: [
        { text: `new ${make} inventory`, type: 'Exact' },
        { text: `new ${make} inventory`, type: 'Phrase' },
      ],
    });
    groups.push({
      name: `${make} dealer near me`,
      keywords: [
        { text: `${make} dealer near me`, type: 'Exact' },
        { text: `${make} dealer near me`, type: 'Phrase' },
      ],
    });
    groups.push({
      name: `buy ${make}`,
      keywords: [
        { text: `buy ${make}`, type: 'Exact' },
        { text: `buy ${make}`, type: 'Phrase' },
      ],
    });
    groups.push({
      name: `${make} prices`,
      keywords: [
        { text: `${make} prices`, type: 'Exact' },
        { text: `${make} prices`, type: 'Phrase' },
      ],
    });
  }

  return groups.slice(0, 12);
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build complete Google Ads Editor CSV rows for a dealer account.
 *
 * @param {Object} opts - Account configuration
 * @param {string} opts.dealer - Dealer name
 * @param {string} opts.city - Dealer city
 * @param {string} opts.state - Dealer state
 * @param {Array} opts.groups - Make groups with models
 * @param {string} opts.startDate - ISO date
 * @param {string[]} [opts.competitors] - Competitor dealer names
 * @param {Array} [opts.locations] - [{lat, lng, radius}]
 * @param {string[]} [opts.nearbyCities] - Nearby city names for Regional campaign
 * @param {string[]} [opts.dealerGroup] - Sibling dealer names for brand negatives
 * @returns {Object[]} Array of CSV row objects
 */
function buildRows(opts) {
  const {
    dealer,
    city,
    state,
    groups = [],
    startDate,
    competitors = [],
    locations = [],
    nearbyCities = [],
    dealerGroup = [],
  } = opts;

  const rows = [];
  const dealerMakes = getDealerMakes(groups);
  const allModels = getAllModelNames(groups);
  const makesNotSold = getMakesNotSold(dealerMakes);

  // Collect all campaign names for cross-campaign negatives
  const allCampaignNames = [];

  // -----------------------------------------------------------------------
  // 1. MODEL CAMPAIGNS — one per model
  // -----------------------------------------------------------------------

  for (const group of groups) {
    const make = group.make;
    const short = MAKE_ALIASES[make] || make;

    for (const model of (group.models || [])) {
      const modelName = model.name;
      const year1 = model.year1 || '';
      const year2 = model.year2 || '';
      const campaignName = `${dealer} - New - ${make} - ${modelName}`;
      allCampaignNames.push(campaignName);

      // Determine campaign status based on stock
      const stock = parseInt(model.stock, 10) || 0;
      const campStatus = stock >= 4 ? 'Enabled' : 'Paused';

      // Campaign row
      rows.push(makeCampaignRow(campaignName, {
        startDate,
        status: campStatus,
      }));

      // Location rows
      for (const loc of locations) {
        rows.push(makeLocationRow(campaignName, loc.lat, loc.lng, loc.radius));
      }

      // Cross-make negatives at campaign level
      for (const negMake of makesNotSold) {
        rows.push(makeCampaignNegativeRow(campaignName, negMake, 'Negative Phrase'));
      }

      // Also negative other makes the dealer DOES sell (cross-make sculpting)
      // so the Ford campaign doesn't trigger on Chevy searches
      for (const otherGroup of groups) {
        if (otherGroup.make.toLowerCase() !== make.toLowerCase()) {
          rows.push(makeCampaignNegativeRow(campaignName, otherGroup.make.toLowerCase(), 'Negative Phrase'));
          const otherAlias = MAKE_ALIASES[otherGroup.make];
          if (otherAlias) {
            rows.push(makeCampaignNegativeRow(campaignName, otherAlias.toLowerCase(), 'Negative Phrase'));
          }
        }
      }

      // Universal negatives at campaign level
      for (const neg of UNIVERSAL_NEGATIVES) {
        rows.push(makeCampaignNegativeRow(campaignName, neg, 'Negative Phrase'));
      }

      // Resolve URL for this model
      const finalUrl = resolveModelUrl(group, model);

      // Path values for ads
      const path1 = fitHeadline(make, 15) || '';
      const path2 = fitHeadline(modelName, 15) || '';

      // Ad groups — 20 per model
      const adGroupDefs = getModelAdGroups(make, modelName, year1, year2);
      const maxCpc = DEFAULT_CPC.new_high; // $9 for model campaigns

      for (const agDef of adGroupDefs) {
        const agName = agDef.name;

        // Ad group row
        rows.push(makeAdGroupRow(campaignName, agName, maxCpc));

        // Keyword rows — NEVER set Max CPC on keywords
        for (const kw of agDef.keywords) {
          rows.push(makeKeywordRow(campaignName, agName, kw.text, kw.type));
        }

        // Traffic sculpting negatives at ad group level:
        // Negative other model names in this ad group so specific model
        // campaigns don't steal each other's traffic
        for (const otherModel of (group.models || [])) {
          if (otherModel.name.toLowerCase() !== modelName.toLowerCase()) {
            rows.push(makeKeywordRow(campaignName, agName, otherModel.name.toLowerCase(), 'Negative Phrase'));
          }
        }

        // RSA ad
        const hlOpts = { dealer, make, model: modelName, year: year1 || year2, city, short };
        const headlines = generateModelHeadlines(hlOpts);
        const descriptions = generateModelDescriptions(hlOpts);
        rows.push(makeAdRow(campaignName, agName, headlines, descriptions, finalUrl, path1, path2));
      }
    }
  }

  // -----------------------------------------------------------------------
  // 2. GENERAL TERMS — one per make
  // -----------------------------------------------------------------------

  for (const group of groups) {
    const make = group.make;
    const short = MAKE_ALIASES[make] || make;
    const campaignName = `${dealer} - New - ${make} - General Terms`;
    allCampaignNames.push(campaignName);

    // Campaign row
    rows.push(makeCampaignRow(campaignName, { startDate, status: 'Enabled' }));

    // Location rows
    for (const loc of locations) {
      rows.push(makeLocationRow(campaignName, loc.lat, loc.lng, loc.radius));
    }

    // Cross-make negatives
    for (const negMake of makesNotSold) {
      rows.push(makeCampaignNegativeRow(campaignName, negMake, 'Negative Phrase'));
    }
    for (const otherGroup of groups) {
      if (otherGroup.make.toLowerCase() !== make.toLowerCase()) {
        rows.push(makeCampaignNegativeRow(campaignName, otherGroup.make.toLowerCase(), 'Negative Phrase'));
        const otherAlias = MAKE_ALIASES[otherGroup.make];
        if (otherAlias) {
          rows.push(makeCampaignNegativeRow(campaignName, otherAlias.toLowerCase(), 'Negative Phrase'));
        }
      }
    }

    // Negative all specific model names so General doesn't steal model traffic
    for (const m of (group.models || [])) {
      rows.push(makeCampaignNegativeRow(campaignName, m.name.toLowerCase(), 'Negative Phrase'));
    }

    // Universal negatives
    for (const neg of UNIVERSAL_NEGATIVES) {
      rows.push(makeCampaignNegativeRow(campaignName, neg, 'Negative Phrase'));
    }

    // Base URL for general (just the base URL, no model path)
    const generalUrl = group.baseUrl || '';

    const path1 = fitHeadline(make, 15) || '';
    const path2 = 'New';

    // Ad groups
    const generalAgDefs = getGeneralAdGroups(make);
    const maxCpc = DEFAULT_CPC.general; // $9

    for (const agDef of generalAgDefs) {
      const agName = agDef.name;

      rows.push(makeAdGroupRow(campaignName, agName, maxCpc));

      for (const kw of agDef.keywords) {
        rows.push(makeKeywordRow(campaignName, agName, kw.text, kw.type));
      }

      // RSA ad
      const headlines = generateGeneralHeadlines({ dealer, make, city });
      const descriptions = generateGeneralDescriptions({ dealer, make, city });
      rows.push(makeAdRow(campaignName, agName, headlines, descriptions, generalUrl, path1, path2));
    }
  }

  // -----------------------------------------------------------------------
  // 3. BRAND CAMPAIGN — one per account
  // -----------------------------------------------------------------------

  {
    const campaignName = `${dealer} - Brand`;
    allCampaignNames.push(campaignName);

    // Campaign row
    rows.push(makeCampaignRow(campaignName, { startDate, status: 'Enabled' }));

    // Location rows
    for (const loc of locations) {
      rows.push(makeLocationRow(campaignName, loc.lat, loc.lng, loc.radius));
    }

    // Brand negatives: all competitor dealers
    for (const comp of competitors) {
      if (comp) {
        rows.push(makeCampaignNegativeRow(campaignName, comp.toLowerCase(), 'Negative Phrase'));
      }
    }

    // Brand negatives: dealer group siblings
    for (const sibling of dealerGroup) {
      if (sibling && sibling.toLowerCase() !== dealer.toLowerCase()) {
        rows.push(makeCampaignNegativeRow(campaignName, sibling.toLowerCase(), 'Negative Phrase'));
      }
    }

    // Brand negatives: all model names (so brand doesn't steal model traffic)
    for (const modelName of allModels) {
      rows.push(makeCampaignNegativeRow(campaignName, modelName, 'Negative Phrase'));
    }

    // Brand negatives: all makes the dealer does NOT sell
    for (const negMake of makesNotSold) {
      rows.push(makeCampaignNegativeRow(campaignName, negMake, 'Negative Phrase'));
    }

    // Universal negatives
    for (const neg of UNIVERSAL_NEGATIVES) {
      rows.push(makeCampaignNegativeRow(campaignName, neg, 'Negative Phrase'));
    }

    // Brand ad group — ONLY dealer name as keywords, NEVER OEM make names
    const brandAgName = dealer;
    const brandCpc = DEFAULT_CPC.brand; // $3

    rows.push(makeAdGroupRow(campaignName, brandAgName, brandCpc));

    // Keywords: dealer name only (Exact + Phrase)
    rows.push(makeKeywordRow(campaignName, brandAgName, dealer, 'Exact'));
    rows.push(makeKeywordRow(campaignName, brandAgName, dealer, 'Phrase'));

    // If dealer name has common variations, add those too — but ONLY if the
    // variation doesn't reduce to a bare OEM make name (brand must never
    // contain make-only keywords)
    const dealerLower = dealer.toLowerCase();
    if (dealerLower.includes(' of ')) {
      const variation = dealer.replace(/ of /gi, ' ');
      // Safety check: ensure the variation isn't just an OEM make + city
      const variationLower = variation.toLowerCase().trim();
      const startsWithMake = ALL_KNOWN_MAKES.some(m =>
        variationLower.startsWith(m + ' ') || variationLower === m
      );
      if (!startsWithMake) {
        rows.push(makeKeywordRow(campaignName, brandAgName, variation, 'Exact'));
        rows.push(makeKeywordRow(campaignName, brandAgName, variation, 'Phrase'));
      }
    }

    // Brand URL = first group's base URL
    const brandUrl = (groups[0] && groups[0].baseUrl) || '';

    const headlines = generateBrandHeadlines({ dealer, city });
    const descriptions = generateBrandDescriptions({ dealer, city });
    rows.push(makeAdRow(campaignName, brandAgName, headlines, descriptions, brandUrl, fitHeadline(dealer, 15), ''));
  }

  // -----------------------------------------------------------------------
  // 4. COMPETITOR CAMPAIGN — if competitors provided
  // -----------------------------------------------------------------------

  if (competitors.length > 0) {
    const campaignName = `${dealer} - Competitor`;
    allCampaignNames.push(campaignName);

    // Campaign row
    rows.push(makeCampaignRow(campaignName, { startDate, status: 'Enabled' }));

    // Location rows
    for (const loc of locations) {
      rows.push(makeLocationRow(campaignName, loc.lat, loc.lng, loc.radius));
    }

    // Cross-make negatives
    for (const negMake of makesNotSold) {
      rows.push(makeCampaignNegativeRow(campaignName, negMake, 'Negative Phrase'));
    }

    // Universal negatives
    for (const neg of UNIVERSAL_NEGATIVES) {
      rows.push(makeCampaignNegativeRow(campaignName, neg, 'Negative Phrase'));
    }

    // Negative the dealer's own name so competitor campaign doesn't show for brand searches
    rows.push(makeCampaignNegativeRow(campaignName, dealer.toLowerCase(), 'Negative Phrase'));

    const compCpc = DEFAULT_CPC.competitor; // $9
    const compUrl = (groups[0] && groups[0].baseUrl) || '';
    const primaryMake = (groups[0] && groups[0].make) || '';

    for (const comp of competitors) {
      if (!comp) continue;
      const agName = comp;

      rows.push(makeAdGroupRow(campaignName, agName, compCpc));

      // Keywords: competitor name Exact + Phrase (NEVER set Max CPC on keywords)
      rows.push(makeKeywordRow(campaignName, agName, comp, 'Exact'));
      rows.push(makeKeywordRow(campaignName, agName, comp, 'Phrase'));

      // RSA ad for competitor group
      const headlines = generateCompetitorHeadlines({ dealer, make: primaryMake, city });
      const descriptions = generateCompetitorDescriptions({ dealer, make: primaryMake, city });
      rows.push(makeAdRow(campaignName, agName, headlines, descriptions, compUrl, fitHeadline(dealer, 15), ''));
    }
  }

  // -----------------------------------------------------------------------
  // 5. REGIONAL CAMPAIGN — if nearby cities provided
  // -----------------------------------------------------------------------

  if (nearbyCities.length > 0) {
    const campaignName = `${dealer} - Regional - New`;
    allCampaignNames.push(campaignName);

    // Campaign row
    rows.push(makeCampaignRow(campaignName, { startDate, status: 'Enabled' }));

    // Location rows
    for (const loc of locations) {
      rows.push(makeLocationRow(campaignName, loc.lat, loc.lng, loc.radius));
    }

    // Cross-make negatives
    for (const negMake of makesNotSold) {
      rows.push(makeCampaignNegativeRow(campaignName, negMake, 'Negative Phrase'));
    }

    // Universal negatives
    for (const neg of UNIVERSAL_NEGATIVES) {
      rows.push(makeCampaignNegativeRow(campaignName, neg, 'Negative Phrase'));
    }

    // Negative the dealer's own city to avoid overlap with other campaigns
    rows.push(makeCampaignNegativeRow(campaignName, city.toLowerCase(), 'Negative Phrase'));

    const regionalCpc = DEFAULT_CPC.regional; // $9
    const regionalUrl = (groups[0] && groups[0].baseUrl) || '';
    const primaryMake = (groups[0] && groups[0].make) || '';
    const short = MAKE_ALIASES[primaryMake] || primaryMake;

    for (const nearbyCity of nearbyCities) {
      if (!nearbyCity) continue;

      // Multiple ad groups per city with geo-intent keywords
      const geoKeywordSets = [
        {
          agName: `${primaryMake} dealer ${nearbyCity}`,
          keywords: [
            { text: `${primaryMake} dealer ${nearbyCity}`, type: 'Exact' },
            { text: `${primaryMake} dealer ${nearbyCity}`, type: 'Phrase' },
          ],
        },
        {
          agName: `${primaryMake} ${nearbyCity}`,
          keywords: [
            { text: `${primaryMake} ${nearbyCity}`, type: 'Exact' },
            { text: `${primaryMake} ${nearbyCity}`, type: 'Phrase' },
          ],
        },
        {
          agName: `new ${primaryMake} ${nearbyCity}`,
          keywords: [
            { text: `new ${primaryMake} ${nearbyCity}`, type: 'Exact' },
            { text: `new ${primaryMake} ${nearbyCity}`, type: 'Phrase' },
          ],
        },
      ];

      // Add short alias variations if different
      if (short !== primaryMake) {
        geoKeywordSets.push({
          agName: `${short} dealer ${nearbyCity}`,
          keywords: [
            { text: `${short} dealer ${nearbyCity}`, type: 'Exact' },
            { text: `${short} dealer ${nearbyCity}`, type: 'Phrase' },
          ],
        });
      }

      for (const geoSet of geoKeywordSets) {
        rows.push(makeAdGroupRow(campaignName, geoSet.agName, regionalCpc));

        for (const kw of geoSet.keywords) {
          rows.push(makeKeywordRow(campaignName, geoSet.agName, kw.text, kw.type));
        }

        // RSA ad with regional headlines using nearby city
        const headlines = generateRegionalHeadlines({ dealer, make: primaryMake, city: nearbyCity });
        const descriptions = generateRegionalDescriptions({ dealer, make: primaryMake, city: nearbyCity });
        rows.push(makeAdRow(campaignName, geoSet.agName, headlines, descriptions, regionalUrl, fitHeadline(primaryMake, 15), fitHeadline(nearbyCity, 15)));
      }
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { buildRows, COMBOS: MAKE_COMBOS, MODEL_MASTER };
