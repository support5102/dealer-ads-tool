/**
 * Inventory Baseline Store — rolling 90-day average new-VIN count per dealer.
 *
 * Storage: PostgreSQL (dealer_inventory_samples + dealer_inventory_baseline tables)
 * when DATABASE_URL is set, in-memory fallback otherwise.
 *
 * The baseline is a rolling 90-day average of recorded new-VIN samples for a
 * given dealer. Samples are recorded by the daily baseline runner and stored
 * individually so the rolling window can be recomputed at any time.
 *
 * Called by: pacing-fetcher.js (inventory enrichment),
 *            inventory-baseline-runner.js (daily job),
 *            recommender-v2.js (Phase 3)
 */

const db = require('./database');

// ── In-memory fallback state ─────────────────────────────────────────────────
// Map<dealerName, [{ sampledAt: Date, count: number }]>
const memSamples = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ROLLING_WINDOW_DAYS = 90;

/**
 * Filters a sample list to only those within the last 90 days.
 *
 * @param {Array<{ sampledAt: Date, count: number }>} samples
 * @returns {Array<{ sampledAt: Date, count: number }>}
 */
function filterToWindow(samples) {
  const cutoff = new Date(Date.now() - ROLLING_WINDOW_DAYS * MS_PER_DAY);
  return samples.filter(s => s.sampledAt >= cutoff);
}

/**
 * Computes the average of an array of numbers. Returns 0 for empty arrays.
 *
 * @param {number[]} values
 * @returns {number}
 */
