/**
 * Server — Express app setup, middleware, and route mounting.
 *
 * This is the entry point. It wires together:
 * - Config validation (fails fast on missing env vars)
 * - Session management (OAuth tokens)
 * - Static file serving (public/)
 * - Route modules (auth, accounts, changes)
 * - Error handling middleware
 *
 * Exports createApp(config) for testing — allows injecting fake config.
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const cors    = require('cors');
const path    = require('path');

const { createAuthRouter }     = require('./routes/auth');
const { createAccountsRouter } = require('./routes/accounts');
const { createChangesRouter }  = require('./routes/changes');
const { createPacingRouter }   = require('./routes/pacing');
const { createBuilderRouter }    = require('./routes/builder');
const { createSchedulerRouter } = require('./routes/scheduler');
const { createAuditRouter }           = require('./routes/audit');
const { createOptimizationRouter }    = require('./routes/optimization');
const { createFreshdeskRouter }       = require('./routes/freshdesk');
const { createBudgetAdjustmentsRouter } = require('./routes/budget-adjustments');
const { createCommandCenterRouter }    = require('./routes/command-center');
const { createGroupsRouter }           = require('./routes/groups');
const { createDealersRouter }          = require('./routes/dealers');
const { errorHandler }                = require('./middleware/error-handler');
const spendSync                       = require('./services/spend-sync');
const database                        = require('./services/database');
const dealerGroupsStore               = require('./services/dealer-groups-store');

/**
 * Creates a configured Express app.
 *
 * @param {Object} config - App configuration (from validateEnv() or test fixture)
 * @returns {express.Application} Configured Express app (not yet listening)
 */
function createApp(config) {
  const app = express();
  const isProduction = process.env.NODE_ENV === 'production';

  // ── Database initialization (non-blocking) ──
  database.initialize()
    .then(() => dealerGroupsStore.seedDefaults())
    .catch(err => {
      console.warn('Database initialization skipped:', err.message);
    });

  // ── Production proxy trust (Railway terminates TLS at its reverse proxy) ──
  if (isProduction) {
    app.set('trust proxy', 1);
  }

  // ── Middleware ──
  app.use(express.json({ limit: '2mb' }));
  app.use(cors({
    origin:      config.app.url,
    credentials: true,
  }));
  // Session store: Postgres-backed when DATABASE_URL is set (persistent across
  // Cloud Run scale-to-zero); in-memory fallback for local dev without DB.
  const sessionPool = database.getPool();
  const sessionStore = sessionPool
    ? new pgSession({
        pool: sessionPool,
        tableName: 'user_sessions',
        createTableIfMissing: true,
        pruneSessionInterval: 60 * 60, // prune expired rows hourly
      })
    : undefined;
  app.use(session({
    store:             sessionStore,
    secret:            config.session.secret,
    resave:            false,
    saveUninitialized: false,
    cookie: {
      secure:   isProduction,
      httpOnly: true,
      sameSite: 'lax',
      maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days
    },
  }));

  // ── Default route → Command Center (before static, so index.html doesn't take over) ──
  app.get('/', (req, res) => {
    res.redirect('/command-center.html');
  });

  // ── Static files ──
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ── Routes ──
  app.use(createAuthRouter(config));
  app.use(createAccountsRouter(config));
  app.use(createChangesRouter(config));
  app.use(createPacingRouter(config));
  app.use(createBuilderRouter(config));
  app.use(createSchedulerRouter());
  app.use(createAuditRouter(config));
  app.use(createOptimizationRouter(config));
  app.use(createFreshdeskRouter(config));
  app.use(createBudgetAdjustmentsRouter(config));
  app.use('/api/cc', createCommandCenterRouter(config));
  app.use(createGroupsRouter());
  app.use(createDealersRouter());

  // ── Spend Sync — daily 8 AM EST spend pull from Google Ads → Sheets ──
  const { requireAuth } = require('./middleware/auth');

  app.get('/api/spend-sync/status', requireAuth, (req, res) => {
    res.json(spendSync.getSpendSyncStatus());
  });

  app.post('/api/spend-sync/enable', requireAuth, (req, res) => {
    const refreshToken = req.session.tokens.refresh_token;
    const mccId = req.session.mccId || config.googleAds.mccId;
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!spreadsheetId) {
      return res.status(400).json({ error: 'GOOGLE_SHEETS_SPREADSHEET_ID not configured.' });
    }
    spendSync.enableSpendSync({
      config: config.googleAds,
      refreshToken,
      mccId,
      spreadsheetId,
      runNow: req.body.runNow === true,
    });
    res.json({ enabled: true, ...spendSync.getSpendSyncStatus() });
  });

  app.post('/api/spend-sync/disable', requireAuth, (req, res) => {
    spendSync.disableSpendSync();
    res.json({ enabled: false });
  });

  app.post('/api/spend-sync/run-now', requireAuth, async (req, res) => {
    const refreshToken = req.session.tokens.refresh_token;
    const mccId = req.session.mccId || config.googleAds.mccId;
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!spreadsheetId) {
      return res.status(400).json({ error: 'GOOGLE_SHEETS_SPREADSHEET_ID not configured.' });
    }
    spendSync.enableSpendSync({
      config: config.googleAds,
      refreshToken,
      mccId,
      spreadsheetId,
    });
    spendSync.runSpendSync();
    res.json({ message: 'Spend sync started.', ...spendSync.getSpendSyncStatus() });
  });

  // ── Health check ──
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── Error handler (must be last) ──
  app.use(errorHandler);

  return app;
}

