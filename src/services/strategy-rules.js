/**
 * Strategy Rules — single source of truth for all strategy thresholds and rules.
 *
 * Called by: audit-engine.js, negative-keyword-analyzer.js, cpc-optimizer.js, claude-parser.js
 * Calls: nothing (pure constants and classification helpers)
 *
 * Every threshold, naming convention, budget split, and policy constant lives here.
 * Other services import from this module instead of hardcoding values.
 */

// ─────────────────────────────────────────────────────────────
// CPC ranges by campaign type classification
// ─────────────────────────────────────────────────────────────

const CPC_RANGES = {
  brand:      { min: 1.00, max: 3.00 },
  new_high:   { min: 3.00, max: 8.00 },   // F-150, Silverado, popular SUVs
  new_low:    { min: 1.50, max: 4.00 },   // Sedans, smaller models
  used:       { min: 2.00, max: 6.00 },
  general:    { min: 4.00, max: 10.00 },
  regional:   { min: 2.00, max: 5.00 },
  competitor: { min: 5.00, max: 15.00 },
};

// ─────────────────────────────────────────────────────────────
// Match type policy
// ─────────────────────────────────────────────────────────────

const MATCH_TYPE_POLICY = {
  allowed: ['EXACT', 'PHRASE'],
  forbidden: ['BROAD'],
};

// ─────────────────────────────────────────────────────────────
// Budget allocation targets (% of total daily budget)
// ─────────────────────────────────────────────────────────────

const BUDGET_SPLITS = {
  vla:         { min: 0.40, max: 0.50 },  // 40-50% for PMax VLA
  new_search:  { min: 0.25, max: 0.30 },  // 25-30%
  used_search: { min: 0.10, max: 0.15 },
  brand:       { min: 0.05, max: 0.10 },
  general:     { min: 0.05, max: 0.10 },
};

// ─────────────────────────────────────────────────────────────
// Ad schedule template (standard across all campaigns)
// ─────────────────────────────────────────────────────────────

const AD_SCHEDULE_TEMPLATE = {
  monday:    { start: '08:30', end: '19:00' },
  tuesday:   { start: '08:30', end: '19:00' },
  wednesday: { start: '08:30', end: '19:00' },
  thursday:  { start: '08:30', end: '19:00' },
  friday:    { start: '08:30', end: '19:00' },
  saturday:  { start: '08:30', end: '20:30' },
  sunday:    null, // off
};

// ─────────────────────────────────────────────────────────────
// Campaign naming patterns
// ─────────────────────────────────────────────────────────────

const NAMING_PATTERNS = {
  separator: ' - ',
  pmaxPrefix: 'PMax:',
  adGroupPrefix: 'SD: ',
  // Model campaigns: "{Dealer} - {Condition} - {Model}"
  // Non-model: "{Dealer} - {Category}"
  // PMax: "PMax: VLA Ads - {Segment}"
};

// ─────────────────────────────────────────────────────────────
// VLA/PMax settings that must be enforced
// ─────────────────────────────────────────────────────────────

const VLA_SETTINGS = {
  biddingStrategy: 'MAXIMIZE_CONVERSIONS',
  targetCpa: null,            // must NOT be set
  urlExpansion: false,
  imageEnhancement: false,
  textCustomization: false,
  ctrTarget: 0.008,           // 0.80%
  ctrConcern: 0.005,          // 0.50%
  maxCpc: 2.50,
  maxCostPerConversion: 5.00,
};

// ─────────────────────────────────────────────────────────────
// Impression share targets
// ─────────────────────────────────────────────────────────────

const IMPRESSION_SHARE = {
  target: { min: 0.75, max: 0.90 },
  warningBelow: 0.75,
  criticalBelow: 0.50,
};

// ─────────────────────────────────────────────────────────────
// Competing makes for negative keyword enforcement
// ─────────────────────────────────────────────────────────────

