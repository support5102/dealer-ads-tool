/**
 * Tests for strategy-rules.js — campaign classification, CPC ranges,
 * competing makes, and dealer make detection.
 */

const {
  CPC_RANGES,
  MATCH_TYPE_POLICY,
  BUDGET_SPLITS,
  AD_SCHEDULE_TEMPLATE,
  VLA_SETTINGS,
  IMPRESSION_SHARE,
  COMPETING_MAKES,
  ALL_KNOWN_MAKES,
  UNIVERSAL_NEGATIVES,
  classifyCampaignType,
  getCpcRange,
  getCompetingMakes,
  detectDealerMake,
} = require('../../src/services/strategy-rules');

// ─────────────────────────────────────────────────────────────
// classifyCampaignType
// ─────────────────────────────────────────────────────────────

describe('classifyCampaignType', () => {
  test('PMax prefix returns pmax', () => {
    expect(classifyCampaignType('PMax: VLA Ads - New')).toBe('pmax');
  });

  test('Brand keyword returns brand', () => {
    expect(classifyCampaignType('Honda of Springfield - Brand')).toBe('brand');
  });

  test('Dealer keyword returns brand', () => {
    expect(classifyCampaignType('Springfield Dealer Campaign')).toBe('brand');
  });

  test('Used keyword returns used', () => {
    expect(classifyCampaignType('Honda of Springfield - Used - Civic')).toBe('used');
  });

  test('General keyword returns general', () => {
    expect(classifyCampaignType('Springfield Ford - General')).toBe('general');
  });

  test('Regional keyword returns regional', () => {
    expect(classifyCampaignType('Ford - Regional - Illinois')).toBe('regional');
  });

  test('Competitor keyword returns competitor', () => {
    expect(classifyCampaignType('Ford - Competitor - Toyota')).toBe('competitor');
  });

  test('New + high-demand model returns new_high', () => {
    expect(classifyCampaignType('Honda of Springfield - New - Civic')).toBe('new_high');
  });

  test('New + low-demand model returns new_low', () => {
    expect(classifyCampaignType('Honda of Springfield - New - Insight')).toBe('new_low');
  });

  test('campaign with separator and high-demand model returns new_high', () => {
    expect(classifyCampaignType('Honda of Springfield - Accord')).toBe('new_high');
  });

  test('campaign with separator and unknown model returns new_low', () => {
    expect(classifyCampaignType('Honda of Springfield - Passport')).toBe('new_low');
  });

  test('unrecognized name returns unknown', () => {
    expect(classifyCampaignType('SomethingRandom')).toBe('unknown');
  });

  test('null input returns unknown', () => {
    expect(classifyCampaignType(null)).toBe('unknown');
  });

  test('empty string returns unknown', () => {
    expect(classifyCampaignType('')).toBe('unknown');
  });

  test('case insensitive matching', () => {
    expect(classifyCampaignType('honda - BRAND campaign')).toBe('brand');
    expect(classifyCampaignType('honda - used - cr-v')).toBe('used');
  });
});

// ─────────────────────────────────────────────────────────────
// getCpcRange
// ─────────────────────────────────────────────────────────────

describe('getCpcRange', () => {
  test('returns correct range for brand', () => {
    expect(getCpcRange('brand')).toEqual({ min: 1.00, max: 3.00 });
  });

  test('returns correct range for competitor', () => {
    expect(getCpcRange('competitor')).toEqual({ min: 5.00, max: 15.00 });
  });

  test('returns null for pmax (no CPC range)', () => {
    expect(getCpcRange('pmax')).toBeNull();
  });

  test('returns null for unknown type', () => {
    expect(getCpcRange('unknown')).toBeNull();
  });

  test('returns null for non-existent type', () => {
    expect(getCpcRange('nonexistent')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// getCompetingMakes
// ─────────────────────────────────────────────────────────────

describe('getCompetingMakes', () => {
  test('returns correct competing makes for ford', () => {
    const makes = getCompetingMakes('ford');
    expect(makes).toContain('chevrolet');
    expect(makes).toContain('toyota');
    expect(makes).not.toContain('ford');
  });

  test('returns correct competing makes for honda', () => {
    const makes = getCompetingMakes('honda');
    expect(makes).toContain('ford');
    expect(makes).not.toContain('honda');
  });

  test('returns ALL_KNOWN_MAKES for unrecognized make', () => {
    expect(getCompetingMakes('lincoln')).toEqual(ALL_KNOWN_MAKES);
  });

  test('returns ALL_KNOWN_MAKES for null input', () => {
    expect(getCompetingMakes(null)).toEqual(ALL_KNOWN_MAKES);
  });

  test('case insensitive lookup', () => {
    const makes = getCompetingMakes('FORD');
    expect(makes).toContain('toyota');
    expect(makes).not.toContain('ford');
  });
});

// ─────────────────────────────────────────────────────────────
// detectDealerMake
// ─────────────────────────────────────────────────────────────

describe('detectDealerMake', () => {
  test('detects make from standard campaign name', () => {
    expect(detectDealerMake('Honda of Springfield - New - Civic')).toBe('honda');
  });

  test('detects ford from campaign name', () => {
    expect(detectDealerMake('Springfield Ford - Used - F-150')).toBe('ford');
  });

  test('normalizes chevy to chevrolet', () => {
    expect(detectDealerMake('Chevy Dealer - Brand')).toBe('chevrolet');
  });

  test('detects make regardless of case', () => {
    expect(detectDealerMake('TOYOTA OF SPRINGFIELD')).toBe('toyota');
  });

  test('returns null for campaign with no known make', () => {
    expect(detectDealerMake('Springfield Auto - General')).toBeNull();
  });

  test('returns null for null input', () => {
    expect(detectDealerMake(null)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(detectDealerMake('')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// Constants sanity checks
// ─────────────────────────────────────────────────────────────

describe('constants integrity', () => {
  test('MATCH_TYPE_POLICY forbids BROAD', () => {
    expect(MATCH_TYPE_POLICY.forbidden).toContain('BROAD');
    expect(MATCH_TYPE_POLICY.allowed).toContain('EXACT');
    expect(MATCH_TYPE_POLICY.allowed).toContain('PHRASE');
  });

  test('AD_SCHEDULE_TEMPLATE has Sunday off', () => {
    expect(AD_SCHEDULE_TEMPLATE.sunday).toBeNull();
    expect(AD_SCHEDULE_TEMPLATE.saturday.end).toBe('20:30');
  });

  test('UNIVERSAL_NEGATIVES includes common non-buyer terms', () => {
    expect(UNIVERSAL_NEGATIVES).toContain('recall');
    expect(UNIVERSAL_NEGATIVES).toContain('junkyard');
    expect(UNIVERSAL_NEGATIVES).toContain('hot wheels');
  });

  test('BUDGET_SPLITS values sum to roughly 1.0 at midpoints', () => {
    const midpoints = Object.values(BUDGET_SPLITS)
      .map(s => (s.min + s.max) / 2);
    const total = midpoints.reduce((a, b) => a + b, 0);
    // Should be close to 1.0 (some tolerance for rounding)
    expect(total).toBeGreaterThan(0.85);
    expect(total).toBeLessThan(1.15);
  });
});