// ── Start server (only when run directly, not when imported by tests) ──
if (require.main === module) {
  // Load .env before config validation — only the entry point should do this
  require('dotenv').config({ override: true });
  const { validateEnv } = require('./utils/config');
  const config = validateEnv();
  const PORT = config.app.port;

  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && (!config.app.url || config.app.url.includes('localhost'))) {
    console.warn('⚠️  WARNING: APP_URL is not set or contains localhost. OAuth will fail in production.');
  }

  // Pacing Engine v2 — daily scheduler (feature-flagged, stub runner until Task 8.2)
  if (config.pacingEngineV2Enabled) {
    const scheduler = require('./services/scheduler');
    const runner = require('./services/pacing-engine-runner');

    // Stub runner: empty listAccounts + throwing applyBudgetChange. Real wiring
    // lands in Task 8.2 (listAccounts via MCC + applyBudgetChange via Google Ads REST).
    scheduler.registerJob(
      'pacing-engine-daily',
      async () => runner.run({
        listAccounts: async () => [],
        applyBudgetChange: async () => { throw new Error('apply not wired — Task 8.2'); },
      }),
      24 * 60 * 60 * 1000,
      { runImmediately: false }
    );
    console.log('[pacing-engine-v2] scheduler registered (stub runner)');

    // Inventory baseline — daily sampling for recommender-v2 (feature-flagged)
    const inventoryBaselineRunner = require('./services/inventory-baseline-runner');
    scheduler.registerJob(
      'inventory-baseline-daily',
      async () => inventoryBaselineRunner.run(),
      24 * 60 * 60 * 1000,
      { runImmediately: false }
    );
    console.log('[inventory-baseline] scheduler registered');
  }

  // Change alerts — daily (feature-flagged independently of pacing v2)
  if (config.changeAlertsEnabled) {
    const scheduler = require('./services/scheduler');
    const changeAlertsRunner = require('./services/change-alerts-runner');
    scheduler.registerJob(
      'change-alerts-daily',
      async () => changeAlertsRunner.run({
        // Stub deps until the service-account auth flow exists
        listAccounts: async () => [],
        getRestCtxForAccount: async () => { throw new Error('getRestCtxForAccount not wired — service-account auth needed'); },
      }),
      24 * 60 * 60 * 1000,
      { runImmediately: false }
    );
    console.log('[change-alerts] scheduler registered (stub runner)');
  }

  createApp(config).listen(PORT, () => {
    console.log(`\n⚡ Dealer Ads Tool running on port ${PORT}`);
    console.log(`   URL: ${config.app.url}\n`);
  });
}

module.exports = { createApp };
