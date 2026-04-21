/**
 * Config — validates required environment variables at startup.
 *
 * Called by: src/server.js (on import)
 * Calls: nothing (pure validation)
 *
 * Fails fast with a descriptive error if any required variable is missing.
 * Returns a frozen config object used by all other modules.
 */

/**
 * Recursively freezes an object and all nested objects.
 * @param {Object} obj - Object to deep freeze
 * @returns {Object} The same object, deeply frozen
 */
function deepFreeze(obj) {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

const REQUIRED_VARS = [
  'GOOGLE_ADS_DEVELOPER_TOKEN',
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'SESSION_SECRET',
  'ANTHROPIC_API_KEY',
];

/**
 * Validates that all required environment variables are present and non-empty.
 *
 * @param {Object} [env=process.env] - Environment object to validate
 * @returns {Object} Frozen config object with all validated values
 * @throws {Error} If any required variable is missing or empty
 */
function validateEnv(env = process.env) {
  const missing = REQUIRED_VARS.filter(key => !env[key] || env[key].trim() === '');

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
      'Check your .env file or deployment environment.'
    );
  }

  const config = {
    googleAds: {
      developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
      clientId:       env.GOOGLE_ADS_CLIENT_ID,
      clientSecret:   env.GOOGLE_ADS_CLIENT_SECRET,
      mccId:          env.GOOGLE_ADS_MCC_ID || '',
    },
    session: {
      secret: env.SESSION_SECRET,
    },
    app: {
      url:  env.APP_URL || 'http://localhost:3000',
      port: parseInt(env.PORT, 10) || 3000,
    },
    claude: {
      apiKey: env.ANTHROPIC_API_KEY,
      model:  env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
    },
    freshdesk: {
      apiKey: env.FRESHDESK_API_KEY || '',
      domain: env.FRESHDESK_DOMAIN || 'savvydealer',
    },
    // Pacing Engine v2 - controls whether the daily scheduler job runs and
    // whether /api/pacing/all returns v2 columns. false = v1 behavior unchanged.
    pacingEngineV2Enabled: env.PACING_ENGINE_V2_ENABLED === 'true',
    // Change Alerts (R8) - independent of PACING_ENGINE_V2_ENABLED.
    // When enabled, the daily change-alerts-runner scans Google Ads change_event
    // and creates Freshdesk tickets for budget/campaign/ad-group/location changes.
    changeAlertsEnabled: env.CHANGE_ALERTS_ENABLED === 'true',
    // DB Goals (Phase B) - when true, goal-reader reads from Postgres-backed
    // dealer-goals-store instead of Google Sheets. false = sheet-based path unchanged.
    useDbGoals: env.USE_DB_GOALS === 'true',
    // DEV_MODE=true blocks ALL mutations to external systems (Google Ads,
    // Freshdesk tickets). Set on the staging Cloud Run service so dev clicks
    // can't accidentally touch real dealer accounts or create real tickets.
    devMode: env.DEV_MODE === 'true',
  };

  return deepFreeze(config);
}

module.exports = { validateEnv, REQUIRED_VARS };
