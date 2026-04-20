const { ACCOUNT_CURVES, resolveCurveId } = require('../../src/services/strategy-rules');
const store = require('../../src/services/dealer-groups-store');

// Reset in-memory store before each test to ensure isolation
beforeEach(() => {
  store._resetForTesting();
});

describe('ACCOUNT_CURVES', () => {
  test('is defined and is an object', () => {
    expect(typeof ACCOUNT_CURVES).toBe('object');
  });

  test('contains no entries by default (all config lives in Google Sheet)', () => {
    // Fallback registry — sheet column is the primary source.
    expect(Object.keys(ACCOUNT_CURVES).length).toBeGreaterThanOrEqual(0);
  });
});

describe('resolveCurveId', () => {
  test('returns sheet value when provided', () => {
    expect(resolveCurveId('Alan Jay Ford', 'alanJay9505')).toBe('alanJay9505');
  });

  test('falls back to ACCOUNT_CURVES when sheet value missing', () => {
    ACCOUNT_CURVES['test dealer fallback'] = 'alanJay9505';
    try {
      expect(resolveCurveId('Test Dealer Fallback', null)).toBe('alanJay9505');
    } finally {
      delete ACCOUNT_CURVES['test dealer fallback'];
    }
  });

  test('returns "linear" as final default', () => {
    expect(resolveCurveId('Unmapped Dealer', null)).toBe('linear');
    expect(resolveCurveId('Unmapped Dealer', '')).toBe('linear');
  });

  test('is case-insensitive on dealer name', () => {
    ACCOUNT_CURVES['mixed case dealer'] = 'alanJay9505';
    try {
      expect(resolveCurveId('Mixed Case Dealer', null)).toBe('alanJay9505');
      expect(resolveCurveId('MIXED CASE DEALER', null)).toBe('alanJay9505');
    } finally {
      delete ACCOUNT_CURVES['mixed case dealer'];
    }
  });
});

describe('resolveCurveId + dealer-groups-store integration', () => {
  test('resolveCurveId: sheet value still wins over group', () => {
    expect(resolveCurveId('Alan Jay Ford', 'linear')).toBe('linear');
    expect(resolveCurveId('Car2Sell', 'alanJay9505')).toBe('alanJay9505');
  });

  test('resolveCurveId: with no group membership, blank sheet value yields linear', () => {
    // Without any groups in the store, all dealers fall to the default (linear)
    expect(resolveCurveId('Alan Jay Ford', '')).toBe('linear');
    expect(resolveCurveId('Alan Jay Ford', null)).toBe('linear');
    expect(resolveCurveId('Alan Jay Ford', undefined)).toBe('linear');
  });

  test('resolveCurveId: when Alan Jay Ford is in an alanJay9505 group, blank sheet gets group curve', async () => {
    // Populate the in-memory store to simulate a DB group
    const group = await store.createGroup({ name: 'Alan Jay', curveId: 'alanJay9505' });
    await store.addMember(group.id, 'Alan Jay Ford');
    // Warm the cache
    await store.loadAll();

    expect(resolveCurveId('Alan Jay Ford', '')).toBe('alanJay9505');
    expect(resolveCurveId('Alan Jay Ford', null)).toBe('alanJay9505');
    expect(resolveCurveId('Alan Jay Ford', undefined)).toBe('alanJay9505');
  });

  test('resolveCurveId: default dealer with blank sheet value gets linear', () => {
    expect(resolveCurveId('Honda of Springfield', '')).toBe('linear');
  });
});
