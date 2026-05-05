/**
 * MCC Recommendation Dismisser — orchestrates bulk dismiss across MCC accounts.
 *
 * `dismissByType`: for each account, fetch active recs, filter to a single type,
 * call dismissFn once with the filtered IDs.
 *
 * `dismissSelected`: groups input items by customerId, calls dismissFn once per
 * account with that account's resource names.
 *
 * Both DEV_MODE-aware: when devMode=true, skip the dismissFn call but still write
 * to change_history with details.devModeBlocked=true so dev runs are visible.
 */

const changeHistory = require('./change-history');

async function dismissByType({ type, accounts, buildRestCtx, getRecs, dismissFn, devMode, userEmail }) {
  const errorsByDealer = [];
  let dismissed = 0;

  for (const account of accounts) {
    try {
      const restCtx = await buildRestCtx(account);
      const recs = await getRecs(restCtx);
      const matching = recs.filter(r => r.type === type).map(r => r.resourceName);

      let countForThisAccount = 0;
      if (matching.length > 0) {
        if (!devMode) {
          const result = await dismissFn(restCtx, matching);
          countForThisAccount = result.dismissed;
        } else {
          countForThisAccount = matching.length;
        }
      }

      changeHistory.addEntry({
        action: 'dismiss_recommendations',
        userEmail,
        accountId: account.customerId,
        dealerName: account.name,
        details: {
          operation: 'dismiss_recommendations',
          by: 'type',
          rec_type: type,
          count: countForThisAccount,
          devModeBlocked: !!devMode,
        },
        source: 'all-accounts-cleanup',
        success: true,
      });

      if (!devMode) dismissed += countForThisAccount;
    } catch (err) {
      errorsByDealer.push({
        customerId: account.customerId,
        dealerName: account.name,
        error: err.message,
      });
      changeHistory.addEntry({
        action: 'dismiss_recommendations',
        userEmail,
        accountId: account.customerId,
        dealerName: account.name,
        details: { operation: 'dismiss_recommendations', by: 'type', rec_type: type, devModeBlocked: !!devMode },
        source: 'all-accounts-cleanup',
        success: false,
        error: err.message,
      });
    }
  }

  return {
    dismissed: devMode ? 0 : dismissed,
    errorsByDealer,
    devModeBlocked: !!devMode,
  };
}

async function dismissSelected({ items, accounts, buildRestCtx, dismissFn, devMode, userEmail }) {
  const errorsByDealer = [];
  let dismissed = 0;

  const byAccount = new Map();
  for (const item of items) {
    if (!byAccount.has(item.customerId)) byAccount.set(item.customerId, []);
    byAccount.get(item.customerId).push(item.resourceName);
  }

  for (const [customerId, resourceNames] of byAccount.entries()) {
    const account = accounts.find(a => a.customerId === customerId);
    if (!account) continue;
    try {
      const restCtx = await buildRestCtx(account);
      let countForThisAccount = resourceNames.length;
      if (!devMode) {
        const result = await dismissFn(restCtx, resourceNames);
        countForThisAccount = result.dismissed;
      }

      changeHistory.addEntry({
        action: 'dismiss_recommendations',
        userEmail,
        accountId: account.customerId,
        dealerName: account.name,
        details: {
          operation: 'dismiss_recommendations',
          by: 'selected',
          count: countForThisAccount,
          devModeBlocked: !!devMode,
        },
        source: 'all-accounts-cleanup',
        success: true,
      });

      if (!devMode) dismissed += countForThisAccount;
    } catch (err) {
      errorsByDealer.push({
        customerId: account.customerId,
        dealerName: account.name,
        error: err.message,
      });
      changeHistory.addEntry({
        action: 'dismiss_recommendations',
        userEmail,
        accountId: account.customerId,
        dealerName: account.name,
        details: { operation: 'dismiss_recommendations', by: 'selected', devModeBlocked: !!devMode },
        source: 'all-accounts-cleanup',
        success: false,
        error: err.message,
      });
    }
  }

  return {
    dismissed: devMode ? 0 : dismissed,
    errorsByDealer,
    devModeBlocked: !!devMode,
  };
}

module.exports = { dismissByType, dismissSelected };
