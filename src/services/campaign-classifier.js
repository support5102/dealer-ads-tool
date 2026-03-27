/**
 * Campaign Classifier — parses campaign names into types and extracts model names.
 *
 * Called by: services/pacing-detector.js, services/budget-recommender.js
 *
 * Campaign types (in cut priority order, highest = cut first):
 *   REGIONAL, SERVICE, GENERAL, COMP, MODEL_KEYWORD, BRAND, VLA
 *
 * Model extraction: parses model names from campaign names for inventory matching.
 * Example: "Honda Civic VLA" → type: VLA, model: "civic"
 *          "F-150 Brand" → type: BRAND, model: "f-150"
 */

/**
 * Campaign type constants — ordered by cut priority (highest = cut first).
 * Values are used as keys for weight lookups.
 */
const CAMPAIGN_TYPES = {
  REGIONAL: 'regional',
  SERVICE: 'service',
  GENERAL: 'general',
  COMP: 'comp',
  MODEL_KEYWORD: 'model_keyword',
  BRAND: 'brand',
  VLA: 'vla',
};

/**
 * Over-pacing cut weights — proportional share of budget reduction.
 * Higher weight = absorbs more of the cut.
 * All tiers get cut simultaneously; weights control relative proportion.
 */
const CUT_WEIGHTS = {
  [CAMPAIGN_TYPES.REGIONAL]:      1.0,
  [CAMPAIGN_TYPES.SERVICE]:       0.95,
  [CAMPAIGN_TYPES.GENERAL]:       0.85,
  [CAMPAIGN_TYPES.COMP]:          0.75,
  [CAMPAIGN_TYPES.MODEL_KEYWORD]: 0.6,   // base — adjusted by inventory share
  [CAMPAIGN_TYPES.BRAND]:         0.35,
  [CAMPAIGN_TYPES.VLA]:           0.15,   // base — adjusted by inventory share
};

/**
 * Under-pacing addition weights — proportional share of budget increase.
 * Higher weight = receives more of the extra budget.
 */
const ADDITION_WEIGHTS = {
  [CAMPAIGN_TYPES.VLA]:           1.0,    // base — multiplied by inventory share
  [CAMPAIGN_TYPES.MODEL_KEYWORD]: 0.8,    // base — multiplied by inventory share
  [CAMPAIGN_TYPES.BRAND]:         0.35,
  [CAMPAIGN_TYPES.COMP]:          0.3,
  [CAMPAIGN_TYPES.GENERAL]:       0.25,
  [CAMPAIGN_TYPES.SERVICE]:       0.15,
  [CAMPAIGN_TYPES.REGIONAL]:      0.1,
};

/**
 * Keywords that identify campaign types in campaign names.
 * Order matters — first match wins, so more specific patterns go first.
 */
const TYPE_PATTERNS = [
  { type: CAMPAIGN_TYPES.SERVICE,  patterns: ['service', 'parts', 'fixed ops', 'repair', 'maintenance'] },
  { type: CAMPAIGN_TYPES.COMP,     patterns: ['comp', 'competitor', 'conquest'] },
  { type: CAMPAIGN_TYPES.REGIONAL, patterns: ['regional', 'region', 'geo', 'area'] },
  { type: CAMPAIGN_TYPES.GENERAL,  patterns: ['general', 'generic'] },
  { type: CAMPAIGN_TYPES.BRAND,    patterns: ['brand', 'branded'] },
];

/**
 * Common make names to strip when extracting model from campaign name.
 */
const COMMON_MAKES = [
  'honda', 'toyota', 'ford', 'chevrolet', 'chevy', 'nissan', 'hyundai', 'kia',
  'jeep', 'dodge', 'ram', 'chrysler', 'gmc', 'buick', 'cadillac', 'lincoln',
  'mazda', 'subaru', 'volkswagen', 'vw', 'bmw', 'mercedes', 'audi', 'lexus',
  'acura', 'infiniti', 'volvo', 'mitsubishi', 'fiat', 'alfa romeo',
];

/**
 * Words to strip from campaign names when extracting models.
 */
const NOISE_WORDS = [
  'vla', 'brand', 'branded', 'general', 'generic', 'regional', 'service',
  'comp', 'competitor', 'conquest', 'new', 'used', 'cpo', 'certified',
  'search', 'campaign', 'keywords', 'keyword', 'pmax', 'performance max',
  'shopping', 'local', 'display', 'video', 'youtube', 'remarketing', 'remarket',
];

/**
 * Classifies a campaign into a type based on its name and channel type.
 *
 * @param {string} campaignName - Campaign name
 * @param {string} [channelType] - Google Ads channel type (SHOPPING, LOCAL, etc.)
 * @returns {string} One of CAMPAIGN_TYPES values
 */
function classifyCampaign(campaignName, channelType) {
  const lower = (campaignName || '').toLowerCase();
  const type = (channelType || '').toUpperCase();

  // VLA detection: channel type or name
  if (type === 'SHOPPING' || type === 'LOCAL' || lower.includes('vla')) {
    return CAMPAIGN_TYPES.VLA;
  }

  // Check type patterns
  for (const { type: campType, patterns } of TYPE_PATTERNS) {
    for (const pattern of patterns) {
      if (lower.includes(pattern)) return campType;
    }
  }

  // If it contains a recognizable model name but no type keyword → model keyword campaign
  const model = extractModel(campaignName);
  if (model) return CAMPAIGN_TYPES.MODEL_KEYWORD;

  // Default: general (lowest priority keyword campaign)
  return CAMPAIGN_TYPES.GENERAL;
}

