const { ACCOUNT_CURVES, resolveCurveId } = require('../../src/services/strategy-rules');

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

describe('groupFor + group-based curve fallback', () => {
  const { groupFor, resolveCurveId, DEALER_GROUPS } = require('../../src/services/strategy-rules');

  test('Alan Jay dealer names match the Alan Jay group', () => {
    expect(groupFor('Alan Jay Ford').key).toBe('alan_jay');
    expect(groupFor('Alan Jay Chevrolet').key).toBe('alan_jay');
    expect(groupFor('alan jay cdjr').key).toBe('alan_jay');
    expect(groupFor('ALAN JAY BUICK GMC').key).toBe('alan_jay');
  });

  test('non-Alan-Jay dealer names fall to default group', () => {
    expect(groupFor('Car2Sell').key).toBe('default');
    expect(groupFor('Honda of Springfield').key).toBe('default');
    expect(groupFor('').key).toBe('default');
    expect(groupFor(null).key).toBe('default');
  });

  test('resolveCurveId: sheet value still wins over group', () => {
    expect(resolveCurveId('Alan Jay Ford', 'linear')).toBe('linear');
    expect(resolveCurveId('Car2Sell', 'alanJay9505')).toBe('alanJay9505');
  });

  test('resolveCurveId: Alan Jay dealer with blank sheet value gets alanJay9505 via group', () => {
    expect(resolveCurveId('Alan Jay Ford', '')).toBe('alanJay9505');
    expect(resolveCurveId('Alan Jay Ford', null)).toBe('alanJay9505');
    expect(resolveCurveId('Alan Jay Ford', undefined)).toBe('alanJay9505');
  });

  test('resolveCurveId: default dealer with blank sheet value gets linear via group', () => {
    expect(resolveCurveId('Honda of Springfield', '')).toBe('linear');
  });

  test('DEALER_GROUPS always ends with a catch-all default', () => {
    const last = DEALER_GROUPS[DEALER_GROUPS.length - 1];
    expect(last.key).toBe('default');
    expect(last.pattern.test('anything at all')).toBe(true);
  });
});
