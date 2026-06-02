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
 * Returns the current date in America/New_York (Eastern).
 *
 * `daysCompleted` is the count of FULLY-elapsed days this month — at any time
 * on day-2 it returns 1 (only day-1 has fully completed). Only ticks up at
 * midnight ET when the previous day officially closes out. The pacing math
 * uses this so the target stays steady all day instead of jumping every 24h.
 *
 * `todayStr` is the ET-local YYYY-MM-DD string for "today", used to identify
 * and subtract today's in-progress spend from MTD for an apples-to-apples
 * comparison against "expected spend through end of yesterday."
 */
function nowInEastern(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = parseInt(p.value, 10);
    return acc;
  }, {});
  return {
    year: parts.year,
    month: parts.month,
    dayOfMonth: parts.day,
    daysCompleted: parts.day - 1,
    todayStr: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
  };
}

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

  const [campaignSpend, dailySpend, todaySpend, changeDateLocal, changeDateGoogle] = await Promise.all([
    googleAds.getMonthSpend(restCtx),
    googleAds.getDailySpendLast14Days(restCtx),
    // Today's spend (customer-local TZ via Google's `DURING TODAY`). Separate
    // dedicated query — getMonthSpend's returned rows don't carry a usable
    // date field on every row, so we can't compute today's spend by filtering
    // its results.
    googleAds.getTodaySpend(restCtx).catch(() => 0),
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
  // "Completed days" pacing: the pacing math only compares against fully-elapsed
  // days. Today's in-progress spend is excluded from the comparison so the
  // numerator and denominator are apples-to-apples (both "through end of
  // yesterday"). Brian's request: "make it cap at 11:59pm so it has a full day
  // of data before counting it as a day passed." Eastern Time is used as the
  // day boundary so the midnight tick aligns with most dealers' business day.
  //
  // Today's spend comes from campaignSpend's per-day/per-campaign rows (which
  // include today) — getDailySpendLast14Days explicitly excludes today, so it
  // can't be the source.
  const now = new Date();
  const et = nowInEastern(now);
  const mtdSpendThruYesterday = Math.max(mtdSpend - todaySpend, 0);

  const pacing = calculatePacing({
    monthlyBudget: goal.monthlyBudget,
    spendToDate: mtdSpendThruYesterday,
    year: et.year,
    month: et.month,
    currentDay: et.daysCompleted,
    currentInventory: null,
    baselineInventory: null,
  });
  // Entire pacing row reflects "through end of yesterday" — MTD Spend,
  // Remaining Budget, Pacing %, Daily Adj. all line up against the same closed-
  // out window. Today's in-progress spend doesn't show in any column until
  // midnight ET, when yesterday's totals are confirmed and the row ticks over.

  const trend = calculateSevenDayTrend(dailySpend);
  const projection = calculateProjection({
    monthlyBudget: goal.monthlyBudget,
    mtdSpend: mtdSpendThruYesterday,
    dailySpend,
    changeDate: lastChange.changeDate,
    year: et.year,
    month: et.month,
    currentDay: et.daysCompleted,
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
