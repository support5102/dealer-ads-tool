/**
 * Server — Express app setup, middleware, and route mounting.
 *
 * This is the entry point. It wires together:
 * - Config validation (fails fast on missing env vars)
 * - Session management (OAuth tokens)
 * - Static file serving (public/)
 * - Route modules (auth, accounts, changes)
 * - Error handling middleware
 */

const express = require('express');
const session = require('express-session');
const cors    = require('cors');
const path    = require('path');

const { validateEnv }          = require('./utils/config');
const { createAuthRouter }     = require('./routes/auth');
const { createAccountsRouter } = require('./routes/accounts');
const { createChangesRouter }  = require('./routes/changes');
const { errorHandler }         = require('./middleware/error-handler');

// Validate environment before doing anything else
const config = validateEnv();

const app = express();

// ── Middleware ──
app.use(express.json());
app.use(cors());
app.use(session({
  secret:            config.session.secret,
  resave:            false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }, // 24 hours
}));

// ── Static files ──
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Routes ──
app.use(createAuthRouter(config));
app.use(createAccountsRouter(config));
app.use(createChangesRouter(config));

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Error handler (must be last) ──
app.use(errorHandler);

// ── Start server ──
const PORT = config.app.port;
app.listen(PORT, () => {
  console.log(`\n⚡ Dealer Ads Tool running on port ${PORT}`);
  console.log(`   Open: http://localhost:${PORT}\n`);
});

module.exports = app;
