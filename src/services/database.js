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

    initialized = true;
    console.log('Database initialized: change_history table ready');
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
