/**
 * VLA Monitor — pure detection logic.
 *
 * Called by: services/vla-monitor-runner.js (per-dealer)
 * Calls:     nothing (pure)
 *
 * Given an account's current VLA snapshot (daily metrics, current product
 * disapprovals, total product count), returns an array of alert objects.
 * Comparison is against the trailing-13-day median (Google's own history) —
 * we do NOT store our own day-over-day snapshots. The state machine in
 * vla-alert-store.js decides whether each alert becomes a NEW ticket or
 * extends an existing one.
 *
 * Alert kinds:
 *   FEED_OUTAGE       — ≥90% of products disapproved (catastrophic, top priority)
 *   NEW_DISAPPROVALS  — disapproval signature changed since last seen
 *   SPEND_DROP        — today's spend < 40% of trailing 13-day median AND drop ≥ $20
 *   CLICK_DROP        — today's clicks < 40% of trailing 13-day median AND drop ≥ 5
 */

const crypto = require('crypto');

const THRESHOLDS = {
  // FEED_OUTAGE: 90%+ of products disapproved is a feed-level problem, not
  // per-product. Collapses N per-product alerts into one feed-outage alert.
  feedOutageRatio: 0.9,
  // SPEND_DROP / CLICK_DROP: today's value must be < dropPctOfMedian * median.
  // 0.4 = today must be less than 40% of the trailing median (i.e. a >60% drop).
  dropPctOfMedian: 0.4,
  // Absolute floors to suppress noise on tiny accounts.
  spendDropAbsoluteFloor: 20,    // $
  clickDropAbsoluteFloor: 5,     // clicks
  // Minimum days of trailing history before we judge a drop at all.
  minBaselineDays: 7,
};

/**
 * Computes the median of an array of numbers. Returns 0 for empty arrays.
 */
function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Stable hash of a string — used to give "signature" a fixed length so the
 * DB column doesn't bloat for accounts with thousands of disapproved VINs.
 */
function shortHash(input) {
  return crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, 16);
}

/**
 * Detects VLA issues for one dealer given a fresh snapshot.
 *
 * @param {Object} snapshot
 * @param {Object[]} snapshot.dailyMetrics - [{date, spend, clicks, impressions}] ascending by date
 * @param {Object[]} snapshot.productIssues - [{itemId, status, severityMax, ...}]
 * @param {number}   snapshot.productTotal - Total products on the account (denominator for feed-outage)
 * @param {Object[]} snapshot.vlaCampaigns - [{campaignId, name, channelType, merchantId}]
 * @returns {Object[]} Alerts: [{alert_kind, severity, signature, message, payload}]
 */
