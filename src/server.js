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
const { errorHandler }                = require('./middleware/error-handler');

/**
 * Creates a configured Express app.
 *
 * @param {Object} config - App configuration (from validateEnv() or test fixture)
 * @returns {express.Application} Configured Express app (not yet listening)
 */
function createApp(config) {
  const app = express();
  const isProduction = process.env.NODE_ENV === 'production';

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
  app.use(session({
    secret:            config.session.secret,
    resave:            false,
    saveUninitialized: false,
    cookie: {
      secure:   isProduction,
      httpOnly: true,
      sameSite: 'lax',
      maxAge:   24 * 60 * 60 * 1000, // 24 hours
    },
  }));

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

  createApp(config).listen(PORT, () => {
    console.log(`\n⚡ Dealer Ads Tool running on port ${PORT}`);
    console.log(`   URL: ${config.app.url}\n`);
  });
}

module.exports = { createApp };
