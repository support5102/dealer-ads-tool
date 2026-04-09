/**
 * Pacing Fetcher — shared helper that fetches and computes pacing data
 * for a single account.
 *
 * Used by: routes/pacing.js (GET /api/pacing/all)
 *          routes/budget-adjustments.js (Phase 2 scan)
 *
 * Extracts the inline fetchAccountPacing() from the /api/pacing/all route
 * so both the overview and the adjustment scanner can use it.
 */

const googleAds = require('./google-ads');
const { calculatePacing, calculateSevenDayTrend, calculateProjection } = require('./pacing-calculator');

/**
 * Fetches spend data from Google Ads and computes pacing metrics for one account.
 *
 * @param {Object} params
 * @param {Object} params.account - { id, name } from Google Ads MCC
 * @param {Object} params.goal - { dealerName, monthlyBudget, ... } from goal-reader
 * @param {string} params.accessToken - OAuth access token
 * @param {string} params.developerToken - Google Ads developer token
 * @param {string} params.loginCustomerId - MCC ID
 * @returns {Object} Pacing data for the account
 */
async function fetchAccountPacing({ account, goal, accessToken, developerToken, loginCustomerId }) {
  const restCtx = {
    accessToken,
    developerToken,
    customerId: account.id.replace(/-/g, ''),
    loginCustomerId,
  };

  const [campaignSpend, dailySpend, lastChange] = await Promise.all([
    googleAds.getMonthSpend(restCtx),
    googleAds.getDailySpendLast14Days(restCtx),
    googleAds.getLastBudgetChange(restCtx).catch(() => ({ changeDate: null })),
  ]);

  const mtdSpend = campaignSpend.reduce((sum, c) => sum + c.spend, 0);
  const now = new Date();
  const pacing = calculatePacing({
    monthlyBudget: goal.monthlyBudget,
    spendToDate: mtdSpend,
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    currentDay: now.getDate(),
    currentInventory: null,
    baselineInventory: null,
  });

  const trend = calculateSevenDayTrend(dailySpend);
  const projection = calculateProjection({
    monthlyBudget: goal.monthlyBudget,
    mtdSpend,
    dailySpend,
    changeDate: lastChange.changeDate,
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    currentDay: now.getDate(),
  });

  return {
    customerId: account.id,
    dealerName: account.name,
    monthlyBudget: goal.monthlyBudget,
    mtdSpend: Math.round(mtdSpend * 100) / 100,
    pacePercent: pacing.pacePercent,
    status: pacing.paceStatus,
    dailyAdjustment: Math.round((pacing.requiredDailyRate - pacing.dailyAvgSpend) * 100) / 100,
    sevenDayAvg: trend.sevenDayAvg,
    sevenDayTrend: trend.sevenDayTrend,
    sevenDayTrendPercent: trend.sevenDayTrendPercent,
    projectedSpend: projection.projectedSpend,
    projectedStatus: projection.projectedStatus,
    postChangeDailyAvg: projection.postChangeDailyAvg,
    changeDate: projection.changeDate,
  };
}

module.exports = { fetchAccountPacing };
