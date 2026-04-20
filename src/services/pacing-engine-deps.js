/**
 * Pacing Engine Deps — enriches the pacing-overview results with the fields
 * runForAccount needs (currentDailyBudget + bidStrategyType). Kept separate
 * from pacing-fetcher because the existing pacing-fetcher is used by many
 * consumers and this enrichment is v2-engine-specific.
 *
 * Called by: routes/pacing.js (?advise=true hook).
 * Calls: google-ads.getAccountLevelDailyBudget.
 */

const googleAds = require('./google-ads');

/**
 * Enriches pacing-overview results with engine-required fields.
 *
 * @param {Object} ctx - { accessToken, developerToken, loginCustomerId }
 * @param {Object[]} results - Output of fetchAccountPacing, one per account
 * @returns {Promise<Object[]>} Each: { customerId, dealerName, goal, mtdSpend,
 *   currentDailyBudget, bidStrategyType, lastChangeTimestamp }
 */
async function listAccountsFromResults(ctx, results) {
  const out = [];
  for (const r of results) {
    try {
      const budgetInfo = await googleAds.getAccountLevelDailyBudget({
        accessToken: ctx.accessToken,
        developerToken: ctx.developerToken,
        customerId: String(r.customerId).replace(/-/g, ''),
        loginCustomerId: ctx.loginCustomerId,
      });
      out.push({
        customerId: r.customerId,
        dealerName: r.dealerName,
        goal: {
          dealerName: r.dealerName,
          monthlyBudget: r.monthlyBudget,
          pacingMode: r.pacingMode || 'one_click',
          pacingCurveId: r.pacingCurveId || 'linear',
        },
        mtdSpend: r.mtdSpend,
        currentDailyBudget: budgetInfo.totalDailyBudget,
        bidStrategyType: budgetInfo.primaryBidStrategy || 'MAXIMIZE_CLICKS',
        lastChangeTimestamp: r.changeDate ? `${r.changeDate}T00:00:00Z` : null,
      });
    } catch (err) {
      console.warn(`[pacing-engine] skip ${r.dealerName}: ${err.message}`);
    }
  }
  return out;
}

module.exports = { listAccountsFromResults };
