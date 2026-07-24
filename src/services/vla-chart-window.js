/**
 * VLA Chart Window — builds the shared 30-day date axis for the charts page.
 *
 * Called by: src/routes/vla-charts.js
 * Calls: nothing
 *
 * Why this exists: GAQL omits days with zero activity, so a campaign that only
 * ran part of the window comes back with a short `days` array. The charts page
 * derives each dealer card's x-axis from the union of that dealer's campaign
 * dates — so a dealer whose campaigns are all short renders a shorter axis than
 * 30 days, and a day where every campaign was dark disappears from the axis
 * entirely (distorting the time scale). Densifying to one continuous window
 * makes every chart span the identical range: yesterday back 30 days.
 */

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;

/** @param {Date} d @returns {string} YYYY-MM-DD (UTC) */
function toIso(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Builds a continuous list of dates ending at (and including) the anchor.
 *
 * @param {string} anchorDate - YYYY-MM-DD, the last day in the window (yesterday)
 * @param {number} [days=30] - window length
 * @returns {string[]} ascending YYYY-MM-DD, length `days`, no gaps
 */
function buildDateWindow(anchorDate, days = WINDOW_DAYS) {
  const end = new Date(anchorDate + 'T00:00:00Z').getTime();
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(toIso(new Date(end - i * DAY_MS)));
  return out;
}

/**
 * Max date present across every dealer's campaigns. Google resolves
 * LAST_30_DAYS in each account's own timezone, so deriving "yesterday" from the
 * returned data avoids guessing timezones server-side.
 *
 * @param {Array<{campaigns: Array<{days: Array<{date: string}>}>}>} dealers
 * @returns {string|null} YYYY-MM-DD, or null if there is no data at all
 */
function latestDate(dealers) {
  let max = null;
  for (const d of dealers || []) {
    for (const c of d.campaigns || []) {
      for (const day of c.days || []) {
        if (day?.date && (max === null || day.date > max)) max = day.date;
      }
    }
  }
  return max;
}

/**
 * Re-projects each campaign's days onto `dates`, zero-filling gaps, so every
 * campaign spans the identical continuous axis.
 *
 * @param {Array<{campaignId: string, name: string, days: Array<Object>}>} campaigns
 * @param {string[]} dates - the shared window from buildDateWindow()
 * @returns {Array<Object>} campaigns with dense, ascending `days`
 */
function densifyCampaigns(campaigns, dates) {
  return (campaigns || []).map((c) => {
    const byDate = new Map((c.days || []).map((d) => [d.date, d]));
    return {
      ...c,
      days: dates.map((date) => {
        const hit = byDate.get(date);
        return hit
          ? { date, clicks: hit.clicks, impressions: hit.impressions, cost: hit.cost }
          : { date, clicks: 0, impressions: 0, cost: 0 };
      }),
    };
  });
}

module.exports = { buildDateWindow, densifyCampaigns, latestDate, WINDOW_DAYS };
