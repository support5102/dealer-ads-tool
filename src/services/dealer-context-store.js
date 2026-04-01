/**
 * Dealer Context Store — in-memory cache of extracted dealer preferences and constraints.
 *
 * Called by: routes/budget-adjustments.js, services/adjustment-generator.js,
 *           services/audit-engine.js
 *
 * Stores structured context per dealer (keyed by Google Ads customer ID).
 * Context is extracted from Google Sheet "Dealer Notes" column and optionally
 * from Freshdesk ticket history (Phase 2).
 *
 * In-memory only — resets on server restart, rebuilt on next budget scan.
 */

const store = new Map(); // accountId -> DealerContext

/**
 * @typedef {Object} DealerContext
 * @property {string} dealerName
 * @property {string[]} priorities - e.g., ["push Ram trucks", "increase brand spend"]
 * @property {BudgetConstraint[]} budgetConstraints
 * @property {ModelFocus[]} modelFocus
 * @property {string[]} seasonalNotes
 * @property {PerformanceFeedback[]} performanceFeedback
 * @property {number} confidence - 0.0-1.0
 * @property {Object} _meta
 */

/**
 * Saves dealer context for an account.
 *
 * @param {string} accountId - Google Ads customer ID
 * @param {Object} context - Structured dealer context
 */
function save(accountId, context) {
  const clean = String(accountId).replace(/-/g, '');
  store.set(clean, {
    ...context,
    _meta: {
      ...(context._meta || {}),
      storedAt: new Date().toISOString(),
    },
  });
}

/**
 * Gets dealer context for an account.
 *
 * @param {string} accountId - Google Ads customer ID
 * @returns {Object|null} Dealer context or null
 */
function getContext(accountId) {
  const clean = String(accountId).replace(/-/g, '');
  return store.get(clean) || null;
}

/**
 * Gets budget constraints matching a specific campaign type.
 *
 * @param {string} accountId - Google Ads customer ID
 * @param {string} campaignType - From campaign-classifier (e.g., 'vla', 'brand')
 * @param {string} [campaignName] - Specific campaign name for name-based constraints
 * @returns {Object[]} Matching budget constraints
 */
function getConstraints(accountId, campaignType, campaignName) {
  const ctx = getContext(accountId);
  if (!ctx || !ctx.budgetConstraints) return [];

  return ctx.budgetConstraints.filter(c => {
    if (c.scope === 'account') return true;
    if (c.scope === 'campaign_type') {
      return c.target.toLowerCase() === campaignType.toLowerCase();
    }
    if (c.scope === 'campaign_name' && campaignName) {
      return campaignName.toLowerCase().includes(c.target.toLowerCase());
    }
    return false;
  });
}

/**
 * Gets model focus priorities for an account.
 *
 * @param {string} accountId
 * @returns {Object[]} Array of { model, action, reason }
 */
function getModelFocus(accountId) {
  const ctx = getContext(accountId);
  return ctx?.modelFocus || [];
}

/**
 * Returns all stored contexts.
 */
function getAll() {
  const results = [];
  for (const [accountId, context] of store) {
    results.push({ accountId, ...context });
  }
  return results;
}

function size() { return store.size; }
function clear() { store.clear(); }

module.exports = {
  save,
  getContext,
  getConstraints,
  getModelFocus,
  getAll,
  size,
  clear,
};
