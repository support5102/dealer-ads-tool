/**
 * Unit tests for campaign-classifier.js
 */

const {
  CAMPAIGN_TYPES,
  CUT_WEIGHTS,
  ADDITION_WEIGHTS,
  classifyCampaign,
  extractModel,
  computeInventoryShares,
  getEffectiveWeight,
  findInventoryShare,
} = require('../../src/services/campaign-classifier');

describe('classifyCampaign', () => {
  test('detects VLA by channel type SHOPPING', () => {
    expect(classifyCampaign('Honda Civic', 'SHOPPING')).toBe(CAMPAIGN_TYPES.VLA);
  });

  test('detects VLA by channel type LOCAL', () => {
    expect(classifyCampaign('Some Campaign', 'LOCAL')).toBe(CAMPAIGN_TYPES.VLA);
  });

  test('detects VLA by name containing "vla"', () => {
    expect(classifyCampaign('Honda Civic VLA')).toBe(CAMPAIGN_TYPES.VLA);
  });

  test('detects brand campaign', () => {
    expect(classifyCampaign('Honda of Springfield - Brand')).toBe(CAMPAIGN_TYPES.BRAND);
  });

  test('detects service campaign', () => {
    expect(classifyCampaign('Honda Service Department')).toBe(CAMPAIGN_TYPES.SERVICE);
  });

  test('detects comp/conquest campaign', () => {
    expect(classifyCampaign('Toyota Comp - Civic Comparison')).toBe(CAMPAIGN_TYPES.COMP);
    expect(classifyCampaign('Conquest Campaign Ford')).toBe(CAMPAIGN_TYPES.COMP);
  });

  test('detects regional campaign', () => {
    expect(classifyCampaign('Regional - Springfield Area')).toBe(CAMPAIGN_TYPES.REGIONAL);
  });

  test('detects general campaign', () => {
    expect(classifyCampaign('General - Cars for Sale')).toBe(CAMPAIGN_TYPES.GENERAL);
  });

  test('classifies model keyword campaign when model is present', () => {
    expect(classifyCampaign('Civic Keywords')).toBe(CAMPAIGN_TYPES.MODEL_KEYWORD);
    expect(classifyCampaign('F-150 Search Campaign')).toBe(CAMPAIGN_TYPES.MODEL_KEYWORD);
  });

  test('defaults to general when no type or model detected', () => {
    // Empty or unrecognizable names
    expect(classifyCampaign('')).toBe(CAMPAIGN_TYPES.GENERAL);
    expect(classifyCampaign('x')).toBe(CAMPAIGN_TYPES.GENERAL);
  });

  test('VLA takes precedence over other keywords in name', () => {
    // VLA + brand in name → VLA wins (channel type takes priority)
    expect(classifyCampaign('Brand VLA Campaign')).toBe(CAMPAIGN_TYPES.VLA);
  });
});

describe('extractModel', () => {
  test('extracts model by stripping make and noise words', () => {
    expect(extractModel('Honda Civic VLA')).toBe('civic');
    expect(extractModel('Toyota Camry Brand')).toBe('camry');
    expect(extractModel('Ford F-150 Keywords')).toBe('f-150');
  });

  test('handles multi-word models', () => {
    expect(extractModel('Honda CR-V New Search')).toBe('cr-v');
  });

  test('returns null for empty or noise-only names', () => {
    expect(extractModel('')).toBeNull();
    expect(extractModel(null)).toBeNull();
    expect(extractModel('Brand Campaign')).toBeNull();
  });

  test('strips multiple makes', () => {
    expect(extractModel('Chevrolet Chevy Silverado')).toBe('silverado');
  });

  test('handles case insensitivity', () => {
    expect(extractModel('HONDA CIVIC VLA')).toBe('civic');
  });
});

describe('computeInventoryShares', () => {
  test('computes proportional shares', () => {
    const shares = computeInventoryShares({ civic: 40, accord: 10, crv: 50 });
    expect(shares.civic).toBeCloseTo(0.4);
    expect(shares.accord).toBeCloseTo(0.1);
    expect(shares.crv).toBeCloseTo(0.5);
  });

  test('returns empty for zero total', () => {
    expect(computeInventoryShares({ civic: 0, accord: 0 })).toEqual({});
  });

  test('returns empty for null/undefined', () => {
    expect(computeInventoryShares(null)).toEqual({});
    expect(computeInventoryShares(undefined)).toEqual({});
  });

  test('single model gets 100%', () => {
    const shares = computeInventoryShares({ 'f-150': 25 });
    expect(shares['f-150']).toBe(1);
  });
});