const COMPETING_MAKES = {
  ford:       ['chevrolet', 'chevy', 'toyota', 'honda', 'nissan', 'hyundai', 'kia', 'dodge', 'ram', 'jeep', 'gmc', 'buick', 'cadillac', 'chrysler', 'subaru', 'mazda'],
  chevrolet:  ['ford', 'toyota', 'honda', 'nissan', 'hyundai', 'kia', 'dodge', 'ram', 'jeep', 'gmc', 'buick', 'cadillac', 'chrysler', 'subaru', 'mazda'],
  toyota:     ['ford', 'chevrolet', 'chevy', 'honda', 'nissan', 'hyundai', 'kia', 'dodge', 'ram', 'jeep', 'gmc', 'buick', 'cadillac', 'chrysler', 'subaru', 'mazda'],
  honda:      ['ford', 'chevrolet', 'chevy', 'toyota', 'nissan', 'hyundai', 'kia', 'dodge', 'ram', 'jeep', 'gmc', 'buick', 'cadillac', 'chrysler', 'subaru', 'mazda'],
  kia:        ['ford', 'chevrolet', 'chevy', 'toyota', 'honda', 'nissan', 'hyundai', 'dodge', 'ram', 'jeep', 'gmc', 'buick', 'cadillac', 'chrysler', 'subaru', 'mazda'],
};

const ALL_KNOWN_MAKES = [
  'ford', 'lincoln', 'chevrolet', 'chevy', 'buick', 'gmc', 'cadillac',
  'toyota', 'lexus', 'honda', 'acura', 'nissan', 'infiniti',
  'hyundai', 'kia', 'genesis',
  'dodge', 'ram', 'jeep', 'chrysler',
  'subaru', 'mazda', 'volkswagen', 'vw', 'audi',
  'bmw', 'mercedes-benz', 'mercedes', 'volvo', 'porsche',
];

// ─────────────────────────────────────────────────────────────
// Ad group default CPC by campaign type
// ─────────────────────────────────────────────────────────────

const DEFAULT_CPC = {
  brand: 3,
  competitor: 9,
  general: 9,
  regional: 9,
  new_high: 9,
  new_low: 9,
  used: 9,
};

// ─────────────────────────────────────────────────────────────
// Multi-make combos for dealer groups
// ─────────────────────────────────────────────────────────────

const MAKE_COMBOS = {
  'CDJR':           ['Chrysler', 'Dodge', 'Jeep', 'Ram'],
  'Dodge/Jeep':     ['Dodge', 'Jeep'],
  'Dodge/Ram':      ['Dodge', 'Ram'],
  'Jeep/Ram':       ['Jeep', 'Ram'],
  'GM All':         ['Chevrolet', 'Buick', 'GMC', 'Cadillac'],
  'Chevy/GMC/CDJR': ['Chevrolet', 'GMC', 'Chrysler', 'Jeep', 'Dodge', 'Ram'],
  'Chevy/GMC':      ['Chevrolet', 'GMC'],
  'Buick/GMC':      ['Buick', 'GMC'],
  'Ford/Lincoln':   ['Ford', 'Lincoln'],
  'Toyota/Lexus':   ['Toyota', 'Lexus'],
  'Honda/Acura':    ['Honda', 'Acura'],
  'Hyundai/Kia':    ['Hyundai', 'Kia'],
  'Nissan/Infiniti':['Nissan', 'Infiniti'],
  'VW/Audi':        ['Volkswagen', 'Audi'],
};

// ─────────────────────────────────────────────────────────────
// URL patterns by website platform
// ─────────────────────────────────────────────────────────────