function avg(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Records a new VIN-count sample for a dealer and recomputes the 90-day
 * rolling baseline (UPSERTs dealer_inventory_baseline).
 *
 * In DB mode: INSERTs into dealer_inventory_samples, then SELECTs the 90-day
 * AVG and UPSERTs dealer_inventory_baseline.
 *
 * In in-memory mode: appends to in-memory list, computes avg on-the-fly.
 *
 * @param {string} dealerName
 * @param {number} newVinCount
 * @returns {Promise<void>}
 */
async function recordSample(dealerName, newVinCount) {
  const pool = db.getPool();

  if (pool) {
    try {
      // Insert the new sample
      await pool.query(
        `INSERT INTO dealer_inventory_samples (dealer_name, sampled_at, new_vin_count)
         VALUES ($1, NOW(), $2)
         ON CONFLICT (dealer_name, sampled_at) DO UPDATE SET new_vin_count = EXCLUDED.new_vin_count`,
        [dealerName, newVinCount]
      );

      // Recompute 90-day rolling average
      const avgRes = await pool.query(
        `SELECT AVG(new_vin_count) AS rolling_avg,
                MAX(new_vin_count) FILTER (WHERE sampled_at = (
                  SELECT MAX(sampled_at) FROM dealer_inventory_samples WHERE dealer_name = $1
                )) AS last_count,
                MAX(sampled_at) AS last_at
         FROM dealer_inventory_samples
         WHERE dealer_name = $1
           AND sampled_at >= NOW() - INTERVAL '90 days'`,
        [dealerName]
      );

      const row = avgRes.rows[0];
      const rollingAvg = parseFloat(row.rolling_avg) || 0;
      const lastCount = row.last_count != null ? parseInt(row.last_count, 10) : newVinCount;
      const lastAt = row.last_at || new Date();

      // UPSERT the baseline summary
      await pool.query(
        `INSERT INTO dealer_inventory_baseline
           (dealer_name, rolling_90day_avg, last_sample_count, last_sample_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (dealer_name) DO UPDATE
           SET rolling_90day_avg = EXCLUDED.rolling_90day_avg,
               last_sample_count = EXCLUDED.last_sample_count,
               last_sample_at    = EXCLUDED.last_sample_at,
               updated_at        = NOW()`,
        [dealerName, rollingAvg, lastCount, lastAt]
      );

      return;
    } catch (err) {
      console.error('[inventory-baseline-store] recordSample DB error:', err.message);
      throw err;
    }
  }

  // ── In-memory fallback ──
  if (!memSamples.has(dealerName)) {
    memSamples.set(dealerName, []);
  }
  memSamples.get(dealerName).push({ sampledAt: new Date(), count: newVinCount });
}

/**
 * Returns the baseline object for a dealer, or null if no samples exist.
 *
 * @param {string} dealerName
 * @returns {Promise<{ rolling90DayAvg: number, lastSampleCount: number|null, lastSampleAt: Date|null } | null>}
 */
async function getBaseline(dealerName) {
  const pool = db.getPool();

  if (pool) {
    try {
      const res = await pool.query(
        `SELECT rolling_90day_avg, last_sample_count, last_sample_at
         FROM dealer_inventory_baseline
         WHERE dealer_name = $1`,
        [dealerName]
      );
      if (res.rows.length === 0) return null;
      const row = res.rows[0];
      return {
        rolling90DayAvg: parseFloat(row.rolling_90day_avg),
        lastSampleCount: row.last_sample_count != null ? parseInt(row.last_sample_count, 10) : null,
        lastSampleAt: row.last_sample_at ? new Date(row.last_sample_at) : null,
      };
    } catch (err) {
      console.error('[inventory-baseline-store] getBaseline DB error:', err.message);
      throw err;
    }
  }

  // ── In-memory fallback ──
  const samples = memSamples.get(dealerName);
  if (!samples || samples.length === 0) return null;

  const windowSamples = filterToWindow(samples);
  if (windowSamples.length === 0) return null;

  const rollingAvg = avg(windowSamples.map(s => s.count));
  const lastSample = samples[samples.length - 1];

  return {
    rolling90DayAvg: rollingAvg,
    lastSampleCount: lastSample.count,
    lastSampleAt: lastSample.sampledAt,
  };
}

/**
 * Returns a Map of all known dealers and their baseline data.
 *
 * @returns {Promise<Map<string, { rolling90DayAvg: number, lastSampleCount: number|null, lastSampleAt: Date|null }>>}
 */
async function getAllBaselines() {
  const pool = db.getPool();

  if (pool) {
    try {
      const res = await pool.query(
        `SELECT dealer_name, rolling_90day_avg, last_sample_count, last_sample_at
         FROM dealer_inventory_baseline
         ORDER BY dealer_name`
      );
      const map = new Map();
      for (const row of res.rows) {
        map.set(row.dealer_name, {
          rolling90DayAvg: parseFloat(row.rolling_90day_avg),
          lastSampleCount: row.last_sample_count != null ? parseInt(row.last_sample_count, 10) : null,
          lastSampleAt: row.last_sample_at ? new Date(row.last_sample_at) : null,
        });
      }
      return map;
    } catch (err) {
      console.error('[inventory-baseline-store] getAllBaselines DB error:', err.message);
      throw err;
    }
  }

  // ── In-memory fallback ──
  const result = new Map();
  for (const [dealerName, samples] of memSamples) {
    if (samples.length === 0) continue;
    const windowSamples = filterToWindow(samples);
    if (windowSamples.length === 0) continue;
    const rollingAvg = avg(windowSamples.map(s => s.count));
    const lastSample = samples[samples.length - 1];
    result.set(dealerName, {
      rolling90DayAvg: rollingAvg,
      lastSampleCount: lastSample.count,
      lastSampleAt: lastSample.sampledAt,
    });
  }
  return result;
}

/**
 * Classifies inventory level into a tier based on current count vs baseline.
 *
 * Tiers (spec Section 2 R2):
 *  healthy  — >= 80% of baseline OR >= 15 absolute
 *  low      — 60–80% of baseline OR 8–14 absolute
 *  very_low — 20–60% of baseline OR 3–7 absolute
 *  critical — < 20% of baseline OR < 3 absolute
 *
 * Rules:
 * - When baseline is null or rolling90DayAvg === 0, classify by absolute count only.
 * - When BOTH percentage AND absolute produce a tier, pick the WORSE (more conservative) tier.
 *
 * Tier severity order (worst → best): critical > very_low > low > healthy
 *
 * @param {{ newVinCount: number, baseline: { rolling90DayAvg: number }|null }} params
 * @returns {'healthy'|'low'|'very_low'|'critical'}
 */
function classifyTier({ newVinCount, baseline }) {
  const count = newVinCount || 0;

  // ── Severity index: higher = worse ──
  const SEVERITY = { healthy: 0, low: 1, very_low: 2, critical: 3 };
  const TIERS = ['healthy', 'low', 'very_low', 'critical'];

  /**
   * Classify by absolute count alone.
   * @returns {'healthy'|'low'|'very_low'|'critical'}
   */
  function absoluteTier() {
    if (count >= 15) return 'healthy';
    if (count >= 8)  return 'low';
    if (count >= 3)  return 'very_low';
    return 'critical';
  }

  const baselineAvg = baseline ? baseline.rolling90DayAvg : 0;

  // No useful baseline — classify by absolute count only
  if (!baseline || baselineAvg === 0) {
    return absoluteTier();
  }

  /**
   * Classify by percentage of baseline.
   * @returns {'healthy'|'low'|'very_low'|'critical'}
   */
  function percentageTier() {
    const pct = (count / baselineAvg) * 100;
    if (pct >= 80) return 'healthy';
    if (pct >= 60) return 'low';
    if (pct >= 20) return 'very_low';
    return 'critical';
  }

  // Both signals present — pick the more conservative (worse) tier
  const absTier = absoluteTier();
  const pctTier = percentageTier();

  if (SEVERITY[absTier] >= SEVERITY[pctTier]) {
    return absTier;
  }
  return pctTier;
}

/**
 * Resets in-memory state. Used by tests only.
 */
function _resetForTesting() {
  memSamples.clear();
}

module.exports = {
  recordSample,
  getBaseline,
  getAllBaselines,
  classifyTier,
  _resetForTesting,
};
