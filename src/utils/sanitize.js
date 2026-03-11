/**
 * Sanitize — prevents GAQL injection in Google Ads API queries.
 *
 * Called by: services/google-ads.js, services/change-executor.js
 * Calls: nothing (pure functions)
 *
 * V2 used simple single-quote escaping: name.replace(/'/g, "\\'")
 * This was insufficient — GAQL strings can be broken with backslashes,
 * newlines, or other control characters. This module provides proper
 * sanitization for any value interpolated into a GAQL query.
 */

/**
 * Sanitizes a string value for safe use in a GAQL query.
 * Removes characters that could break out of a GAQL string literal.
 *
 * @param {string} value - The raw string to sanitize
 * @returns {string} Sanitized string safe for GAQL interpolation
 * @throws {Error} If value is not a string or is empty
 */
function sanitizeGaqlString(value) {
  if (typeof value !== 'string') {
    throw new Error(
      `GAQL sanitization requires a string, got ${typeof value}. ` +
      'Check that campaign/ad group names are strings before querying.'
    );
  }

  if (value.trim() === '') {
    throw new Error(
      'GAQL sanitization received an empty string. ' +
      'Campaign and ad group names cannot be blank.'
    );
  }

  // Remove characters that can break GAQL string literals:
  // - Backslashes (escape character)
  // - Single quotes (string delimiter in GAQL)
  // - Double quotes
  // - Newlines and carriage returns
  // - Null bytes
  // - Semicolons (statement separator)
  const sanitized = value
    .replace(/\\/g, '')
    .replace(/'/g, '')
    .replace(/"/g, '')
    .replace(/[\n\r\0]/g, '')
    .replace(/;/g, '');

  if (sanitized.trim() === '') {
    throw new Error(
      'GAQL value is empty after removing dangerous characters. ' +
      'The original value contained only special characters.'
    );
  }

  return sanitized;
}

/**
 * Validates that a numeric value is safe for GAQL interpolation.
 *
 * @param {string|number} value - The numeric value to validate
 * @returns {number} The validated number
 * @throws {Error} If value is not a finite number
 */
function sanitizeGaqlNumber(value) {
  if (value === null || value === undefined || typeof value === 'boolean') {
    throw new Error(
      `GAQL numeric value must be a finite number, got ${String(value)} (${typeof value}). ` +
      'Check that budget amounts and IDs are valid numbers.'
    );
  }
  if (value === '' || (typeof value === 'string' && value.trim() === '')) {
    throw new Error(
      'GAQL numeric value must be a finite number, got "". ' +
      'Check that budget amounts and IDs are valid numbers.'
    );
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(
      `GAQL numeric value must be a finite number, got "${value}". ` +
      'Check that budget amounts and IDs are valid numbers.'
    );
  }
  return num;
}

module.exports = { sanitizeGaqlString, sanitizeGaqlNumber };
