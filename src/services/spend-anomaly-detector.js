/**
 * Spend Anomaly Detector — flags a day whose ad spend spikes far above the
 * account's recent normal range.
 *
 * Called by: a scheduled scan / route (scanAccountForSpendSpike), or directly
 *            with a daily-spend series (detectSpendSpike).
 * Calls: services/google-ads.js (getDailySpendLast14Days) — only in the scan wrapper.
 *
 * Why this exists: month-end pacing catches slow drift, but a runaway budget,
 * a bid-strategy change, or a billing problem can burn a day's budget in hours.
 * This compares the most recent day against the mean + standard deviation of the
 * preceding days so a sudden jump is caught the next morning instead of weeks later.
 *
 * Pure logic (detectSpendSpike) has no I/O and is fully unit-tested.
 */

/** Rounds to 2 decimals (dollars/cents). */
function round2(x) {
  return Math.round(x * 100) / 100;
}

/** Arithmetic mean of an array of numbers. */
function mean(xs) {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n-1). Returns 0 for fewer than 2 points. */
function sampleStddev(xs, m) {
  if (xs.length < 2) return 0;
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/**
 * Detects whether the most recent day in a daily-spend series is an anomalous spike.
 *
 * The LAST element of `dailySpend` is treated as the candidate day; every earlier
 * element forms the baseline. A spike requires all of:
 *   - enough baseline days (minBaselineDays),
 *   - the candidate spend is at least `absoluteFloor` dollars (ignore trivial amounts),
 *   - the candidate is more than `z` standard deviations above the baseline mean.
 * If the baseline is perfectly flat (stddev 0), a large percentage jump
 * (`pctFallback`) over the mean is used instead, and any real spend over a
 * zero-spend baseline is flagged.
 *
 * @param {{date: string, spend: number}[]} dailySpend - Daily spend, ascending by date
 * @param {Object} [opts]
 * @param {number} [opts.z=2.5] - Standard-deviations threshold
 * @param {number} [opts.minBaselineDays=5] - Minimum baseline days required to judge
 * @param {number} [opts.absoluteFloor=20] - Ignore candidate days below this many dollars
 * @param {number} [opts.pctFallback=0.5] - Flat-baseline: flag if candidate is >= this fraction above mean (0.5 = +50%)
 * @returns {Object} Result with isSpike + supporting numbers (see fields below)
 */
function detectSpendSpike(dailySpend, opts = {}) {
  const {
    z = 2.5,
    minBaselineDays = 5,
    absoluteFloor = 20,
    pctFallback = 0.5,
  } = opts;

  const series = (dailySpend || []).filter(
    d => d && typeof d.spend === 'number' && isFinite(d.spend)
  );

  if (series.length < minBaselineDays + 1) {
    return {
      isSpike: false,
      reason: 'insufficient_data',
      date: series.length ? series[series.length - 1].date : null,
      spend: series.length ? round2(series[series.length - 1].spend) : null,
      baselineMean: null,
      baselineStddev: null,
      zScore: null,
      threshold: null,
      pctAboveMean: null,
      baselineDays: Math.max(series.length - 1, 0),
    };
  }

  const candidate = series[series.length - 1];
  const baseline = series.slice(0, -1).map(d => d.spend);
  const m = mean(baseline);
  const sd = sampleStddev(baseline, m);
  const pctAboveMean = m > 0 ? (candidate.spend - m) / m : null;
  const zScore = sd > 0 ? (candidate.spend - m) / sd : null;
  const threshold = sd > 0 ? m + z * sd : null;

  let isSpike = false;
  let reason = 'normal';

  if (candidate.spend < absoluteFloor) {
    reason = 'below_floor';
  } else if (sd > 0) {
    if (zScore > z) {
      isSpike = true;
      reason = 'zscore_exceeded';
    }
  } else if (m > 0) {
    // Flat baseline: judge by percentage jump instead of z-score.
    if (pctAboveMean != null && pctAboveMean >= pctFallback) {
      isSpike = true;
      reason = 'flat_baseline_jump';
    }
  } else {
    // Baseline mean is 0 (no prior spend) but real spend appeared today.
    isSpike = true;
    reason = 'spend_from_zero_baseline';
  }

  return {
    isSpike,
    reason,
    date: candidate.date,
    spend: round2(candidate.spend),
    baselineMean: round2(m),
    baselineStddev: round2(sd),
    zScore: zScore != null ? Math.round(zScore * 100) / 100 : null,
    threshold: threshold != null ? round2(threshold) : null,
    pctAboveMean: pctAboveMean != null ? Math.round(pctAboveMean * 100) : null,
    baselineDays: baseline.length,
  };
}

/**
 * Builds a short, human-readable alert line for a detected spike.
 *
 * @param {Object} result - Output of detectSpendSpike (should have isSpike true)
 * @param {string} [accountName] - Dealer/account name for context
 * @returns {string} One-line alert message
 */
function formatSpikeAlert(result, accountName = 'Account') {
  const pct = result.pctAboveMean != null ? ` (+${result.pctAboveMean}% vs. ${result.baselineDays}-day avg $${result.baselineMean})` : '';
  return `${accountName}: spend spike on ${result.date} — $${result.spend}${pct}. Check for a budget change, bid-strategy change, or billing issue.`;
}

/**
 * Fetches an account's last-14-days daily spend and runs spike detection.
 *
 * @param {Object} restCtx - REST context for google-ads queries (accepts _queryFn for tests)
 * @param {Object} [opts] - Passed through to detectSpendSpike
 * @returns {Promise<Object>} detectSpendSpike result + { accountId }
 */
async function scanAccountForSpendSpike(restCtx, opts = {}) {
  const googleAds = require('./google-ads');
  const daily = await googleAds.getDailySpendLast14Days(restCtx);
  const result = detectSpendSpike(daily, opts);
  return { ...result, accountId: restCtx.customerId };
}

module.exports = {
  detectSpendSpike,
  scanAccountForSpendSpike,
  formatSpikeAlert,
};
