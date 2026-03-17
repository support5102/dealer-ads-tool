/**
 * Tier 3 Account Route Tests — validates account listing and structure loading.
 *
 * Tests: src/routes/accounts.js
 * Mocks: services/google-ads.js (to avoid real Google Ads API calls)
 */

const supertest = require('supertest');
const googleAds = require('../../src/services/google-ads');
const { createTestApp, authenticatedAgent } = require('./test-helpers');

jest.mock('../../src/services/google-ads');

// ---------------------------------------------------------------------------
// GET /api/accounts
// ---------------------------------------------------------------------------
describe('GET /api/accounts', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
  });

  test('returns 401 when not authenticated', async () => {
    await supertest(app).get('/api/accounts').expect(401);
  });

  test('returns list of accounts from MCC', async () => {
    googleAds.refreshAccessToken.mockResolvedValue('fresh-token');
    googleAds.listAccessibleCustomers.mockResolvedValue(['customers/111', 'customers/222']);
    googleAds.queryViaRest
      // First call: account info queries (returns MCC)
      .mockResolvedValueOnce([{ customer: { id: '111', descriptiveName: 'MCC Account', manager: true } }])
      .mockResolvedValueOnce([{ customer: { id: '222', descriptiveName: 'Dealer Account', manager: false } }])
      // Second call: customer_client query via MCC
      .mockResolvedValueOnce([
        { customerClient: { id: '333', descriptiveName: 'Honda Dealer', currencyCode: 'USD', manager: false, level: 1 } },
        { customerClient: { id: '444', descriptiveName: 'Toyota Dealer', currencyCode: 'USD', manager: false, level: 1 } },
      ]);

    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/accounts').expect(200);

    expect(res.body.accounts).toHaveLength(2);
    expect(res.body.accounts[0].name).toBe('Honda Dealer');
    expect(res.body.accounts[1].name).toBe('Toyota Dealer');
  });

  test('accounts are sorted alphabetically by name', async () => {
    googleAds.refreshAccessToken.mockResolvedValue('token');
    googleAds.listAccessibleCustomers.mockResolvedValue(['customers/111']);
    googleAds.queryViaRest
      .mockResolvedValueOnce([{ customer: { id: '111', descriptiveName: 'MCC', manager: true } }])
      .mockResolvedValueOnce([
        { customerClient: { id: '2', descriptiveName: 'Zebra Motors', currencyCode: 'USD', manager: false, level: 1 } },
        { customerClient: { id: '1', descriptiveName: 'Alpha Auto', currencyCode: 'USD', manager: false, level: 1 } },
      ]);

    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/accounts').expect(200);

    expect(res.body.accounts[0].name).toBe('Alpha Auto');
    expect(res.body.accounts[1].name).toBe('Zebra Motors');
  });

  test('falls back to direct account info when MCC query fails', async () => {
    googleAds.refreshAccessToken.mockResolvedValue('token');
    googleAds.listAccessibleCustomers.mockResolvedValue(['customers/555']);
    googleAds.queryViaRest
      .mockResolvedValueOnce([{ customer: { id: '555', descriptiveName: 'Direct Account', manager: false } }]);

    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/accounts').expect(200);

    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].name).toBe('Direct Account');
    expect(res.body.accounts[0].id).toBe('555');
  });

  test('passes error to error handler when service throws', async () => {
    googleAds.refreshAccessToken.mockRejectedValue(new Error('Token expired'));

    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/accounts').expect(500);

    expect(res.body.error).toMatch(/internal server error/i);
  });
});

// ---------------------------------------------------------------------------
// GET /api/account/:customerId/structure
// ---------------------------------------------------------------------------
describe('GET /api/account/:customerId/structure', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
  });

  test('returns 401 when not authenticated', async () => {
    await supertest(app).get('/api/account/123/structure').expect(401);
  });

  test('returns account structure for valid customer ID', async () => {
    const fakeStructure = {
      campaigns: [{ id: '100', name: 'Test Campaign', status: 'ENABLED' }],
      stats: { campaigns: 1, adGroups: 0, keywords: 0 },
    };
    googleAds.refreshAccessToken.mockResolvedValue('fresh-token');
    googleAds.getAccountStructure.mockResolvedValue(fakeStructure);

    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/account/12345/structure').expect(200);

    expect(res.body.customerId).toBe('12345');
    expect(res.body.campaigns).toHaveLength(1);
    expect(res.body.stats.campaigns).toBe(1);
  });

  test('passes REST context with correct customerId and mccId from session', async () => {
    googleAds.refreshAccessToken.mockResolvedValue('fresh-token');
    googleAds.getAccountStructure.mockResolvedValue({ campaigns: [], stats: {} });

    const agent = await authenticatedAgent(app, {
      tokens: { access_token: 'at', refresh_token: 'rt' },
      mccId: '999',
    });
    await agent.get('/api/account/54321/structure').expect(200);

    expect(googleAds.refreshAccessToken).toHaveBeenCalledWith(expect.any(Object), 'rt');
    expect(googleAds.getAccountStructure).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'fresh-token',
        customerId: '54321',
        loginCustomerId: '999',
      })
    );
  });

  test('passes error to error handler when structure query fails', async () => {
    googleAds.refreshAccessToken.mockResolvedValue('fresh-token');
    googleAds.getAccountStructure.mockRejectedValue(new Error('GAQL timeout'));

    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/account/123/structure').expect(500);

    expect(res.body.error).toMatch(/internal server error/i);
  });
});
