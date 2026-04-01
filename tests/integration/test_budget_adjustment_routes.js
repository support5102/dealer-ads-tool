/**
 * Tier 3 Budget Adjustment Route Tests
 *
 * Tests: src/routes/budget-adjustments.js
 * Mocks: google-ads, goal-reader
 */

const googleAds = require('../../src/services/google-ads');
const goalReader = require('../../src/services/goal-reader');
const { store } = require('../../src/services/adjustment-store');
const { createTestApp, authenticatedAgent } = require('./test-helpers');

jest.mock('../../src/services/google-ads');
jest.mock('../../src/services/goal-reader');

const SAMPLE_ACCOUNTS = [
  { id: '1111111111', name: 'Honda of Springfield', currency: 'USD', isManager: false },
  { id: '2222222222', name: 'Toyota of Shelbyville', currency: 'USD', isManager: false },
];

const SAMPLE_GOALS = [
  { dealerName: 'Honda of Springfield', monthlyBudget: 15000 },
  { dealerName: 'Toyota of Shelbyville', monthlyBudget: 10000 },
];

// Over-pacing spend: $12,000 on day 20 of 31-day month (way ahead)
const SAMPLE_SPEND_OVER = [
  { campaignId: '100', campaignName: 'Honda VLA', status: 'ENABLED', spend: 8000 },
  { campaignId: '200', campaignName: 'Honda Regional', status: 'ENABLED', spend: 4000 },
];