const URL_PATTERNS = {
  autofusion:     { new: '/search/New+{Make}+{Model}+tmM',                          used: '/search/Used+{Make}+{Model}+tmM' },
  teamvelocity:   { new: '/inventory/new/{make-lower}/{model-slug}',                 used: '/inventory/used/{make-lower}/{model-slug}' },
  dealerinspire:  { new: '/new-vehicles/{model-slug}/',                              used: '/used-vehicles/{model-slug}/' },
  eprocess:       { new: '/search/new-{make-slug}-{model-slug}-{city-slug}-{state-lower}/?tp=new', used: '/search/used-{make-slug}-{model-slug}-{city-slug}-{state-lower}/?tp=used' },
  dealeron:       { new: '/new-inventory/index.htm?make={Make}&model={Model}',       used: '/used-inventory/index.htm?make={Make}&model={Model}' },
  dealercom:      { new: '/vcp/new/{make-lower}/{model-slug}',                       used: '/vcp/used/{make-lower}/{model-slug}' },
  foxdealer:      { new: '/new-vehicles/{model-slug}',                               used: '/used-vehicles/{model-slug}' },
  sincro:         { new: '/new-inventory/?model={Model}',                            used: '/used-inventory/?model={Model}' },
  savvydealer:    { new: '/inventory/new?make={Make}&model={Model}',                 used: '/inventory/used?make={Make}&model={Model}' },
};

// ─────────────────────────────────────────────────────────────
// Universal negative keywords (account-level, phrase match)
// ─────────────────────────────────────────────────────────────

const UNIVERSAL_NEGATIVES = [
  'recall', 'complaints', 'problems', 'lawsuit', 'lemon',
  'accident', 'crash test', 'junkyard', 'salvage', 'parts',
  'repair manual', 'wiring diagram', 'fuse box', 'oil change', 'tire rotation',
  'how to', 'DIY',
  'toy', 'hot wheels', 'matchbox', 'model car', 'die cast', 'remote control', 'RC',
  'coloring page', 'wallpaper',
  'rental', 'rent', 'insurance', 'free',
];

// ─────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────

/**
 * Classifies a campaign into a type based on its name.
 *
 * @param {string} campaignName - The campaign name to classify
 * @returns {string} One of: 'brand', 'new_high', 'new_low', 'used', 'general',
 *   'regional', 'competitor', 'pmax', 'unknown'
 */
// High-demand models that get the new_high CPC range ($3-$8)
const HIGH_DEMAND_MODELS = [
  'f-150', 'f150', 'silverado', 'sierra', 'ram 1500', 'tacoma', 'tundra',
  'rav4', 'cr-v', 'crv', 'civic', 'camry', 'accord', 'explorer', 'wrangler',
  'grand cherokee', 'bronco', 'telluride', 'highlander', 'pilot', 'tahoe',
  'suburban', 'equinox', 'escape', 'rogue', 'tucson', 'sportage', 'cx-5',
  'outback', 'forester', 'sorento', 'palisade',
];

function classifyCampaignType(campaignName) {
  if (!campaignName || typeof campaignName !== 'string') return 'unknown';

  const name = campaignName.trim();

  if (name.startsWith(NAMING_PATTERNS.pmaxPrefix)) return 'pmax';
  if (/\bBrand\b/i.test(name) || /\bDealer\b/i.test(name)) return 'brand';
  if (/\bCompetitor\b/i.test(name)) return 'competitor';
  if (/\bRegional\b/i.test(name)) return 'regional';
  if (/\bGeneral\b/i.test(name)) return 'general';
  if (/\bUsed\b/i.test(name)) return 'used';

  // Check for new + high-demand model
  if (/\bNew\b/i.test(name) || name.includes(NAMING_PATTERNS.separator)) {
    const nameLower = name.toLowerCase();
    for (const model of HIGH_DEMAND_MODELS) {
      if (nameLower.includes(model)) return 'new_high';
    }
    return 'new_low';
  }

  return 'unknown';
}

/**
 * Returns the CPC range for a given campaign type.
 *
 * @param {string} campaignType - Campaign type from classifyCampaignType
 * @returns {{ min: number, max: number }|null} CPC range or null if type has no range
 */
function getCpcRange(campaignType) {
  return CPC_RANGES[campaignType] || null;
}

/**
 * Returns the list of competing makes that should be blocked as negatives
 * for a given dealer make.
 *
 * @param {string} dealerMake - The make the dealer sells (e.g., 'ford')
 * @returns {string[]} Array of makes to block as negatives
 */
