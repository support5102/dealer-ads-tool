/**
 * MCC Auto-Asset Aggregator — fan-out across child accounts and group by type.
 *
 * Returns { types: { HEADLINE: { count, dealers, items }, ... }, errorsByDealer }.
 * Only types with count > 0 are included.
 *
 * Called by: src/routes/optimization.js (GET /api/all-accounts/auto-assets)
 */

/**
 * @param {Object}   args
 * @param {Array<{ customerId: string, name: string }>} args.accounts
 * @param {Function} args.buildRestCtx
 * @param {Function} args.getAssets - (restCtx) => Promise<asset[]>
 */
async function aggregateAutoAssets({ accounts, buildRestCtx, getAssets }) {
  const typeMap = new Map();
  const errorsByDealer = [];

  for (const account of accounts) {
    let assets;
    try {
      const restCtx = await buildRestCtx(account);
      assets = await getAssets(restCtx);
    } catch (err) {
      errorsByDealer.push({
        customerId: account.customerId,
        dealerName: account.name,
        error: err.message,
      });
      continue;
    }

    for (const a of assets) {
      let bucket = typeMap.get(a.type);
      if (!bucket) {
        bucket = { count: 0, dealerSet: new Set(), items: [] };
        typeMap.set(a.type, bucket);
      }
      bucket.count += 1;
      bucket.dealerSet.add(account.customerId);
      bucket.items.push({
        resourceName: a.resourceName,
        text: a.text,
        scope: a.scope,
        customerId: account.customerId,
        dealerName: account.name,
      });
    }
  }

  const types = {};
  for (const [type, bucket] of typeMap.entries()) {
    types[type] = {
      count: bucket.count,
      dealers: bucket.dealerSet.size,
      items: bucket.items,
    };
  }
  return { types, errorsByDealer };
}

module.exports = { aggregateAutoAssets };
