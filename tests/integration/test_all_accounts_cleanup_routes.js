/**
 * Integration tests for /api/all-accounts/* routes.
 *
 * Mocks google-ads service + account-iterator. Uses the existing test-helpers.
 */

jest.mock('../../src/services/google-ads');
jest.mock('../../src/services/account-iterator');

const googleAds = require('../../src/services/google-ads');
const accountIterator = require('../../src/services/account-iterator');
const { createTestApp, authenticatedAgent } = require('./test-helpers');

const SAMPLE_ACCOUNTS = [
  { customerId: '1111111111', name: 'Honda', currency: 'USD', isManager: false },
  { customerId: '2222222222', name: 'Toyota', currency: 'USD', isManager: false },
];

beforeEach(() => {
  jest.clearAllMocks();
  googleAds.refreshAccessToken = jest.fn().mockResolvedValue('fresh-token');
  accountIterator.discoverAccounts = jest.fn().mockResolvedValue(SAMPLE_ACCOUNTS);
});

describe('GET /api/all-accounts/recommendations', () => {
  test('returns 401 when not authenticated', async () => {
    const app = createTestApp({ allAccountsCleanupEnabled: true });
    const supertest = require('supertest');
    const res = await supertest(app).get('/api/all-accounts/recommendations');
    expect(res.status).toBe(401);
  });

  test('returns 404 when feature flag is off', async () => {
    const app = createTestApp();
    const agent = await authenticatedAgent(app, { mccId: '999' });
    const res = await agent.get('/api/all-accounts/recommendations');
    expect(res.status).toBe(404);
  });

  test('returns aggregated quickClear + review when flag on', async () => {
    googleAds.getRecommendations = jest.fn().mockImplementation(async (ctx) => {
      if (ctx.customerId === '1111111111') return [{ resourceName: 'rn-1', type: 'ENHANCED_CPC_OPT_IN' }];
      if (ctx.customerId === '2222222222') return [{ resourceName: 'rn-2', type: 'KEYWORD' }];
      return [];
    });

    const app = createTestApp({ allAccountsCleanupEnabled: true });
    const agent = await authenticatedAgent(app, { mccId: '999' });
    const res = await agent.get('/api/all-accounts/recommendations');
    expect(res.status).toBe(200);
    expect(res.body.quickClear).toHaveLength(1);
    expect(res.body.quickClear[0].type).toBe('ENHANCED_CPC_OPT_IN');
    expect(res.body.review).toHaveLength(1);
    expect(res.body.review[0].type).toBe('KEYWORD');
  });
});

describe('GET /api/all-accounts/auto-assets', () => {
  test('returns 404 when feature flag is off', async () => {
    const app = createTestApp();
    const agent = await authenticatedAgent(app, { mccId: '999' });
    const res = await agent.get('/api/all-accounts/auto-assets');
    expect(res.status).toBe(404);
  });

  test('returns grouped types when flag on', async () => {
    googleAds.getAutoCreatedAssets = jest.fn().mockResolvedValue([
      { resourceName: 'rn-h', type: 'HEADLINE', text: 'Hi', scope: 'ad_group_ad' },
    ]);
    const app = createTestApp({ allAccountsCleanupEnabled: true });
    const agent = await authenticatedAgent(app, { mccId: '999' });
    const res = await agent.get('/api/all-accounts/auto-assets');
    expect(res.status).toBe(200);
    expect(res.body.types.HEADLINE).toBeDefined();
    expect(res.body.types.HEADLINE.count).toBe(2);
  });
});

describe('POST /api/all-accounts/recommendations/dismiss-by-type', () => {
  test('returns 404 when flag off', async () => {
    const app = createTestApp();
    const agent = await authenticatedAgent(app, { mccId: '999' });
    const res = await agent.post('/api/all-accounts/recommendations/dismiss-by-type').send({ type: 'ENHANCED_CPC_OPT_IN' });
    expect(res.status).toBe(404);
  });

  test('400 when type missing', async () => {
    const app = createTestApp({ allAccountsCleanupEnabled: true });
    const agent = await authenticatedAgent(app, { mccId: '999' });
    const res = await agent.post('/api/all-accounts/recommendations/dismiss-by-type').send({});
    expect(res.status).toBe(400);
  });

  test('happy path: dismisses across MCC, returns counts', async () => {
    googleAds.getRecommendations = jest.fn().mockResolvedValue([{ resourceName: 'rn-1', type: 'ENHANCED_CPC_OPT_IN' }]);
    googleAds.dismissRecommendations = jest.fn().mockResolvedValue({ dismissed: 1 });
    const app = createTestApp({ allAccountsCleanupEnabled: true });
    const agent = await authenticatedAgent(app, { mccId: '999' });
    const res = await agent.post('/api/all-accounts/recommendations/dismiss-by-type').send({ type: 'ENHANCED_CPC_OPT_IN' });
    expect(res.status).toBe(200);
    expect(res.body.dismissed).toBe(2);
    expect(googleAds.dismissRecommendations).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/all-accounts/recommendations/dismiss-selected', () => {
  test('400 when items array missing/invalid', async () => {
    const app = createTestApp({ allAccountsCleanupEnabled: true });
    const agent = await authenticatedAgent(app, { mccId: '999' });
    const res = await agent.post('/api/all-accounts/recommendations/dismiss-selected').send({ items: 'nope' });
    expect(res.status).toBe(400);
  });

  test('happy path with one item', async () => {
    googleAds.dismissRecommendations = jest.fn().mockResolvedValue({ dismissed: 1 });
    const app = createTestApp({ allAccountsCleanupEnabled: true });
    const agent = await authenticatedAgent(app, { mccId: '999' });
    const res = await agent
      .post('/api/all-accounts/recommendations/dismiss-selected')
      .send({ items: [{ customerId: '1111111111', resourceName: 'rn-a' }] });
    expect(res.status).toBe(200);
    expect(googleAds.dismissRecommendations).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/all-accounts/auto-assets/remove-by-types', () => {
  test('400 when types array missing or empty', async () => {
    const app = createTestApp({ allAccountsCleanupEnabled: true });
    const agent = await authenticatedAgent(app, { mccId: '999' });
    const res1 = await agent.post('/api/all-accounts/auto-assets/remove-by-types').send({});
    expect(res1.status).toBe(400);
    const res2 = await agent.post('/api/all-accounts/auto-assets/remove-by-types').send({ types: [] });
    expect(res2.status).toBe(400);
  });

  test('happy path removes selected types across MCC', async () => {
    googleAds.getAutoCreatedAssets = jest.fn().mockResolvedValue([
      { resourceName: 'rn-h', type: 'HEADLINE', text: '', scope: 'ad_group_ad' },
    ]);
    googleAds.mutateRemoveAssets = jest.fn().mockResolvedValue({ removed: 1 });
    const app = createTestApp({ allAccountsCleanupEnabled: true });
    const agent = await authenticatedAgent(app, { mccId: '999' });
    const res = await agent.post('/api/all-accounts/auto-assets/remove-by-types').send({ types: ['HEADLINE'] });
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(2);
  });
});