function detectAlerts(snapshot) {
  const alerts = [];
  const daily = Array.isArray(snapshot.dailyMetrics) ? snapshot.dailyMetrics : [];
  const issues = Array.isArray(snapshot.productIssues) ? snapshot.productIssues : [];
  const productTotal = Number(snapshot.productTotal || 0);
  const vlaCampaigns = Array.isArray(snapshot.vlaCampaigns) ? snapshot.vlaCampaigns : [];

  // Short-circuit: if there are no VLA campaigns at all, we have nothing to monitor.
  if (vlaCampaigns.length === 0) return alerts;

  // ── FEED_OUTAGE ─────────────────────────────────────────────────────
  // Collapse ALL per-product disapprovals into one alert when the ratio is
  // catastrophic. This is the single biggest noise source if missed (5000+
  // tickets in 10 minutes), so it runs FIRST and short-circuits the
  // per-product NEW_DISAPPROVALS check.
  const errorIssues = issues.filter(i => i.severityMax === 'ERROR' || i.severityMax === 'DEMOTED');
  const errorRatio = productTotal > 0 ? errorIssues.length / productTotal : 0;
  if (productTotal > 10 && errorRatio >= THRESHOLDS.feedOutageRatio) {
    alerts.push({
      alert_kind: 'FEED_OUTAGE',
      severity: 'critical',
      signature: shortHash(`feed-outage:${productTotal}`), // signature stable while outage persists
      message: `Feed outage suspected — ${errorIssues.length} of ${productTotal} products disapproved (${Math.round(errorRatio * 100)}%).`,
      payload: {
        disapproved: errorIssues.length,
        total: productTotal,
        ratio: Math.round(errorRatio * 1000) / 1000,
        sampleItemIds: errorIssues.slice(0, 10).map(i => i.itemId),
      },
    });
    // No NEW_DISAPPROVALS alert when the whole feed is down — the feed-outage
    // ticket is the actionable surface.
  } else {
    // ── NEW_DISAPPROVALS ────────────────────────────────────────────────
    // Signature = stable hash of the sorted set of disapproved item IDs.
    // The state machine compares against the previously-stored signature; if
    // identical we DON'T re-ticket. If changed (new VINs disapproved or
    // existing ones cleared/added), the ticket body gets updated.
    if (errorIssues.length > 0) {
      const ids = errorIssues.map(i => i.itemId).filter(Boolean).sort();
      alerts.push({
        alert_kind: 'NEW_DISAPPROVALS',
        severity: errorIssues.length >= 20 ? 'critical' : 'warning',
        signature: shortHash(ids.join(',')),
        message: `${errorIssues.length} product(s) currently disapproved on VLA campaigns.`,
        payload: {
          count: errorIssues.length,
          sampleItemIds: ids.slice(0, 20),
          severityBreakdown: bucketBy(errorIssues, i => i.severityMax),
        },
      });
    }
  }

  // ── SPEND_DROP / CLICK_DROP ─────────────────────────────────────────
  // Last day in `daily` is treated as the candidate; everything before is
  // baseline. Skip if baseline is too short — Google may not have returned
  // 14 full days for a brand-new account.
  if (daily.length >= THRESHOLDS.minBaselineDays + 1) {
    const candidate = daily[daily.length - 1];
    const baseline = daily.slice(0, -1);
    const spendBaseline = baseline.map(d => Number(d.spend || 0));
    const clickBaseline = baseline.map(d => Number(d.clicks || 0));
    const spendMedian = median(spendBaseline);
    const clickMedian = median(clickBaseline);

    if (spendMedian > THRESHOLDS.spendDropAbsoluteFloor) {
      const today = Number(candidate.spend || 0);
      const drop = spendMedian - today;
      if (today < spendMedian * THRESHOLDS.dropPctOfMedian && drop >= THRESHOLDS.spendDropAbsoluteFloor) {
        alerts.push({
          alert_kind: 'SPEND_DROP',
          severity: drop >= spendMedian * 0.8 ? 'critical' : 'warning',
          // Signature changes only when severity bucket changes — keeps an
          // ongoing drop on the SAME ticket day after day.
          signature: shortHash(`spend-drop:${drop >= spendMedian * 0.8 ? 'critical' : 'warning'}`),
          message: `VLA spend dropped to $${today.toFixed(2)} (vs $${spendMedian.toFixed(2)} 13-day median, -${Math.round((drop / spendMedian) * 100)}%).`,
          payload: {
            today,
            median: Math.round(spendMedian * 100) / 100,
            dropPct: Math.round((drop / spendMedian) * 100),
            dropAbs: Math.round(drop * 100) / 100,
          },
        });
      }
    }

    if (clickMedian >= THRESHOLDS.clickDropAbsoluteFloor) {
      const today = Number(candidate.clicks || 0);
      const drop = clickMedian - today;
      if (today < clickMedian * THRESHOLDS.dropPctOfMedian && drop >= THRESHOLDS.clickDropAbsoluteFloor) {
        alerts.push({
          alert_kind: 'CLICK_DROP',
          severity: drop >= clickMedian * 0.8 ? 'critical' : 'warning',
          signature: shortHash(`click-drop:${drop >= clickMedian * 0.8 ? 'critical' : 'warning'}`),
          message: `VLA clicks dropped to ${today} (vs ${Math.round(clickMedian)} 13-day median, -${Math.round((drop / clickMedian) * 100)}%).`,
          payload: {
            today,
            median: Math.round(clickMedian * 10) / 10,
            dropPct: Math.round((drop / clickMedian) * 100),
            dropAbs: Math.round(drop * 10) / 10,
          },
        });
      }
    }
  }

  return alerts;
}

function bucketBy(arr, keyFn) {
  const out = {};
  for (const item of arr) {
    const k = keyFn(item) || '';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

module.exports = {
  detectAlerts,
  median,
  shortHash,
  THRESHOLDS,
};
