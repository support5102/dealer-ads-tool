/**
 * Pacing Engine Runner — scheduled daily entry point.
 *
 * Called by: scheduler.registerJob('pacing-engine-daily', ...) in server.js.
 * Calls: pacing-engine-v2.runForAccount for each account, change-history.addEntry
 *        (via runForAccount's logChange dep), and the caller-provided
 *        applyBudgetChange (real Google Ads mutation, wired in Task 8.2).
 *
 * Skipped if config.pacingEngineV2Enabled is false.
 */

const config = require('../utils/config');
const changeHistory = require('./change-history');
const pacingEngineV2 = require('./pacing-engine-v2');

/**
 * Runs the engine against all known accounts.
 *
 * @param {Object} deps
 * @param {Function} deps.listAccounts - Async () => [{ account, goal, mtdSpend, ... }]
 * @param {Function} deps.applyBudgetChange - Async (customerId, newDaily) => {...}
 * @returns {Promise<{processed: number, applied: number, skipped: number, errors: number, disabled?: boolean}>}
 */
async function run(deps) {
  if (!config.pacingEngineV2Enabled) {
    console.log('[pacing-engine-v2] disabled via PACING_ENGINE_V2_ENABLED; skipping run');
    return { processed: 0, applied: 0, skipped: 0, errors: 0, disabled: true };
  }

  const accounts = await deps.listAccounts();
  const summary = { processed: 0, applied: 0, skipped: 0, errors: 0 };

  for (const account of accounts) {
    summary.processed += 1;
    try {
      const result = await pacingEngineV2.runForAccount(account, {
        now: new Date(),
        applyBudgetChange: deps.applyBudgetChange,
        logChange: (entry) => changeHistory.addEntry(entry),
      });
      if (result.applied) summary.applied += 1;
      if (result.skipped) summary.skipped += 1;
      if (result.error) summary.errors += 1;
    } catch (err) {
      summary.errors += 1;
      console.error(`[pacing-engine-v2] account ${account.customerId} failed:`, err.message);
    }
  }

  console.log('[pacing-engine-v2] run complete', summary);
  return summary;
}

module.exports = { run };
