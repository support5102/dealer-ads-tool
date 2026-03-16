/**
 * Tier 3 Pacing Route Tests — validates pacing dashboard API.
 *
 * Tests: src/routes/pacing.js
 * Mocks: services/google-ads.js, services/goal-reader.js
 */

const supertest = require('supertest');
const googleAds = require('../../src/services/google-ads');
const goalReader = require('../../src/services/goal-reader');
const { createTestApp, authenticatedAgent } = require('./test-helpers');

jest.mock('../../src/services/google-ads');
jest.mock('../../src/services/goal-reader');

// Sample data matching the service return shapes
const SAMPLE_SPEND = [
  { campaignId: '100', campaignName: 'Honda Civic - Search', status: 'ENABLED', spend: 3000 },
  { campaignId: '200', campaignName: 'Honda VLA', status: 'ENABLED', spend: 2000 },
];

const SAMPLE_SHARED_BUDGETS = [
  {
    resourceName: 'customers/1234567890/campaignBudgets/8001',
    name: 'Shared Budget - Honda',
    dailyBudget: 500,
    campaigns: [{ campaignId: '100', campaignName: 'Honda Civic - Search' }],
  },
];

const SAMPLE_IMPRESSION_SHARE = [
  { campaignId: '100', campaignName: 'Honda Civic - Search', impressionShare: 0.85, budgetLostShare: 0.10 },
];

const SAMPLE_INVENTORY = {
  items: [
    { itemId: 'VIN001', condition: 'NEW', brand: 'Honda', model: 'Civic' },
    { itemId: 'VIN002', condition: 'NEW', brand: 'Honda', model: 'Accord' },
    { itemId: 'VIN003', condition: 'USED', brand: 'Honda', model: 'CR-V' },
  ],
  truncated: false,
};

const SAMPLE_GOALS = [
  {
    customerId: '1234567890',
    dealerName: 'Honda of Springfield',
    monthlyBudget: 15000,
    monthlySalesGoal: 45,
    baselineInventory: 200,
  },
  {
    customerId: '9876543210',
    dealerName: 'Toyota of Shelbyville',
    monthlyBudget: 10000,
    monthlySalesGoal: 30,
    baselineInventory: 150,
  },
];

function setupMocks() {
  googleAds.createClient.mockReturnValue({});
  googleAds.getMonthSpend.mockResolvedValue(SAMPLE_SPEND);
  googleAds.getSharedBudgets.mockResolvedValue(SAMPLE_SHARED_BUDGETS);
  googleAds.getImpressionShare.mockResolvedValue(SAMPLE_IMPRESSION_SHARE);
  googleAds.getInventory.mockResolvedValue(SAMPLE_INVENTORY);
  goalReader.readGoals.mockResolvedValue(SAMPLE_GOALS);
}

// ---------------------------------------------------------------------------
// GET /api/pacing
// ---------------------------------------------------------------------------
describe('GET /api/pacing', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
    setupMocks();
  });

  test('returns 401 when not authenticated', async () => {
    await supertest(app).get('/api/pacing?customerId=1234567890').expect(401);
  });

  test('returns 400 when customerId is missing', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/pacing').expect(400);
    expect(res.body.error).toMatch(/Missing customerId/);
  });

  test('returns pacing recommendation for a valid dealer', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/pacing?customerId=1234567890').expect(200);

    expect(res.body.customerId).toBe('1234567890');
    expect(res.body.dealerName).toBe('Honda of Springfield');
    expect(res.body.totalSpend).toBe(5000);
    expect(res.body.pacing).toBeDefined();
    expect(res.body.status).toBeDefined();
    expect(res.body.statusColor).toBeDefined();
    expect(res.body.recommendations).toBeDefined();
    expect(res.body.impressionShareSummary).toBeDefined();
    expect(res.body.inventory).toBeDefined();
  });

  test('creates Google Ads client with session credentials', async () => {
    const agent = await authenticatedAgent(app, {
      tokens: { access_token: 'at', refresh_token: 'rt' },
      mccId: '999',
    });
    await agent.get('/api/pacing?customerId=1234567890').expect(200);

    expect(googleAds.createClient).toHaveBeenCalledWith(
      expect.any(Object),
      'rt',
      '1234567890',
      '999'
    );
  });

  test('fetches all data in parallel', async () => {
    const agent = await authenticatedAgent(app);
    await agent.get('/api/pacing?customerId=1234567890').expect(200);

    expect(googleAds.getMonthSpend).toHaveBeenCalledTimes(1);
    expect(googleAds.getSharedBudgets).toHaveBeenCalledTimes(1);
    expect(googleAds.getImpressionShare).toHaveBeenCalledTimes(1);
    expect(googleAds.getInventory).toHaveBeenCalledTimes(1);
  });

  test('returns 404 when no goal matches customerId', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/pacing?customerId=0000000000').expect(404);
    expect(res.body.error).toMatch(/No goal found/);
    expect(res.body.customerId).toBe('0000000000');
  });

  test('counts only NEW vehicles for inventory', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/pacing?customerId=1234567890').expect(200);

    // SAMPLE_INVENTORY has 2 NEW + 1 USED
    expect(res.body.inventory.count).toBe(2);
  });

  test('includes pacing calculations with correct budget', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/pacing?customerId=1234567890').expect(200);

    expect(res.body.pacing.monthlyBudget).toBe(15000);
    expect(res.body.pacing.spendToDate).toBe(5000);
    expect(res.body.pacing.daysInMonth).toBeGreaterThan(0);
  });

  test('passes error to error handler when Google Ads fails', async () => {
    googleAds.getMonthSpend.mockRejectedValue(new Error('API quota exceeded'));

    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/pacing?customerId=1234567890').expect(500);
    expect(res.body.error).toBeDefined();
  });

  test('handles dashes in customerId', async () => {
    const agent = await authenticatedAgent(app);
    // Route passes customerId as-is to createClient, but strips dashes for goal matching
    await agent.get('/api/pacing?customerId=123-456-7890').expect(200);

    expect(googleAds.createClient).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      '123-456-7890',
      undefined
    );
  });

  test('returns impression share summary', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/pacing?customerId=1234567890').expect(200);

    expect(res.body.impressionShareSummary.avgImpressionShare).toBeCloseTo(0.85, 2);
  });

  test('handles empty goal list gracefully', async () => {
    goalReader.readGoals.mockResolvedValue([]);

    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/pacing?customerId=1234567890').expect(404);
    expect(res.body.error).toMatch(/No goal found/);
  });

  test('handles inventory with missing items array', async () => {
    googleAds.getInventory.mockResolvedValue({});

    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/pacing?customerId=1234567890').expect(200);
    expect(res.body.inventory.count).toBe(0);
  });

  test('passes error to error handler when readGoals fails', async () => {
    goalReader.readGoals.mockRejectedValue(new Error('Sheets API unavailable'));

    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/pacing?customerId=1234567890').expect(500);
    expect(res.body.error).toBeDefined();
  });
});
