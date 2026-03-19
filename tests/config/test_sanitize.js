/**
 * Tier 1 Sanitize Tests — validates GAQL injection prevention.
 *
 * Tests: src/utils/sanitize.js (sanitizeGaqlString, sanitizeGaqlNumber)
 * No external deps — pure function tests.
 */

const { sanitizeGaqlString, sanitizeGaqlNumber } = require('../../src/utils/sanitize');

describe('sanitizeGaqlString', () => {
  test('passes through a normal campaign name unchanged', () => {
    expect(sanitizeGaqlString('Honda Civic - Search')).toBe('Honda Civic - Search');
  });

  test('passes through names with dashes, spaces, and numbers', () => {
    expect(sanitizeGaqlString('Toyota Trucks 2024 - Display')).toBe('Toyota Trucks 2024 - Display');
  });

  test('strips single quotes', () => {
    expect(sanitizeGaqlString("O'Brien Motors")).toBe('OBrien Motors');
  });

  test('strips double quotes', () => {
    expect(sanitizeGaqlString('Campaign "Test"')).toBe('Campaign Test');
  });

  test('strips backslashes', () => {
    expect(sanitizeGaqlString('path\\to\\campaign')).toBe('pathtocampaign');
  });

  test('strips newlines and carriage returns', () => {
    expect(sanitizeGaqlString('line1\nline2\rline3')).toBe('line1line2line3');
  });

  test('strips null bytes', () => {
    expect(sanitizeGaqlString('test\0injection')).toBe('testinjection');
  });

  test('strips semicolons', () => {
    expect(sanitizeGaqlString('name; DROP TABLE')).toBe('name DROP TABLE');
  });

  test('strips multiple dangerous characters in one input', () => {
    expect(sanitizeGaqlString("test'\\;\n\"")).toBe('test');
  });

  test('throws on non-string input (number)', () => {
    expect(() => sanitizeGaqlString(123)).toThrow('requires a string');
    expect(() => sanitizeGaqlString(123)).toThrow('got number');
  });

  test('throws on non-string input (null)', () => {
    expect(() => sanitizeGaqlString(null)).toThrow('requires a string');
  });

  test('throws on non-string input (undefined)', () => {
    expect(() => sanitizeGaqlString(undefined)).toThrow('requires a string');
  });

  test('throws on empty string', () => {
    expect(() => sanitizeGaqlString('')).toThrow('empty string');
  });

  test('throws on whitespace-only string', () => {
    expect(() => sanitizeGaqlString('   ')).toThrow('empty string');
  });

  test('throws when input becomes empty after stripping dangerous characters', () => {
    expect(() => sanitizeGaqlString("'''")).toThrow('empty after removing');
    expect(() => sanitizeGaqlString('\\\\;')).toThrow('empty after removing');
    expect(() => sanitizeGaqlString('"\'\\"')).toThrow('empty after removing');
  });
});

describe('sanitizeGaqlNumber', () => {
  test('returns a number from a valid integer', () => {
    expect(sanitizeGaqlNumber(42)).toBe(42);
  });

  test('returns a number from a valid float', () => {
    expect(sanitizeGaqlNumber(50.75)).toBe(50.75);
  });

  test('parses a numeric string to number', () => {
    expect(sanitizeGaqlNumber('100')).toBe(100);
  });

  test('parses a float string to number', () => {
    expect(sanitizeGaqlNumber('25.50')).toBe(25.5);
  });

  test('accepts zero', () => {
    expect(sanitizeGaqlNumber(0)).toBe(0);
  });

  test('accepts negative numbers', () => {
    expect(sanitizeGaqlNumber(-10)).toBe(-10);
  });

  test('throws on NaN', () => {
    expect(() => sanitizeGaqlNumber(NaN)).toThrow('finite number');
  });

  test('throws on Infinity', () => {
    expect(() => sanitizeGaqlNumber(Infinity)).toThrow('finite number');
  });

  test('throws on non-numeric string', () => {
    expect(() => sanitizeGaqlNumber('abc')).toThrow('finite number');
    expect(() => sanitizeGaqlNumber('abc')).toThrow('abc');
  });

  test('throws on empty string', () => {
    expect(() => sanitizeGaqlNumber('')).toThrow('finite number');
  });

  test('throws on null (prevents silent conversion to 0)', () => {
    expect(() => sanitizeGaqlNumber(null)).toThrow('null');
  });

  test('throws on undefined', () => {
    expect(() => sanitizeGaqlNumber(undefined)).toThrow('undefined');
  });

  test('throws on boolean true (prevents silent conversion to 1)', () => {
    expect(() => sanitizeGaqlNumber(true)).toThrow('boolean');
  });

  test('throws on boolean false (prevents silent conversion to 0)', () => {
    expect(() => sanitizeGaqlNumber(false)).toThrow('boolean');
  });

  test('throws on negative Infinity', () => {
    expect(() => sanitizeGaqlNumber(-Infinity)).toThrow('finite number');
  });
});
