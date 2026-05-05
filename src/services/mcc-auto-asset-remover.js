/**
 * MCC Auto-Asset Remover — orchestrates bulk asset removal across MCC accounts.
 */

const changeHistory = require('./change-history');

async function removeByTypes({ types, accounts, buildRestCtx, getAssets, removeFn, devMode, userEmail }) {
  const errorsByDealer = [];
  let removed = 0;

  if (!types || types.length === 0) {
    return { removed: 0, errorsByDealer, devModeBlocked: !!devMode };
  }

  const typeSet = new Set(types);

  for (const account of accounts) {
    try {
      const restCtx = await buildRestCtx(account);
      const allAssets = await getAssets(restCtx);
      const matching = allAssets.filter(a => typeSet.has(a.type));
      if (matching.length === 0) continue;

      const resourceNames = matching.map(a => a.resourceName);
      let countForThisAccount = resourceNames.length;
      if (!devMode) {
        const result = await removeFn(restCtx, resourceNames);
        countForThisAccount = result.removed;
      }

      changeHistory.addEntry({
        action: 'remove_auto_assets',
        userEmail,
        accountId: account.customerId,
        dealerName: account.name,
        details: {
          operation: 'remove_auto_assets',
          by: 'type',
          types: Array.from(typeSet),
          count: countForThisAccount,
          devModeBlocked: !!devMode,
        },
        source: 'all-accounts-cleanup',
        success: true,
      });

      if (!devMode) removed += countForThisAccount;
    } catch (err) {
      errorsByDealer.push({
        customerId: account.customerId,
        dealerName: account.name,
        error: err.message,
      });
      changeHistory.addEntry({
        action: 'remove_auto_assets',
        userEmail,
        accountId: account.customerId,
        dealerName: account.name,
        details: { operation: 'remove_auto_assets', by: 'type', types: Array.from(typeSet), devModeBlocked: !!devMode },
        source: 'all-accounts-cleanup',
        success: false,
        error: err.message,
      });
    }
  }

  return {
    removed: devMode ? 0 : removed,
    errorsByDealer,
    devModeBlocked: !!devMode,
  };
}

module.exports = { removeByTypes };
