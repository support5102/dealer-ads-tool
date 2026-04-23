/**
 * OEM Catalog — thin lookup layer over src/data/oem-models.json.
 *
 * Used by Account Builder v2 to enumerate every new model a brand currently
 * offers. When you build an account for a Ford store, the builder asks this
 * module for Ford's model list → one campaign per model.
 *
 * Brand matching is alias-aware and case-insensitive:
 *   getBrand('chevy')       → { key: 'chevrolet', displayName: 'Chevrolet', ... }
 *   getBrand('Ford Motor')  → { key: 'ford', displayName: 'Ford', ... }
 *
 * To add/remove a model: edit src/data/oem-models.json. No code change needed.
 */

const catalog = require('../data/oem-models.json');

/**
 * Normalizes a brand string for matching (lowercase, trim, collapse spaces).
 * @param {string} s
 * @returns {string}
 */
function normalize(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Looks up a brand entry by name or alias.
 *
 * @param {string} name - Brand name or alias (e.g. "Ford", "chevy", "VW")
 * @returns {{key: string, displayName: string, aliases: string[], models: string[]} | null}
 */
function getBrand(name) {
  const n = normalize(name);
  if (!n) return null;

  for (const [key, entry] of Object.entries(catalog)) {
    if (key === '_meta') continue;
    if (key === n) return { key, ...entry };
    if (Array.isArray(entry.aliases) && entry.aliases.some(a => normalize(a) === n)) {
      return { key, ...entry };
    }
  }
  return null;
}

/**
 * Returns the list of current new-model names for a brand, or null if unknown.
 *
 * @param {string} name
 * @returns {string[] | null}
 */
function getModels(name) {
  const brand = getBrand(name);
  return brand ? [...brand.models] : null;
}

/**
 * Lists all known brand keys (lowercase canonical names).
 * @returns {string[]}
 */
function listBrandKeys() {
  return Object.keys(catalog).filter(k => k !== '_meta');
}

/**
 * Returns metadata about the catalog (last updated, etc.).
 * @returns {object}
 */
function getMeta() {
  return catalog._meta || {};
}

module.exports = {
  getBrand,
  getModels,
  listBrandKeys,
  getMeta,
};
