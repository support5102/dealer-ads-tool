/**
 * Tier 3 Auth Route Tests — validates OAuth flow, logout, and status check.
 *
 * Tests: src/routes/auth.js
 * Uses supertest to send HTTP requests through Express.
 * External OAuth calls are mocked via jest.mock on axios.
 */

const supertest = require('supertest');
const axios = require('axios');
const { createTestApp, authenticatedAgent, TEST_CONFIG } = require('./test-helpers');

jest.mock('axios');

// ---------------------------------------------------------------------------
// GET /auth/google — OAuth redirect
// ---------------------------------------------------------------------------
describe('GET /auth/google', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
  });

  test('redirects to Google OAuth consent screen', async () => {
    const res = await supertest(app)
      .get('/auth/google')
      .expect(302);

    expect(res.headers.location).toContain('accounts.google.com/o/oauth2');
  });

  test('includes client_id in redirect URL', async () => {
    const res = await supertest(app).get('/auth/google');

    expect(res.headers.location).toContain(`client_id=${TEST_CONFIG.googleAds.clientId}`);
  });

  test('includes correct redirect_uri in redirect URL', async () => {
    const res = await supertest(app).get('/auth/google');

    expect(res.headers.location).toContain(
      encodeURIComponent(`${TEST_CONFIG.app.url}/auth/callback`)
    );
  });

  test('requests offline access for refresh tokens', async () => {
    const res = await supertest(app).get('/auth/google');

    expect(res.headers.location).toContain('access_type=offline');
  });

  test('requests Google Ads and email scopes', async () => {
    const res = await supertest(app).get('/auth/google');

    expect(res.headers.location).toContain('adwords');
    expect(res.headers.location).toContain('userinfo.email');
  });
});

// ---------------------------------------------------------------------------
// GET /auth/callback — OAuth token exchange
// ---------------------------------------------------------------------------
describe('GET /auth/callback', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
  });

  test('exchanges code for tokens and redirects to home with connected=true', async () => {
    axios.post.mockResolvedValue({
      data: {
        access_token:  'new-access-token',
        refresh_token: 'new-refresh-token',
      },
    });
    axios.get.mockResolvedValue({ data: { email: 'user@dealer.com' } });

    const res = await supertest(app)
      .get('/auth/callback?code=test-auth-code')
      .expect(302);

    expect(res.headers.location).toBe('/?connected=true');
  });

  test('sends correct token exchange payload to Google', async () => {
    axios.post.mockResolvedValue({
      data: { access_token: 'at', refresh_token: 'rt' },
    });
    axios.get.mockResolvedValue({ data: { email: 'user@dealer.com' } });

    await supertest(app).get('/auth/callback?code=my-code');

    expect(axios.post).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({
        code: 'my-code',
        client_id: TEST_CONFIG.googleAds.clientId,
        client_secret: TEST_CONFIG.googleAds.clientSecret,
        redirect_uri: `${TEST_CONFIG.app.url}/auth/callback`,
        grant_type: 'authorization_code',
      })
    );
  });

  test('stores tokens in session after successful exchange', async () => {
    axios.post.mockResolvedValue({
      data: { access_token: 'stored-at', refresh_token: 'stored-rt' },
    });
    axios.get.mockResolvedValue({ data: { email: 'user@dealer.com' } });

    const agent = supertest.agent(app);
    await agent.get('/auth/callback?code=test-code');

    // Verify tokens are in session by checking auth status
    const status = await agent.get('/api/auth/status');
    expect(status.body.connected).toBe(true);
  });

  test('fetches user email from Google userinfo endpoint', async () => {
    axios.post.mockResolvedValue({
      data: { access_token: 'my-token', refresh_token: 'my-rt' },
    });
    axios.get.mockResolvedValue({ data: { email: 'john@dealer.com' } });

    const agent = supertest.agent(app);
    await agent.get('/auth/callback?code=test-code');

    expect(axios.get).toHaveBeenCalledWith(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      { headers: { Authorization: 'Bearer my-token' } }
    );

    const status = await agent.get('/api/auth/status');
    expect(status.body.email).toBe('john@dealer.com');
  });

  test('succeeds even if userinfo fetch fails', async () => {
    axios.post.mockResolvedValue({
      data: { access_token: 'at', refresh_token: 'rt' },
    });
    axios.get.mockRejectedValue(new Error('Userinfo failed'));

    const res = await supertest(app)
      .get('/auth/callback?code=test-code')
      .expect(302);

    expect(res.headers.location).toBe('/?connected=true');
  });

  test('redirects with error when no code provided', async () => {
    const res = await supertest(app)
      .get('/auth/callback')
      .expect(302);

    expect(res.headers.location).toBe('/?error=no_code');
  });

  test('redirects with error when token exchange fails', async () => {
    axios.post.mockRejectedValue(new Error('Token exchange failed'));

    const res = await supertest(app)
      .get('/auth/callback?code=bad-code')
      .expect(302);

    expect(res.headers.location).toBe('/?error=oauth_failed');
  });
});

// ---------------------------------------------------------------------------
// GET /auth/logout
// ---------------------------------------------------------------------------
describe('GET /auth/logout', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
  });

  test('redirects to home page', async () => {
    const agent = await authenticatedAgent(app);

    const res = await agent.get('/auth/logout').expect(302);

    expect(res.headers.location).toBe('/');
  });

  test('destroys session so user is no longer authenticated', async () => {
    const agent = await authenticatedAgent(app);

    // Verify authenticated before logout
    let status = await agent.get('/api/auth/status');
    expect(status.body.connected).toBe(true);

    // Logout
    await agent.get('/auth/logout');

    // Verify no longer authenticated
    status = await agent.get('/api/auth/status');
    expect(status.body.connected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/auth/status
// ---------------------------------------------------------------------------
describe('GET /api/auth/status', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
  });

  test('returns connected: false and email null when not authenticated', async () => {
    const res = await supertest(app)
      .get('/api/auth/status')
      .expect(200);

    expect(res.body.connected).toBe(false);
    expect(res.body.email).toBeNull();
  });

  test('returns connected: true when authenticated', async () => {
    const agent = await authenticatedAgent(app);

    const res = await agent.get('/api/auth/status').expect(200);

    expect(res.body.connected).toBe(true);
  });
});
