/**
 * Dealer Spend History Store — DB-backed record of each dealer's total monthly spend.
 *
 * One row per (dealer_name, period), where period is the first day of a calendar
 * month. Written by the capture hooks (routes/pacing.js overview, services/spend-sync.js)
 * via latest-wins upsert: the current month's row is overwritten with the running MTD
 * total on every capture, and settles at the final figure once the month rolls over.
 *
 * Storage: PostgreSQL when DATABASE_URL is set, in-memory Map fallback otherwise.
 *
 * Read by: routes/dealers.js (GET /api/dealers/:dealerName/spend-history)
 */

const db = require('./database');

// ── In-memory fallback: key `${dealerName}::${period}` → record ──
const inMemory = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Period helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * First day of the UTC month for a given date, as 'YYYY-MM-01'.
 * @param {Date} [date]
 * @returns {string}
 */
function monthPeriod(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/**
 * Normalizes a period input ('YYYY-MM', 'YYYY-MM-DD', or Date) to 'YYYY-MM-01'.
 * @param {string|Date} period
 * @returns {string}
 */
function normalizePeriod(period) {
  if (period instanceof Date) return monthPeriod(period);
  const s = String(period);
  const m = s.match(/^(\d{4})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-01`;
  return monthPeriod(new Date(s));
}

function rowToRecord(row) {
  return {
    dealerName:    row.dealer_name,
    period:        row.period, // already 'YYYY-MM-01' via TO_CHAR in query
    totalSpend:    row.total_spend    !== null ? Number(row.total_spend)    : null,
    monthlyBudget: row.monthly_budget !== null ? Number(row.monthly_budget) : null,
    source:        row.source ?? null,
    updatedAt:     row.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upsert a dealer's spend for one month. Latest write wins.
 *
 * @param {object} p
 * @param {string} p.dealerName        Required, original-case account name
 * @param {string|Date} p.period       Any month-ish value; normalized to YYYY-MM-01
 * @param {number} p.totalSpend        Required
 * @param {number} [p.monthlyBudget]
 * @param {string} [p.source]
 * @returns {Promise<void>}
 */
async function recordSpend({ dealerName, period, totalSpend, monthlyBudget = null, source = null }) {
  if (!dealerName) throw new Error('recordSpend: dealerName is required');
  const p = normalizePeriod(period);
  const spend = Number(totalSpend);
  const budget = monthlyBudget == null ? null : Number(monthlyBudget);

  const pool = db.getPool();
  if (pool) {
    await pool.query(`
      INSERT INTO dealer_monthly_spend (dealer_name, period, total_spend, monthly_budget, source, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (dealer_name, period) DO UPDATE SET
        total_spend    = EXCLUDED.total_spend,
        monthly_budget = COALESCE(EXCLUDED.monthly_budget, dealer_monthly_spend.monthly_budget),
        source         = EXCLUDED.source,
        updated_at     = NOW()
    `, [dealerName, p, spend, budget, source]);
    return;
  }

  // In-memory fallback
  const key = `${dealerName}::${p}`;
  const prev = inMemory.get(key);
  inMemory.set(key, {
    dealerName,
    period: p,
    totalSpend: spend,
    monthlyBudget: budget != null ? budget : (prev ? prev.monthlyBudget : null),
    source: source ?? null,
    updatedAt: new Date(),
  });
}

/**
 * Upsert many dealers' spend for the current month. Never throws — logs and
 * continues so one bad row can't abort the batch or the caller.
 *
 * @param {Array<{dealerName:string, totalSpend?:number, mtdSpend?:number, monthlyBudget?:number}>} rows
 * @param {string} source
 * @param {Date} [now]
 * @returns {Promise<void>}
 */
async function recordManyForCurrentMonth(rows, source, now = new Date()) {
  const period = monthPeriod(now);
  for (const r of rows || []) {
    try {
      const totalSpend = r.totalSpend != null ? r.totalSpend : r.mtdSpend;
      await recordSpend({
        dealerName: r.dealerName,
        period,
        totalSpend,
        monthlyBudget: r.monthlyBudget != null ? r.monthlyBudget : null,
        source,
      });
    } catch (err) {
      console.error('[dealer-spend-history-store] recordSpend failed for', r && r.dealerName, '-', err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All recorded months for a dealer, newest period first.
 * @param {string} dealerName
 * @returns {Promise<Array<object>>}
 */
async function getSpendHistory(dealerName) {
  const pool = db.getPool();
  if (pool) {
    const res = await pool.query(`
      SELECT dealer_name,
             TO_CHAR(period, 'YYYY-MM-01') AS period,
             total_spend, monthly_budget, source, updated_at
        FROM dealer_monthly_spend
       WHERE dealer_name = $1
       ORDER BY period DESC
    `, [dealerName]);
    return res.rows.map(rowToRecord);
  }

  // In-memory fallback — newest first
  return Array.from(inMemory.values())
    .filter(r => r.dealerName === dealerName)
    .sort((a, b) => b.period.localeCompare(a.period))
    .map(r => ({ ...r }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Testing
// ─────────────────────────────────────────────────────────────────────────────

function _resetForTesting() {
  inMemory.clear();
}

module.exports = {
  monthPeriod,
  recordSpend,
  recordManyForCurrentMonth,
  getSpendHistory,
  _resetForTesting,
};
