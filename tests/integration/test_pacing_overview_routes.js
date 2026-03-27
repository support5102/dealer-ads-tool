/**
 * Tier 3 Pacing Overview Route Tests — validates /api/pacing/all endpoint.
 *
 * Tests: src/routes/pacing.js (GET /api/pacing/all)
 * Mocks: services/google-ads.js, services/goal-reader.js
 */

const googleAds = require('../../src/services/google-ads');
const goalReader = require('../../src/services/goal-reader');
const { createTestApp, authenticatedAgent } = require('./test-helpers');

jest.mock('../../src/services/google-ads');
jest.mock('../../src/services/goal-reader');

const SAMPLE_ACCOUNTS = [
  { id: '1111111111', name: 'Honda of Springfield', currency: 'USD', isManager: false },
  { id: '2222222222', name: 'Toyota of Shelbyville', currency: 'USD', isManager: false },
  { id: '3333333333', name: 'No Budget Dealer', currency: 'USD', isManager: false },
];

const SAMPLE_GOALS = [
  { dealerName: 'Honda of Springfield', monthlyBudget: 15000 },
  { dealerName: 'Toyota of Shelbyville', monthlyBudget: 10000 },
];

const SAMPLE_SPEND = [
  { campaignId: '100', campaignName: 'Search', status: 'ENABLED', spend: 3000 },
  { campaignId: '200', campaignName: 'VLA', status: 'ENABLED', spend: 2000 },
];

const SAMPLE_DAILY_14 = [
  { date: '2026-03-13', spend: 300 },
  { date: '2026-03-14', spend: 310 },
  { date: '2026-03-15', spend: 320 },
  { date: '2026-03-16', spend: 330 },
  { date: '2026-03-17', spend: 340 },
  { date: '2026-03-18', spend: 350 },
  { date: '2026-03-19', spend: 360 },
  { date: '2026-03-20', spend: 400 },
  { date: '2026-03-21', spend: 410 },
  { date: '2026-03-22', spend: 420 },
  { date: '2026-03-23', spend: 430 },
  { date: '2026-03-24', spend: 440 },
  { date: '2026-03-25', spend: 450 },
  { date: '2026-03-26', spend: 460 },
];

function setupMocks() {
  googleAds.refreshAccessToken.mockResolvedValue('fresh-token');
  googleAds.getMonthSpend.mockResolvedValue(SAMPLE_SPEND);
  googleAds.getDailySpendLast14Days.mockResolvedValue(SAMPLE_DAILY_14);
  goalReader.readGoals.mockResolvedValue(SAMPLE_GOALS);
}

describe('GET /api/pacing/all', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createTestApp();
    setupMocks();
  });

  test('returns pacing data for all matched accounts', async () => {
    const agent = await authenticatedAgent(app, { accounts: SAMPLE_ACCOUNTS });
    const res = await agent.get('/api/pacing/all').expect(200);

    expect(res.body.totalAccounts).toBe(2); // only 2 have goals
    expect(res.body.loadedAccounts).toBe(2);
    expect(res.body.accounts).toHaveLength(2);
    expect(res.body.failed).toHaveLength(0);

    const honda = res.body.accounts.find(a => a.dealerName === 'Honda of Springfield');
    expect(honda).toBeDefined();
    expect(honda.customerId).toBe('1111111111');
    expect(honda.monthlyBudget).toBe(15000);
    expect(honda.mtdSpend).toBe(5000); // 3000 + 2000
    expect(honda.status).toBeDefined();
    expect(honda.pacePercent).toBeDefined();
    expect(honda.dailyAdjustment).toBeDefined();
    expect(honda.sevenDayAvg).toBeDefined();
    expect(honda.sevenDayTrend).toBeDefined();
    expect(honda.sevenDayTrendPercent).toBeDefined();
  });

  test('excludes accounts without matching goals', async () => {
    const agent = await authenticatedAgent(app, { accounts: SAMPLE_ACCOUNTS });
    const res = await agent.get('/api/pacing/all').expect(200);

    const names = res.body.accounts.map(a => a.dealerName);
    expect(names).not.toContain('No Budget Dealer');
  });

  test('returns 401 when not authenticated', async () => {
    const agent = require('supertest').agent(app);
    await agent.get('/api/pacing/all').expect(401);
  });

  test('returns 400 when no accounts in session', async () => {
    const agent = await authenticatedAgent(app, { accounts: [] });
    const res = await agent.get('/api/pacing/all').expect(400);
    expect(res.body.error).toMatch(/No accounts loaded/);
  });

  test('returns 500 when Google Sheets read fails', async () => {
    goalReader.readGoals.mockRejectedValue(new Error('Sheets API error'));
    const agent = await authenticatedAgent(app, { accounts: SAMPLE_ACCOUNTS });
    const res = await agent.get('/api/pacing/all').expect(500);
    expect(res.body.error).toMatch(/budget goals/i);
  });

  test('returns empty accounts when no goals match any accounts', async () => {
    goalReader.readGoals.mockResolvedValue([
      { dealerName: 'Unknown Dealer', monthlyBudget: 5000 },
    ]);
    const agent = await authenticatedAgent(app, { accounts: SAMPLE_ACCOUNTS });
    const res = await agent.get('/api/pacing/all').expect(200);
    expect(res.body.accounts).toHaveLength(0);
    expect(res.body.totalAccounts).toBe(0);
  });

  test('handles individual account API failure gracefully', async () => {
    let callCount = 0;
    googleAds.getMonthSpend.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('API failure');
      return SAMPLE_SPEND;
    });

    const agent = await authenticatedAgent(app, { accounts: SAMPLE_ACCOUNTS });
    const res = await agent.get('/api/pacing/all').expect(200);

    expect(res.body.loadedAccounts).toBe(1);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].error).toMatch(/API failure/);
  });

  test('name matching is case-insensitive', async () => {
    const accounts = [
      { id: '1111111111', name: 'HONDA OF SPRINGFIELD', currency: 'USD', isManager: false },
    ];
    goalReader.readGoals.mockResolvedValue([
      { dealerName: 'honda of springfield', monthlyBudget: 15000 },
    ]);
    const agent = await authenticatedAgent(app, { accounts });
    const res = await agent.get('/api/pacing/all').expect(200);
    expect(res.body.accounts).toHaveLength(1);
  });
});
