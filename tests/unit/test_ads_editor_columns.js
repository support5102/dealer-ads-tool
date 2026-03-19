/**
 * Tier 2 Unit Tests — ads-editor-columns.js
 *
 * Tests: src/utils/ads-editor-columns.js
 */

const { COLS, toCsvMatchType, toNegativeCsvMatchType, blankRow } = require('../../src/utils/ads-editor-columns');

describe('ads-editor-columns', () => {
  describe('COLS', () => {
    test('has 176 columns', () => {
      expect(COLS).toHaveLength(176);
    });

    test('starts with Campaign', () => {
      expect(COLS[0]).toBe('Campaign');
    });

    test('ends with Comment', () => {
      expect(COLS[COLS.length - 1]).toBe('Comment');
    });

    test('contains key columns for change export', () => {
      expect(COLS).toContain('Campaign Status');
      expect(COLS).toContain('Ad Group Status');
      expect(COLS).toContain('Status');
      expect(COLS).toContain('Budget');
      expect(COLS).toContain('Budget type');
      expect(COLS).toContain('Budget name');
      expect(COLS).toContain('Keyword');
      expect(COLS).toContain('Criterion Type');
      expect(COLS).toContain('Max CPC');
      expect(COLS).toContain('Location');
      expect(COLS).toContain('Radius');
      expect(COLS).toContain('Unit');
      expect(COLS).toContain('Ad Group');
    });

    test('has no duplicates', () => {
      const unique = new Set(COLS);
      expect(unique.size).toBe(COLS.length);
    });
  });

  describe('toCsvMatchType', () => {
    test('converts EXACT to Exact', () => {
      expect(toCsvMatchType('EXACT')).toBe('Exact');
    });

    test('converts PHRASE to Phrase', () => {
      expect(toCsvMatchType('PHRASE')).toBe('Phrase');
    });

    test('converts BROAD to Broad', () => {
      expect(toCsvMatchType('BROAD')).toBe('Broad');
    });

    test('is case-insensitive', () => {
      expect(toCsvMatchType('exact')).toBe('Exact');
      expect(toCsvMatchType('Phrase')).toBe('Phrase');
    });

    test('defaults to Exact for null/undefined', () => {
      expect(toCsvMatchType(null)).toBe('Exact');
      expect(toCsvMatchType(undefined)).toBe('Exact');
    });

    test('defaults to Exact for unknown values', () => {
      expect(toCsvMatchType('FUZZY')).toBe('Exact');
    });
  });

  describe('toNegativeCsvMatchType', () => {
    test('prepends Negative to match type', () => {
      expect(toNegativeCsvMatchType('Exact')).toBe('Negative Exact');
      expect(toNegativeCsvMatchType('Phrase')).toBe('Negative Phrase');
    });
  });

  describe('blankRow', () => {
    test('returns object with all 176 columns', () => {
      const row = blankRow();
      expect(Object.keys(row)).toHaveLength(176);
    });

    test('all values are empty strings', () => {
      const row = blankRow();
      for (const col of COLS) {
        expect(row[col]).toBe('');
      }
    });

    test('returns a new object each call', () => {
      const a = blankRow();
      const b = blankRow();
      expect(a).not.toBe(b);
      a['Campaign'] = 'test';
      expect(b['Campaign']).toBe('');
    });
  });
});
