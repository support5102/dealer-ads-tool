/**
 * Database — PostgreSQL connection pool for persistent storage.
 *
 * Uses Neon serverless PostgreSQL. Falls back gracefully if DATABASE_URL
 * is not set (in-memory mode for local dev).
 *
 * Auto-creates tables on first connection.
 */

const { Pool } = require('pg');

let pool = null;
let initialized = false;

/**
 * Get or create the connection pool.
 * Returns null if DATABASE_URL is not configured.
 */
function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) return null;

  pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', (err) => {
    console.error('Database pool error:', err.message);
  });

  return pool;
}

/**
 * Initialize database tables if they don't exist.
 */
async function initialize() {
  if (initialized) return;
  const p = getPool();
  if (!p) return;

  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS change_history (
        id TEXT PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        user_email TEXT DEFAULT 'unknown',
        action TEXT NOT NULL,
        account_id TEXT,
        dealer_name TEXT,
        details JSONB DEFAULT '{}',
        source TEXT DEFAULT 'unknown',
        success BOOLEAN DEFAULT TRUE,
        error TEXT
      )
    `);

    await p.query(`
      CREATE INDEX IF NOT EXISTS idx_change_history_timestamp ON change_history (timestamp DESC)
    `);
    await p.query(`
      CREATE INDEX IF NOT EXISTS idx_change_history_account ON change_history (account_id)
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS dealer_groups (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        curve_id TEXT NOT NULL DEFAULT 'linear',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS dealer_group_members (
        group_id INT REFERENCES dealer_groups(id) ON DELETE CASCADE,
        dealer_name TEXT NOT NULL,
        PRIMARY KEY (group_id, dealer_name)
      )
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS dealer_site_mappings (
        dealer_name TEXT PRIMARY KEY,
        site_id INTEGER NOT NULL,
        live_url TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS dealer_inventory_baseline (
        dealer_name TEXT PRIMARY KEY,
        rolling_90day_avg DECIMAL(10,2) NOT NULL,
        last_sample_count INTEGER,
        last_sample_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS dealer_inventory_samples (
        dealer_name TEXT NOT NULL,
        sampled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        new_vin_count INTEGER NOT NULL,
        PRIMARY KEY (dealer_name, sampled_at)
      )
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS change_alert_dedup (
        change_resource_name TEXT NOT NULL,
        change_date_time TIMESTAMPTZ NOT NULL,
        freshdesk_ticket_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (change_resource_name, change_date_time)
      )
    `);

    try {
      await p.query(`
        CREATE TABLE IF NOT EXISTS dealer_goals (
          dealer_name TEXT PRIMARY KEY,
          monthly_budget NUMERIC(10,2) NOT NULL,
          new_budget NUMERIC(10,2),
          used_budget NUMERIC(10,2),
          misc_notes TEXT,
          pacing_mode TEXT DEFAULT 'one_click',
          pacing_curve_id TEXT,
          vla_budget NUMERIC(10,2),
          keyword_budget NUMERIC(10,2),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          updated_by TEXT
        )
      `);
    } catch (err) {
      console.error('Database initialization error (dealer_goals):', err.message);
    }

    try {
      await p.query(`
        CREATE TABLE IF NOT EXISTS dealer_budget_changes (
          id SERIAL PRIMARY KEY,
          dealer_name TEXT NOT NULL,
          old_monthly_budget NUMERIC(10,2),
          new_monthly_budget NUMERIC(10,2) NOT NULL,
          note TEXT NOT NULL CHECK (char_length(note) >= 5),
          changed_at TIMESTAMPTZ DEFAULT NOW(),
          changed_by TEXT
        )
      `);
    } catch (err) {
      console.error('Database initialization error (dealer_budget_changes):', err.message);
    }

    try {
      await p.query(`
        CREATE INDEX IF NOT EXISTS idx_dealer_budget_changes_dealer
          ON dealer_budget_changes(dealer_name, changed_at DESC)
      `);
    } catch (err) {
      console.error('Database initialization error (idx_dealer_budget_changes_dealer):', err.message);
    }

    initialized = true;
    console.log('Database initialized: change_history, dealer_groups, dealer_group_members, dealer_site_mappings, dealer_inventory_baseline, dealer_inventory_samples, change_alert_dedup, dealer_goals, dealer_budget_changes tables ready');
  } catch (err) {
    console.error('Database initialization failed:', err.message);
  }
}

/**
 * Check if database is available.
 */
function isAvailable() {
  return !!process.env.DATABASE_URL;
}

module.exports = { getPool, initialize, isAvailable };
