/**
 * Integration Test Helpers — shared setup for Tier 3 route tests.
 *
 * Provides:
 * - Fake config matching the shape of validateEnv() output
 * - createTestApp() to build an Express app with fake config + test session endpoint
 * - authenticatedAgent() to get a supertest agent with a session
 */

const { createApp } = require('../../src/server');
const supertest = require('supertest');

/**
 * Fake config object matching the shape returned by validateEnv().
 * Uses dummy values — no real credentials needed for integration tests.
 */
const TEST_CONFIG = {
  googleAds: {
    clientId:       'test-client-id',
    clientSecret:   'test-client-secret',
    developerToken: 'test-developer-token',
    mccId:          'test-mcc-id',
  },
  claude: {
    apiKey: 'test-anthropic-key',
    model:  'claude-sonnet-4-20250514',
  },
  session: {
    secret: 'test-session-secret',
  },
  app: {
    url:  'http://localhost:3000',
    port: 3000,
  },
  freshdesk: {
    apiKey: '',
    domain: 'test-domain',
  },
};

/**
 * Creates a test Express app with fake config.
 * Includes a test-only session injection endpoint.
 *
 * @returns {express.Application}
 */
function createTestApp() {
  const app = createApp(TEST_CONFIG);

  // Test-only endpoint to set session data (registered once per app instance).
  // Placed after createApp routes but before any test sends requests.
  app.get('/__test__/set-session', (req, res) => {
    // Session data is set via query params encoded as JSON
    const data = req.query.data ? JSON.parse(req.query.data) : {};
    req.session.tokens = data.tokens || {
      access_token:  'fake-access-token',
      refresh_token: 'fake-refresh-token',
    };
    if (data.mccId) {
      req.session.mccId = data.mccId;
    }
    if (data.accounts) {
      req.session.accounts = data.accounts;
    }
    res.json({ ok: true });
  });

  return app;
}

/**
 * Creates a supertest agent with an authenticated session.
 * Uses the test-only endpoint registered by createTestApp().
 *
 * @param {express.Application} app - The Express app (from createTestApp)
 * @param {Object} [sessionData] - Optional session overrides
 * @returns {Promise<supertest.SuperAgentTest>} Agent with cookies set
 */
async function authenticatedAgent(app, sessionData = {}) {
  const agent = supertest.agent(app);
  const data = encodeURIComponent(JSON.stringify(sessionData));
  await agent.get(`/__test__/set-session?data=${data}`).expect(200);
  return agent;
}

module.exports = { TEST_CONFIG, createTestApp, authenticatedAgent };