function getCompetingMakes(dealerMake) {
  if (!dealerMake || typeof dealerMake !== 'string') return ALL_KNOWN_MAKES;
  const key = dealerMake.toLowerCase().trim();
  // If make has explicit list, use it; otherwise filter own make from full list
  if (COMPETING_MAKES[key]) return COMPETING_MAKES[key];
  // Fallback: all makes except the dealer's own (and its aliases)
  const aliases = key === 'chevrolet' ? ['chevrolet', 'chevy'] : key === 'chevy' ? ['chevrolet', 'chevy'] : [key];
  return ALL_KNOWN_MAKES.filter(m => !aliases.includes(m));
}

/**
 * Attempts to extract the dealer make from a campaign name.
 * Looks for known makes in the campaign name segments.
 *
 * @param {string} campaignName - Campaign name (e.g., "Honda of Springfield - New - Civic")
 * @returns {string|null} Lowercase make name or null if not detected
 */
function detectDealerMake(campaignName) {
  if (!campaignName || typeof campaignName !== 'string') return null;

  const lower = campaignName.toLowerCase();

  // Check each known make against the campaign name
  for (const make of ALL_KNOWN_MAKES) {
    // Use word boundary check: the make should appear as a standalone word
    const regex = new RegExp(`\\b${make}\\b`, 'i');
    if (regex.test(lower)) {
      // Normalize "chevy" to "chevrolet" for lookup consistency
      return make === 'chevy' ? 'chevrolet' : make;
    }
  }

  return null;
}

/**
 * Per-account spend overrides — campaigns whose spend should be excluded
 * from one account's pacing and credited to another.
 *
 * Keys are lowercase account names.
 * excludeCampaigns: campaign names to remove from this account's spend.
 * redirectSpendTo: lowercase account name that should receive the excluded spend.
 */
const ACCOUNT_OVERRIDES = {};

/**
 * Per-account pacing curve fallback registry — used when the Google Sheets
 * "Pacing Curve" column is blank. Keys are lowercase dealer names.
 * Values are curve IDs from src/services/pacing-curve.js PACING_CURVES.
 *
 * Default if unmapped: 'linear'.
 */
const ACCOUNT_CURVES = {};

/**
 * Resolves the curve ID for an account.
 * Precedence: sheet value -> ACCOUNT_CURVES fallback -> group's curve default.
 *
 * Groups are now DB-backed (dealer-groups-store.js). The groupFor lookup
 * is synchronous via the store's in-memory cache.
 *
 * @param {string} dealerName - Human-readable dealer name
 * @param {string|null|undefined} sheetCurveId - Value from sheet's "Pacing Curve" column
 * @returns {string} Curve ID (always a valid key into PACING_CURVES)
 */
function resolveCurveId(dealerName, sheetCurveId) {
  if (sheetCurveId && String(sheetCurveId).trim() !== '') {
    return String(sheetCurveId).trim();
  }
  const key = String(dealerName || '').toLowerCase().trim();
  if (ACCOUNT_CURVES[key]) return ACCOUNT_CURVES[key];
  const { groupFor } = require('./dealer-groups-store');
  return groupFor(dealerName).curve;
}

module.exports = {
  CPC_RANGES,
  MATCH_TYPE_POLICY,
  BUDGET_SPLITS,
  AD_SCHEDULE_TEMPLATE,
  NAMING_PATTERNS,
  VLA_SETTINGS,
  IMPRESSION_SHARE,
  COMPETING_MAKES,
  ALL_KNOWN_MAKES,
  DEFAULT_CPC,
  MAKE_COMBOS,
  URL_PATTERNS,
  UNIVERSAL_NEGATIVES,
  classifyCampaignType,
  getCpcRange,
  getCompetingMakes,
  detectDealerMake,
  HIGH_DEMAND_MODELS,
  ACCOUNT_OVERRIDES,
  ACCOUNT_CURVES,
  resolveCurveId,
};
