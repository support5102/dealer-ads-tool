/**
 * Tier 3 Middleware Tests — validates requireAuth and errorHandler behavior.
 *
 * Tests: src/middleware/auth.js, src/middleware/error-handler.js
 * Uses supertest to send HTTP requests through the full Express middleware chain.
 */

const express = require('express');
const supertest = require('supertest');
const expressSession = require('express-session');
const { errorHandler } = require('../../src/middleware/error-handler');
const { createTestApp, authenticatedAgent, TEST_CONFIG } = require('./test-helpers');
const { createApp } = require('../../src/server');

/**
 * Creates a minimal Express app with error-throwing routes and the errorHandler.
 * Routes must be registered BEFORE the error handler for Express to route errors correctly.
 */
function createErrorTestApp() {
  const app = express();
  app.use(express.json());
  app.use(expressSession({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false,
  }));

  // Test routes that trigger errors
  app.get('/__test__/throw', (req, res, next) => {
    next(new Error('Database connection lost'));
  });

  app.get('/__test__/custom-error', (req, res, next) => {
    const err = new Error('Resource not found');
    err.statusCode = 404;
    next(err);
  });

  app.get('/__test__/bad-request', (req, res, next) => {
    const err = new Error('Invalid customer ID format');
    err.statusCode = 400;
    next(err);
  });

  // Error handler — must be last
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// requireAuth middleware
// ---------------------------------------------------------------------------
describe('requireAuth middleware', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
  });

  test('returns 401 for unauthenticated request to protected route', async () => {
    const res = await supertest(app)
      .get('/api/accounts')
      .expect(401);

    expect(res.body.error).toMatch(/not authenticated/i);
  });

  test('401 response includes helpful message about connecting Google Ads', async () => {
    const res = await supertest(app)
      .get('/api/accounts')
      .expect(401);

    expect(res.body.error).toMatch(/connect.*google ads/i);
  });

  test('allows authenticated request through to route handler', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/auth/status');

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
  });

  test('returns 401 when session exists but has no refresh_token', async () => {
    app.get('/__test__/partial-session', (req, res) => {
      req.session.tokens = { access_token: 'fake-access' };
      res.json({ ok: true });
    });

    const agent = supertest.agent(app);
    await agent.get('/__test__/partial-session').expect(200);

    const res = await agent.get('/api/accounts');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// errorHandler middleware
// ---------------------------------------------------------------------------
describe('errorHandler middleware', () => {
  let app;

  beforeEach(() => {
    app = createErrorTestApp();
  });

  test('returns 500 with safe message for unhandled errors', async () => {
    const res = await supertest(app)
      .get('/__test__/throw')
      .expect(500);

    expect(res.body.error).toMatch(/internal server error/i);
    // Should NOT expose the raw error message
    expect(res.body.error).not.toContain('Database connection lost');
  });

  test('returns custom status code when error has statusCode property', async () => {
    const res = await supertest(app)
      .get('/__test__/custom-error')
      .expect(404);

    expect(res.body.error).toBe('Resource not found');
  });

  test('exposes error message for non-500 status codes', async () => {
    const res = await supertest(app)
      .get('/__test__/bad-request')
      .expect(400);

    expect(res.body.error).toBe('Invalid customer ID format');
  });

  test('returns JSON content type', async () => {
    await supertest(app)
      .get('/__test__/throw')
      .expect('Content-Type', /json/)
      .expect(500);
  });
});

// ---------------------------------------------------------------------------
// Production hardening
// ---------------------------------------------------------------------------
describe('production hardening', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  test('CORS restricts origin to config.app.url', async () => {
    const app = createApp(TEST_CONFIG);
    const res = await supertest(app)
      .get('/health')
      .set('Origin', 'https://evil-site.com');

    // Should not include the evil origin in Access-Control-Allow-Origin
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil-site.com');
  });

  test('CORS allows requests from configured app URL', async () => {
    const app = createApp(TEST_CONFIG);
    const res = await supertest(app)
      .get('/health')
      .set('Origin', TEST_CONFIG.app.url);

    expect(res.headers['access-control-allow-origin']).toBe(TEST_CONFIG.app.url);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  test('CORS preflight rejects disallowed origin', async () => {
    const app = createApp(TEST_CONFIG);
    const res = await supertest(app)
      .options('/api/parse-task')
      .set('Origin', 'https://evil-site.com')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil-site.com');
  });

  test('session cookie is not secure in non-production', async () => {
    delete process.env.NODE_ENV;
    const app = createApp(TEST_CONFIG);
    const res = await supertest(app).get('/health');

    const cookie = res.headers['set-cookie'];
    // Cookie should not have Secure flag in test/dev
    if (cookie) {
      expect(cookie.join('')).not.toMatch(/Secure/i);
    }
  });

  test('trust proxy is not set in non-production', () => {
    delete process.env.NODE_ENV;
    const app = createApp(TEST_CONFIG);
    expect(app.get('trust proxy')).toBeFalsy();
  });

  test('trust proxy is set in production', () => {
    process.env.NODE_ENV = 'production';
    const app = createApp(TEST_CONFIG);
    expect(app.get('trust proxy')).toBe(1);
  });
});
