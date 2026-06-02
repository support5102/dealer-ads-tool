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
const changeHistory = require('./change-history');
const { calculatePacing, calculateSevenDayTrend, calculateProjection, daysInMonth } = require('./pacing-calculator');
const { cumulativeTarget } = require('./pacing-curve');
const config = (() => {
  try { return require('../utils/config').validateEnv(); } catch { return { pacingEngineV2Enabled: false }; }
})();

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

  const [campaignSpend, dailySpend, changeDateLocal, changeDateGoogle] = await Promise.all([
    googleAds.getMonthSpend(restCtx),
    googleAds.getDailySpendLast14Days(restCtx),
    // Source A: local DB — every tool-driven budget change (modal saves into
    // dealer_budget_changes + runner updates into change_history).
    changeHistory.getLastBudgetChangeForDealer(account.name).catch(() => null),
    // Source B: Google Ads change_event API — every change made directly in the
    // Google Ads UI, by Google reps, by Editor, by other vendors. Up to 28 days
    // back (Google's 30-day retention limit). Returns customer-local-TZ date.
    googleAds.getLastBudgetChange(restCtx).then(r => r.changeDate).catch(() => null),
  ]);
  // Take whichever change happened most recently. Sorting YYYY-MM-DD strings
  // works lexicographically — same as date order.
  const dates = [changeDateLocal, changeDateGoogle].filter(Boolean).sort().reverse();
  const lastChange = { changeDate: dates[0] || null };

  const mtdSpend = campaignSpend.reduce((sum, c) => sum + c.spend, 0);
  // TODO(8.2): align timezone handling with computeSinceLastChange (which uses UTC).
  // Existing calls below use local time; may disagree by ±1 day around midnight ET.
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

  const { groupFor } = require('./dealer-groups-store');
  const group = groupFor(account.name);

  const since = computeSinceLastChange({
    dailySpend,
    changeDate: lastChange.changeDate,
    monthlyBudget: goal.monthlyBudget,
    curveId: goal.pacingCurveId || group.curve,
    today: now,
  });

  // ── V2 inventory enrichment (feature-flagged, non-fatal) ─────────────────
  let inventoryEnrichment = null;
  if (config.pacingEngineV2Enabled) {
    try {
      const siteIdRegistry = require('./site-id-registry');
      const savvyInventory = require('./savvy-inventory');
      const baselineStore = require('./inventory-baseline-store');

      const mapping = siteIdRegistry.siteIdFor(account.name);
      if (mapping && mapping.siteId) {
        const newVinCount = await savvyInventory.getNewVinCount(mapping.siteId);
        const baseline = await baselineStore.getBaseline(account.name);
        const tier = baselineStore.classifyTier({
          newVinCount,
          baseline,
        });
        inventoryEnrichment = {
          newVinCount,
          baselineRolling90Day: baseline ? baseline.rolling90DayAvg : null,
          tier,
        };
      }
    } catch (err) {
      // Inventory enrichment is non-fatal. Log and continue.
      console.warn(`[pacing-fetcher] inventory enrichment failed for ${account.name}:`, err.message);
    }
  }

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
    daysSinceLastChange: since.daysSinceLastChange,
    pacingSinceLastChange: since.pacingSinceLastChange,
    pacingCurveId: goal.pacingCurveId || group.curve,
    pacingMode: goal.pacingMode || 'one_click',
    groupKey: group.key,
    groupLabel: group.label,
    ...(inventoryEnrichment ? { inventory: inventoryEnrichment } : {}),
  };
}

/**
 * Computes "pacing since last budget change" and "days since last change"
 * column values for the pacing overview.
 *
 * Pacing % = (actual spend between changeDate+1 and today-1) / (curve-expected
 * spend over the same window) × 100. Both endpoints exclusive so the %
 * reflects days the new budget was in effect for the full day.
 *
 * @param {Object} params
 * @param {Object[]} params.dailySpend - [{ date: 'YYYY-MM-DD', spend: Number }]
 * @param {string|null} params.changeDate - 'YYYY-MM-DD' of last change, or null
 * @param {number} params.monthlyBudget - Monthly budget ($)
 * @param {string} params.curveId - Curve ID (default 'linear')
 * @param {Date} params.today - Current date (UTC)
 * @returns {{ daysSinceLastChange: number|null, pacingSinceLastChange: number|null }}
 */
function computeSinceLastChange({ dailySpend, changeDate, monthlyBudget, curveId, today }) {
  if (!changeDate) {
    return { daysSinceLastChange: null, pacingSinceLastChange: null };
  }

  const changeDt = new Date(`${changeDate}T00:00:00Z`);
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysSinceLastChange = Math.max(0, Math.floor((today.getTime() - changeDt.getTime()) / msPerDay));

  // Spend strictly after change date (exclusive of change day itself, since
  // the new budget didn't take effect until the day after).
  const dayAfterChange = new Date(changeDt.getTime() + msPerDay).toISOString().slice(0, 10);
  const postChange = (dailySpend || []).filter(d => d.date >= dayAfterChange && d.date < today.toISOString().slice(0, 10));
  const postChangeTotal = postChange.reduce((s, d) => s + (d.spend || 0), 0);

  if (postChange.length === 0) {
    return { daysSinceLastChange, pacingSinceLastChange: null };
  }

  // Expected spend at the post-change daily rate × the actual days elapsed since
  // the change. This is month-agnostic: a change on May 27 with 4 days of June
  // spend data computes correctly, whereas the previous curve-based math returned
  // 0 because it tried to use within-month day numbers (changeDayOfMonth=27,
  // todayOfMonth-1=0 → max=27, both cumulative-target lookups landed on the same
  // point on the curve, so expectedSinceChange came out as 0).
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
  const totalDays = daysInMonth(year, month);
  const dailyRate = monthlyBudget / totalDays;
  const expectedSinceChange = dailyRate * postChange.length;
  // curveId intentionally unused — uniform daily rate is simpler and cross-month
  // accurate. (Pacing curves only model within-month spend distribution.)
  void curveId;

  if (expectedSinceChange <= 0) {
    return { daysSinceLastChange, pacingSinceLastChange: null };
  }

  const pct = (postChangeTotal / expectedSinceChange) * 100;
  return {
    daysSinceLastChange,
    pacingSinceLastChange: Math.round(pct * 10) / 10,
  };
}

module.exports = { fetchAccountPacing, computeSinceLastChange };
