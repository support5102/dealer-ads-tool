/**
 * Tier 3 Optimization Route Tests — validates optimization API endpoints.
 *
 * Tests: src/routes/optimization.js
 * Mocks: services/google-ads.js
 */

const supertest = require('supertest');
const googleAds = require('../../src/services/google-ads');
const { createTestApp, authenticatedAgent } = require('./test-helpers');

jest.mock('../../src/services/google-ads');

// ── Sample data ──

const SAMPLE_KEYWORDS = [
  {
    keyword: 'ford f-150', matchType: 'EXACT', status: 'ENABLED', negative: false,
    cpcBid: 5.00, adGroupName: 'SD: F-150', adGroupId: '200',
    campaignName: 'Springfield Ford - New - F-150', campaignId: '100',
    clicks: 50, impressions: 1000, averageCpc: 4.50, ctr: 0.05,
    searchImpressionShare: 0.95,
  },
  {
    keyword: 'ford escape', matchType: 'PHRASE', status: 'ENABLED', negative: false,
    cpcBid: 3.00, adGroupName: 'SD: Escape', adGroupId: '201',
    campaignName: 'Springfield Ford - New - Escape', campaignId: '101',
    clicks: 30, impressions: 500, averageCpc: 2.80, ctr: 0.06,
    searchImpressionShare: 0.82,
  },
];

const SAMPLE_IS_DATA = [
  { campaignId: '100', campaignName: 'Springfield Ford - New - F-150', impressionShare: 0.60, budgetLostShare: 0.20 },
  { campaignId: '101', campaignName: 'Springfield Ford - New - Escape', impressionShare: 0.85, budgetLostShare: 0.02 },
];

const SAMPLE_DEDICATED = [
  { campaignId: '100', campaignName: 'PMax: VLA Ads - New', channelType: 'PERFORMANCE_MAX', resourceName: 'customers/123/campaignBudgets/456', dailyBudget: 45 },
  { campaignId: '101', campaignName: 'Springfield Ford - New - F-150', channelType: 'SEARCH', resourceName: 'customers/123/campaignBudgets/457', dailyBudget: 55 },
];

const SAMPLE_SHARED = [
  {
    budgetId: '789', budgetName: 'Shared - Search',
    resourceName: 'customers/123/campaignBudgets/789', dailyBudget: 100,
    campaigns: [
      { campaignId: '200', campaignName: 'Springfield Ford - New - F-150' },
      { campaignId: '201', campaignName: 'Springfield Ford - New - Escape' },
    ],
  },
];

const SAMPLE_RECOMMENDATIONS = [
  { resourceName: 'customers/123/recommendations/1', type: 'USE_BROAD_MATCH_KEYWORD', campaignResourceName: 'customers/123/campaigns/100', adGroupResourceName: null },
  { resourceName: 'customers/123/recommendations/2', type: 'KEYWORD', campaignResourceName: 'customers/123/campaigns/100', adGroupResourceName: null },
  { resourceName: 'customers/123/recommendations/3', type: 'ENHANCED_CPC_OPT_IN', campaignResourceName: 'customers/123/campaigns/101', adGroupResourceName: null },
];

function setupMocks() {
  googleAds.refreshAccessToken.mockResolvedValue('fresh-access-token');
  googleAds.getKeywordPerformance.mockResolvedValue(SAMPLE_KEYWORDS);
  googleAds.getImpressionShare.mockResolvedValue(SAMPLE_IS_DATA);
  googleAds.getDedicatedBudgets.mockResolvedValue(SAMPLE_DEDICATED);
  googleAds.getSharedBudgets.mockResolvedValue(SAMPLE_SHARED);
  googleAds.getRecommendations.mockResolvedValue(SAMPLE_RECOMMENDATIONS);
}

// ─────────────────────────────────────────────────────────────
// POST /api/optimize/cpc/:customerId
// ─────────────────────────────────────────────────────────────
describe('POST /api/optimize/cpc/:customerId', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
    setupMocks();
  });

  test('returns 401 when not authenticated', async () => {
    await supertest(app).post('/api/optimize/cpc/1234567890').expect(401);
  });

  test('returns 400 for invalid customerId', async () => {
    const agent = await authenticatedAgent(app);
    await agent.post('/api/optimize/cpc/abc').expect(400);
  });

  test('returns CPC analysis with adjustments', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.post('/api/optimize/cpc/1234567890').expect(200);
    expect(res.body.accountId).toBe('1234567890');
    expect(res.body.totalKeywordsAnalyzed).toBe(2);
    expect(Array.isArray(res.body.adjustments)).toBe(true);
    expect(res.body.summary).toHaveProperty('decreases');
    expect(res.body.summary).toHaveProperty('increases');
  });

  test('strips hyphens from customerId', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.post('/api/optimize/cpc/123-456-7890').expect(200);
    expect(res.body.accountId).toBe('1234567890');
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/optimize/impression-share/:customerId
// ─────────────────────────────────────────────────────────────
describe('POST /api/optimize/impression-share/:customerId', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
    setupMocks();
  });

  test('returns 401 when not authenticated', async () => {
    await supertest(app).post('/api/optimize/impression-share/1234567890').expect(401);
  });

  test('returns IS analysis with budget changes', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.post('/api/optimize/impression-share/1234567890').expect(200);
    expect(res.body.accountId).toBe('1234567890');
    expect(res.body.campaignsAnalyzed).toBe(2);
    expect(Array.isArray(res.body.budgetChanges)).toBe(true);
    expect(res.body.summary).toHaveProperty('increases');
    expect(res.body.summary).toHaveProperty('decreases');
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/optimize/budgets/:customerId
// ─────────────────────────────────────────────────────────────
describe('POST /api/optimize/budgets/:customerId', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
    setupMocks();
  });

  test('returns 401 when not authenticated', async () => {
    await supertest(app).post('/api/optimize/budgets/1234567890').expect(401);
  });

  test('returns budget analysis with split findings and contention', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.post('/api/optimize/budgets/1234567890').expect(200);
    expect(res.body.accountId).toBe('1234567890');
    expect(Array.isArray(res.body.splitFindings)).toBe(true);
    expect(Array.isArray(res.body.contentionFindings)).toBe(true);
    expect(Array.isArray(res.body.rebalanceSuggestions)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/recommendations/classify/:customerId
// ─────────────────────────────────────────────────────────────
describe('POST /api/recommendations/classify/:customerId', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
    setupMocks();
  });

  test('returns 401 when not authenticated', async () => {
    await supertest(app).post('/api/recommendations/classify/1234567890').expect(401);
  });

  test('returns classified recommendations', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.post('/api/recommendations/classify/1234567890').expect(200);
    expect(res.body.accountId).toBe('1234567890');
    expect(res.body.totalRecommendations).toBe(3);
    expect(res.body.toDismiss.length).toBe(2); // broad match + ECPC
    expect(res.body.toReview.length).toBe(1);  // KEYWORD
    expect(res.body.summary.autoDismiss).toBe(2);
    expect(res.body.summary.needsReview).toBe(1);
  });

  test('returns 400 for invalid customerId', async () => {
    const agent = await authenticatedAgent(app);
    await agent.post('/api/recommendations/classify/bad').expect(400);
  });
});
