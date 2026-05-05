/**
 * MCC Recommendation Aggregator — fan-out across all child accounts.
 *
 * Walks the provided accounts list sequentially. For each account, fetches active
 * recommendations and classifies them via the existing recommendation-dismisser.
 * Aggregates per-type counts across accounts. Per-account errors never abort; they
 * are captured in errorsByDealer.
 *
 * Called by: src/routes/optimization.js (GET /api/all-accounts/recommendations)
 */

const { classifyRecommendations } = require('./recommendation-dismisser');

/**
 * @param {Object}   args
 * @param {Array<{ customerId: string, name: string }>} args.accounts
 * @param {Function} args.buildRestCtx - (account) => restCtx
 * @param {Function} args.getRecs      - (restCtx) => Promise<rec[]>
 * @returns {Promise<{ quickClear, review, errorsByDealer }>}
 */
async function aggregateRecommendations({ accounts, buildRestCtx, getRecs }) {
  const quickClearMap = new Map();
  const reviewMap = new Map();
  const errorsByDealer = [];

  for (const account of accounts) {
    let recs;
    try {
      const restCtx = await buildRestCtx(account);
      recs = await getRecs(restCtx);
    } catch (err) {
      errorsByDealer.push({
        customerId: account.customerId,
        dealerName: account.name,
        error: err.message,
      });
      continue;
    }

    const { toDismiss, toReview } = classifyRecommendations(recs);
    accumulate(quickClearMap, toDismiss, account);
    accumulate(reviewMap, toReview, account);
  }

  return {
    quickClear: Array.from(quickClearMap.values()).sort((a, b) => b.count - a.count),
    review: Array.from(reviewMap.values()).sort((a, b) => b.count - a.count),
    errorsByDealer,
  };
}

function accumulate(map, recs, account) {
  for (const rec of recs) {
    let bucket = map.get(rec.type);
    if (!bucket) {
      bucket = { type: rec.type, count: 0, items: [] };
      map.set(rec.type, bucket);
    }
    bucket.count += 1;
    bucket.items.push({
      customerId: account.customerId,
      dealerName: account.name,
      resourceName: rec.resourceName,
    });
  }
}

module.exports = { aggregateRecommendations };