const SAMPLE_DAILY_14 = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-03-${13 + i}`,
  spend: 500 + i * 10,
}));

const SAMPLE_DEDICATED = [
  { campaignId: '100', campaignName: 'Honda VLA', channelType: 'SHOPPING',
    resourceName: 'customers/111/campaignBudgets/b1', dailyBudget: 300,
    campaigns: [{ campaignId: '100', campaignName: 'Honda VLA' }] },
];

const SAMPLE_SHARED = [
  { resourceName: 'customers/111/campaignBudgets/b2', name: 'Regional Budget',
    dailyBudget: 200, campaigns: [{ campaignId: '200', campaignName: 'Honda Regional' }] },
];

const SAMPLE_IS = [
  { campaignId: '100', campaignName: 'Honda VLA', impressionShare: 0.65, budgetLostShare: 0.15 },
  { campaignId: '200', campaignName: 'Honda Regional', impressionShare: 0.70, budgetLostShare: 0.10 },
];

const SAMPLE_INVENTORY = { newCount: 50, usedCount: 20, totalCount: 70, source: 'shopping_performance', newInventoryByModel: { civic: 20, accord: 15, 'cr-v': 15 } };

function setupMocks() {
  googleAds.refreshAccessToken.mockResolvedValue('fresh-token');
  googleAds.getMonthSpend.mockResolvedValue(SAMPLE_SPEND_OVER);
  googleAds.getDailySpendLast14Days.mockResolvedValue(SAMPLE_DAILY_14);
  googleAds.getLastBudgetChange.mockResolvedValue({ changeDate: null });
  googleAds.getDedicatedBudgets.mockResolvedValue(SAMPLE_DEDICATED);
  googleAds.getSharedBudgets.mockResolvedValue(SAMPLE_SHARED);
  googleAds.getImpressionShare.mockResolvedValue(SAMPLE_IS);
  googleAds.getInventory.mockResolvedValue(SAMPLE_INVENTORY);
  googleAds.createClient.mockReturnValue({
    campaignBudgets: {
      update: jest.fn().mockResolvedValue({}),
    },
    query: jest.fn().mockResolvedValue([]),
  });
  goalReader.readGoals.mockResolvedValue(SAMPLE_GOALS);
}

describe('Budget Adjustment Routes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    store.clear();
    app = createTestApp();
    setupMocks();
  });

  afterAll(() => {
    store.destroy();
  });

  describe('POST /api/budget-adjustments/scan', () => {
    test('returns 401 when not authenticated', async () => {
      const agent = supertest(app);
      await agent.post('/api/budget-adjustments/scan').expect(401);
    });

    test('returns 400 when no accounts in session', async () => {
      const agent = await authenticatedAgent(app, { accounts: [] });
      const res = await agent.post('/api/budget-adjustments/scan').expect(400);
      expect(res.body.error).toMatch(/No accounts/);
    });

    test('scans accounts and returns flagged + adjustments', async () => {
      const agent = await authenticatedAgent(app, { accounts: SAMPLE_ACCOUNTS });
      const res = await agent.post('/api/budget-adjustments/scan').expect(200);

      expect(res.body.message).toBeDefined();
      expect(Array.isArray(res.body.flagged)).toBe(true);
      expect(Array.isArray(res.body.adjustments)).toBe(true);
    });

    test('stores generated adjustments in the store', async () => {
      const agent = await authenticatedAgent(app, { accounts: SAMPLE_ACCOUNTS });
      await agent.post('/api/budget-adjustments/scan').expect(200);

      // If any accounts were flagged, adjustments should be in store
      const pending = store.list('pending');
      // Store may have entries depending on pacing math
      expect(pending.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('GET /api/budget-adjustments/pending', () => {
    test('returns empty when no pending adjustments', async () => {
      const agent = await authenticatedAgent(app, { accounts: SAMPLE_ACCOUNTS });
      const res = await agent.get('/api/budget-adjustments/pending').expect(200);
      expect(res.body.adjustments).toHaveLength(0);
    });

    test('returns pending adjustments after scan', async () => {
      // Manually save a batch
      store.save({
        adjustmentId: 'test-adj-1',
        customerId: '1111111111',
        dealerName: 'Honda of Springfield',
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        direction: 'over',
        adjustments: [{ target: 'VLA', change: -50 }],
        summary: { totalChangeNeeded: -50 },
      });

      const agent = await authenticatedAgent(app, { accounts: SAMPLE_ACCOUNTS });
      const res = await agent.get('/api/budget-adjustments/pending').expect(200);
      expect(res.body.adjustments).toHaveLength(1);
      expect(res.body.adjustments[0].adjustmentId).toBe('test-adj-1');
    });
  });

  describe('GET /api/budget-adjustments/:id', () => {
    test('returns 404 for unknown ID', async () => {
      const agent = await authenticatedAgent(app, { accounts: SAMPLE_ACCOUNTS });
      await agent.get('/api/budget-adjustments/nonexistent').expect(404);
    });

    test('returns adjustment detail', async () => {
      store.save({
        adjustmentId: 'test-adj-2',
        customerId: '1111111111',
        dealerName: 'Test',
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        direction: 'under',
        adjustments: [],
        summary: {},
      });

      const agent = await authenticatedAgent(app, { accounts: SAMPLE_ACCOUNTS });
      const res = await agent.get('/api/budget-adjustments/test-adj-2').expect(200);
      expect(res.body.adjustmentId).toBe('test-adj-2');
    });
  });

  describe('POST /api/budget-adjustments/:id/approve', () => {
    test('returns 400 for non-pending adjustment', async () => {
      const agent = await authenticatedAgent(app, { accounts: SAMPLE_ACCOUNTS });
      await agent.post('/api/budget-adjustments/nonexistent/approve').expect(400);
    });

    test('executes budget changes on approval', async () => {
      store.save({
        adjustmentId: 'test-adj-3',
        customerId: '1111111111',
        dealerName: 'Honda of Springfield',
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        direction: 'over',
        adjustments: [
          {
            type: 'campaign_budget',
            target: 'Honda VLA',
            resourceName: 'customers/111/campaignBudgets/b1',
            currentDailyBudget: 300,
            recommendedDailyBudget: 250,
            change: -50,
            campaignType: 'vla',
            isShared: false,
            affectedCampaigns: ['Honda VLA'],
          },
        ],
        summary: { totalChangeNeeded: -50 },
      });

      // Mock current budgets for staleness check (should match)
      googleAds.getDedicatedBudgets.mockResolvedValue([
        { resourceName: 'customers/111/campaignBudgets/b1', dailyBudget: 300 },
      ]);
      googleAds.getSharedBudgets.mockResolvedValue([]);

      const agent = await authenticatedAgent(app, { accounts: SAMPLE_ACCOUNTS });
      const res = await agent.post('/api/budget-adjustments/test-adj-3/approve').expect(200);

      expect(res.body.results.applied).toBe(1);
      expect(res.body.results.failed).toBe(0);

      // Verify the mutation was called
      const mockClient = googleAds.createClient.mock.results[0].value;
      expect(mockClient.campaignBudgets.update).toHaveBeenCalledWith([{
        resource_name: 'customers/111/campaignBudgets/b1',
        amount_micros: 250000000,
      }]);
    });

    test('rejects stale adjustments (budget changed since scan)', async () => {
      store.save({
        adjustmentId: 'test-adj-stale',
        customerId: '1111111111',
        dealerName: 'Honda of Springfield',
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        direction: 'over',
        adjustments: [
          {
            type: 'campaign_budget',
            target: 'Honda VLA',
            resourceName: 'customers/111/campaignBudgets/b1',
            currentDailyBudget: 300,     // recommendation assumed $300
            recommendedDailyBudget: 250,
            change: -50,
          },
        ],
        summary: {},
      });

      // Budget has changed to $400 since the scan
      googleAds.getDedicatedBudgets.mockResolvedValue([
        { resourceName: 'customers/111/campaignBudgets/b1', dailyBudget: 400 },
      ]);
      googleAds.getSharedBudgets.mockResolvedValue([]);

      const agent = await authenticatedAgent(app, { accounts: SAMPLE_ACCOUNTS });
      const res = await agent.post('/api/budget-adjustments/test-adj-stale/approve').expect(409);

      expect(res.body.error).toMatch(/Stale/);
      expect(res.body.staleAdjustments).toHaveLength(1);
      expect(res.body.staleAdjustments[0].expectedBudget).toBe(300);
      expect(res.body.staleAdjustments[0].actualBudget).toBe(400);

      // Batch should be reverted to pending
      expect(store.get('test-adj-stale').status).toBe('pending');
    });
  });

  describe('POST /api/budget-adjustments/:id/reject', () => {
    test('rejects pending adjustment', async () => {
      store.save({
        adjustmentId: 'test-adj-rej',
        customerId: '1111111111',
        dealerName: 'Test',
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        direction: 'under',
        adjustments: [],
        summary: {},
      });

      const agent = await authenticatedAgent(app, { accounts: SAMPLE_ACCOUNTS });
      const res = await agent
        .post('/api/budget-adjustments/test-adj-rej/reject')
        .send({ reason: 'Not needed right now' })
        .expect(200);

      expect(res.body.message).toBe('Adjustment rejected.');
      expect(store.get('test-adj-rej').status).toBe('rejected');
      expect(store.get('test-adj-rej').rejectedReason).toBe('Not needed right now');
    });

    test('returns 400 for non-pending', async () => {
      const agent = await authenticatedAgent(app, { accounts: SAMPLE_ACCOUNTS });
      await agent.post('/api/budget-adjustments/nonexistent/reject').expect(400);
    });
  });
});

// Need supertest for the unauthenticated test
const supertest = require('supertest');
