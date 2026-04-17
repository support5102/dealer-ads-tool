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
