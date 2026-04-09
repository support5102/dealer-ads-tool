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
  };

  return deepFreeze(config);
}

module.exports = { validateEnv, REQUIRED_VARS };