describe('getEffectiveWeight', () => {
  const shares = computeInventoryShares({ civic: 40, accord: 5, crv: 5 });
  // civic = 0.80, accord = 0.10, crv = 0.10, 3 models, expectedShare = 0.333

  test('non-model types return base weight regardless of inventory', () => {
    expect(getEffectiveWeight(CAMPAIGN_TYPES.BRAND, null, shares, true))
      .toBe(ADDITION_WEIGHTS[CAMPAIGN_TYPES.BRAND]);
    expect(getEffectiveWeight(CAMPAIGN_TYPES.GENERAL, null, shares, false))
      .toBe(CUT_WEIGHTS[CAMPAIGN_TYPES.GENERAL]);
  });

  test('VLA with high inventory gets higher addition weight', () => {
    const highInv = getEffectiveWeight(CAMPAIGN_TYPES.VLA, 'civic', shares, true);
    const lowInv = getEffectiveWeight(CAMPAIGN_TYPES.VLA, 'accord', shares, true);
    expect(highInv).toBeGreaterThan(lowInv);
  });

  test('VLA with high inventory gets LOWER cut weight (protected)', () => {
    const highInv = getEffectiveWeight(CAMPAIGN_TYPES.VLA, 'civic', shares, false);
    const lowInv = getEffectiveWeight(CAMPAIGN_TYPES.VLA, 'accord', shares, false);
    expect(highInv).toBeLessThan(lowInv); // high inventory = protected from cuts
  });

  test('model keyword follows same pattern as VLA', () => {
    const highInv = getEffectiveWeight(CAMPAIGN_TYPES.MODEL_KEYWORD, 'civic', shares, true);
    const lowInv = getEffectiveWeight(CAMPAIGN_TYPES.MODEL_KEYWORD, 'accord', shares, true);
    expect(highInv).toBeGreaterThan(lowInv);
  });

  test('no inventory data returns reduced base weight', () => {
    const weight = getEffectiveWeight(CAMPAIGN_TYPES.VLA, 'unknown_model', shares, true);
    expect(weight).toBe(ADDITION_WEIGHTS[CAMPAIGN_TYPES.VLA] * 0.5);
  });

  test('empty inventory shares returns base weight', () => {
    const weight = getEffectiveWeight(CAMPAIGN_TYPES.VLA, 'civic', {}, true);
    expect(weight).toBe(ADDITION_WEIGHTS[CAMPAIGN_TYPES.VLA]);
  });
});

describe('findInventoryShare', () => {
  const shares = { civic: 0.4, 'f-150': 0.3, 'cr-v': 0.2, accord: 0.1 };

  test('exact match', () => {
    expect(findInventoryShare('civic', shares)).toBe(0.4);
  });

  test('partial match — model in key', () => {
    expect(findInventoryShare('f-150', shares)).toBe(0.3);
  });

  test('no match returns null', () => {
    expect(findInventoryShare('mustang', shares)).toBeNull();
  });

  test('null inputs return null', () => {
    expect(findInventoryShare(null, shares)).toBeNull();
    expect(findInventoryShare('civic', null)).toBeNull();
  });
});

describe('weight constants', () => {
  test('all campaign types have cut weights', () => {
    for (const type of Object.values(CAMPAIGN_TYPES)) {
      expect(CUT_WEIGHTS[type]).toBeDefined();
      expect(CUT_WEIGHTS[type]).toBeGreaterThan(0);
      expect(CUT_WEIGHTS[type]).toBeLessThanOrEqual(1);
    }
  });

  test('all campaign types have addition weights', () => {
    for (const type of Object.values(CAMPAIGN_TYPES)) {
      expect(ADDITION_WEIGHTS[type]).toBeDefined();
      expect(ADDITION_WEIGHTS[type]).toBeGreaterThan(0);
      expect(ADDITION_WEIGHTS[type]).toBeLessThanOrEqual(1);
    }
  });

  test('VLA has lowest cut weight and highest addition weight', () => {
    const cutValues = Object.values(CUT_WEIGHTS);
    const addValues = Object.values(ADDITION_WEIGHTS);
    expect(CUT_WEIGHTS[CAMPAIGN_TYPES.VLA]).toBe(Math.min(...cutValues));
    expect(ADDITION_WEIGHTS[CAMPAIGN_TYPES.VLA]).toBe(Math.max(...addValues));
  });
});
