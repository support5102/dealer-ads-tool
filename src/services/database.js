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

    // VLA Monitor — one row per (dealer, alert_kind) tracking the lifecycle of a
    // continuous condition (not a discrete event). `signature` is a stable hash
    // of the underlying state (e.g. the set of disapproved product IDs); when it
    // changes the ticket gets a re-notify in the body, not a new ticket.
    // `cleared_days` counts consecutive days the condition has NOT been detected;
    // at 2 the alert auto-resolves and the ticket is closed.
    await p.query(`
      CREATE TABLE IF NOT EXISTS vla_alert_state (
        dealer_name TEXT NOT NULL,
        alert_kind TEXT NOT NULL,
        signature TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'warning',
        status TEXT NOT NULL DEFAULT 'open',
        consecutive_days INTEGER NOT NULL DEFAULT 1,
        cleared_days INTEGER NOT NULL DEFAULT 0,
        freshdesk_ticket_id TEXT,
        payload JSONB,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at   TIMESTAMPTZ,
        PRIMARY KEY (dealer_name, alert_kind)
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

    // Step 2: Add new columns to dealer_budget_changes
    try {
      await p.query(`
        ALTER TABLE dealer_budget_changes
          ADD COLUMN IF NOT EXISTS change_scope TEXT,
          ADD COLUMN IF NOT EXISTS change_amount NUMERIC(10,2),
          ADD COLUMN IF NOT EXISTS linked_revert_id INTEGER
      `);
    } catch (err) {
      console.error('Database initialization error (dealer_budget_changes columns):', err.message);
    }

    // Step 3: Add pending_budget_reverts table
    try {
      await p.query(`
        CREATE TABLE IF NOT EXISTS pending_budget_reverts (
          id SERIAL PRIMARY KEY,
          dealer_name TEXT NOT NULL,
          bump_amount NUMERIC(10,2) NOT NULL,
          baseline_monthly_budget NUMERIC(10,2) NOT NULL,
          bumped_monthly_budget NUMERIC(10,2) NOT NULL,
          applied_change_id INTEGER REFERENCES dealer_budget_changes(id),
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          applied_by TEXT,
          revert_due_date DATE NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          ticket_id TEXT,
          ticket_filed_at TIMESTAMPTZ
        )
      `);
    } catch (err) {
      console.error('Database initialization error (pending_budget_reverts):', err.message);
    }

    try {
      await p.query(`
        CREATE INDEX IF NOT EXISTS idx_pending_reverts_due
          ON pending_budget_reverts (status, revert_due_date)
      `);
      await p.query(`
        CREATE INDEX IF NOT EXISTS idx_pending_reverts_dealer
          ON pending_budget_reverts (dealer_name, status)
      `);
    } catch (err) {
      console.error('Database initialization error (pending_budget_reverts indexes):', err.message);
    }

    // Step 4: Add deferred FK on dealer_budget_changes.linked_revert_id
    try {
      await p.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conname = 'dealer_budget_changes_linked_revert_id_fkey'
          ) THEN
            ALTER TABLE dealer_budget_changes
              ADD CONSTRAINT dealer_budget_changes_linked_revert_id_fkey
              FOREIGN KEY (linked_revert_id) REFERENCES pending_budget_reverts(id);
          END IF;
        END $$;
      `);
    } catch (err) {
      console.error('Database initialization error (dealer_budget_changes FK):', err.message);
    }

    // Step 5: Add daily_budget column to dealer_goals
    try {
      await p.query(`
        ALTER TABLE dealer_goals
          ADD COLUMN IF NOT EXISTS daily_budget NUMERIC(10,2)
      `);
      await p.query(`
        UPDATE dealer_goals
           SET daily_budget = ROUND(
                 monthly_budget::numeric
                 / EXTRACT(DAY FROM (DATE_TRUNC('month', NOW()) + INTERVAL '1 month - 1 day'))::numeric,
                 2
               )
         WHERE monthly_budget IS NOT NULL AND daily_budget IS NULL
      `);
    } catch (err) {
      console.error('Database initialization error (dealer_goals.daily_budget):', err.message);
    }

    try {
      await p.query(`
        CREATE TABLE IF NOT EXISTS dealer_monthly_spend (
          dealer_name    TEXT NOT NULL,
          period         DATE NOT NULL,
          total_spend    NUMERIC(12,2) NOT NULL,
          monthly_budget NUMERIC(10,2),
          source         TEXT,
          updated_at     TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (dealer_name, period)
        )
      `);
      await p.query(`
        CREATE INDEX IF NOT EXISTS idx_dealer_monthly_spend_dealer
          ON dealer_monthly_spend (dealer_name, period DESC)
      `);
    } catch (err) {
      console.error('Database initialization error (dealer_monthly_spend):', err.message);
    }

    initialized = true;
    console.log('Database initialized: change_history, dealer_groups, dealer_group_members, dealer_site_mappings, dealer_inventory_baseline, dealer_inventory_samples, change_alert_dedup, dealer_goals, dealer_budget_changes, pending_budget_reverts, dealer_monthly_spend tables ready');
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