/**
 * Extracts a model name from a campaign name by stripping make, type, and noise words.
 *
 * @param {string} campaignName - Campaign name
 * @returns {string|null} Extracted model name (lowercase) or null
 */
function extractModel(campaignName) {
  if (!campaignName) return null;

  let name = campaignName.toLowerCase().trim();

  // Strip common makes
  for (const make of COMMON_MAKES) {
    name = name.replace(new RegExp(`\\b${escapeRegex(make)}\\b`, 'g'), ' ');
  }

  // Strip noise words
  for (const word of NOISE_WORDS) {
    name = name.replace(new RegExp(`\\b${escapeRegex(word)}\\b`, 'g'), ' ');
  }

  // Strip separators (but not hyphens inside words like F-150)
  name = name.replace(/[|–—]/g, ' ');

  // Clean up: collapse whitespace, trim
  name = name.replace(/\s+/g, ' ').trim();

  // If nothing meaningful remains, no model (min 3 chars to avoid false fuzzy matches)
  if (!name || name.length < 3) return null;

  // Return the cleaned model name
  return name;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Computes inventory share per model from total inventory.
 * Each model's share = model count / total inventory count.
 *
 * @param {Object} inventoryByModel - Map of model name → count (e.g., { "civic": 40, "accord": 5 })
 * @returns {Object} Map of model name → share (0-1) (e.g., { "civic": 0.20, "accord": 0.025 })
 */
function computeInventoryShares(inventoryByModel) {
  if (!inventoryByModel || typeof inventoryByModel !== 'object') return {};
  const total = Object.values(inventoryByModel).reduce((sum, count) => sum + count, 0);
  if (total === 0) return {};

  const shares = {};
  for (const [model, count] of Object.entries(inventoryByModel)) {
    shares[model] = count / total;
  }
  return shares;
}

/**
 * Computes the effective weight for a campaign, adjusting for inventory share.
 *
 * For VLAs and model keywords, the base weight is multiplied by inventory share,
 * so campaigns tied to high-inventory models get proportionally more/less budget.
 *
 * For non-model campaigns (brand, general, etc.), the base weight is used as-is.
 *
 * @param {string} campaignType - One of CAMPAIGN_TYPES values
 * @param {string|null} model - Extracted model name (lowercase)
 * @param {Object} inventoryShares - From computeInventoryShares()
 * @param {boolean} isAddition - true for under-pacing (addition), false for over-pacing (cut)
 * @returns {number} Effective weight (0+)
 */
function getEffectiveWeight(campaignType, model, inventoryShares, isAddition) {
  const baseWeights = isAddition ? ADDITION_WEIGHTS : CUT_WEIGHTS;
  const baseWeight = baseWeights[campaignType] ?? 0.5;

  // Only VLAs and model keywords get inventory adjustment
  if (campaignType !== CAMPAIGN_TYPES.VLA && campaignType !== CAMPAIGN_TYPES.MODEL_KEYWORD) {
    return baseWeight;
  }

  if (!model || !inventoryShares || Object.keys(inventoryShares).length === 0) {
    return baseWeight;
  }

  // Find matching inventory share — fuzzy match (model appears in key or vice versa)
  const share = findInventoryShare(model, inventoryShares);
  if (share === null) return baseWeight * 0.5; // no inventory data → assume low

  // Scale by inventory share. A model with 20% of lot inventory gets full base weight.
  // A model with 2% gets 10% of base weight. Minimum floor of 0.05 to never fully zero out.
  // The multiplier normalizes so the "average" model (1/numModels) gets ~1x base weight.
  const numModels = Object.keys(inventoryShares).length || 1;
  const expectedShare = 1 / numModels;
  const multiplier = Math.max(share / expectedShare, 0.05);

  if (isAddition) {
    // Under-pacing: high inventory = higher weight (gets more budget)
    return baseWeight * multiplier;
  } else {
    // Over-pacing: high inventory = LOWER cut weight (protected from cuts)
    // Invert: high inventory → low cut, low inventory → high cut
    const invertedMultiplier = Math.max(expectedShare / Math.max(share, 0.001), 0.05);
    return baseWeight * invertedMultiplier;
  }
}

/**
 * Fuzzy-matches a model name against inventory share keys.
 * Returns the share value or null if no match.
 */
function findInventoryShare(model, inventoryShares) {
  if (!model || !inventoryShares) return null;

  const modelLower = model.toLowerCase().trim();

  // Exact match
  if (inventoryShares[modelLower] !== undefined) return inventoryShares[modelLower];

  // Partial match: model appears in key or key appears in model
  for (const [key, share] of Object.entries(inventoryShares)) {
    const keyLower = key.toLowerCase();
    if (keyLower.includes(modelLower) || modelLower.includes(keyLower)) {
      return share;
    }
  }

  return null;
}

module.exports = {
  CAMPAIGN_TYPES,
  CUT_WEIGHTS,
  ADDITION_WEIGHTS,
  classifyCampaign,
  extractModel,
  computeInventoryShares,
  getEffectiveWeight,
  findInventoryShare,
  COMMON_MAKES,
};
