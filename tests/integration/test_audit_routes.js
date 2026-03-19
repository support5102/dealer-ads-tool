/**
 * Tier 3 Audit Route Tests — validates audit API endpoints.
 *
 * Tests: src/routes/audit.js
 * Mocks: services/google-ads.js, services/audit-engine.js
 */

const supertest = require('supertest');
const googleAds = require('../../src/services/google-ads');
const auditEngine = require('../../src/services/audit-engine');
const auditStore = require('../../src/services/audit-store');
const { createTestApp, authenticatedAgent } = require('./test-helpers');

jest.mock('../../src/services/google-ads');
jest.mock('../../src/services/audit-engine');

const SAMPLE_AUDIT_RESULT = {
  findings: [
    {
      checkId: 'bidding_not_manual_cpc',
      severity: 'critical',
      category: 'bidding',
      title: 'Search campaign not using Manual CPC',
      message: '"Test Campaign" is using TARGET_CPA instead of Manual CPC.',
      details: { campaignId: '100', campaignName: 'Test Campaign', currentStrategy: 'TARGET_CPA' },
    },
  ],
  summary: { total: 1, critical: 1, warning: 0, info: 0 },
  ranAt: '2026-03-19T12:00:00.000Z',
  accountId: '1234567890',
  checksRun: ['bidding_strategy', 'broad_match'],
};

function setupMocks() {
  googleAds.refreshAccessToken.mockResolvedValue('fresh-access-token');
  auditEngine.runAudit.mockResolvedValue(SAMPLE_AUDIT_RESULT);
}

// ─────────────────────────────────────────────────────────────
// POST /api/audit/run
// ─────────────────────────────────────────────────────────────
describe('POST /api/audit/run', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
    auditStore.clear();
    setupMocks();
  });

  test('returns 401 when not authenticated', async () => {
    await supertest(app).post('/api/audit/run?customerId=1234567890').expect(401);
  });

  test('returns 400 when customerId is missing', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.post('/api/audit/run').expect(400);
    expect(res.body.error).toMatch(/Missing customerId/);
  });

  test('runs audit and returns result', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.post('/api/audit/run?customerId=1234567890').expect(200);

    expect(res.body.findings).toHaveLength(1);
    expect(res.body.summary.critical).toBe(1);
    expect(res.body.accountId).toBe('1234567890');
    expect(res.body.ranAt).toBeDefined();
  });

  test('refreshes access token and passes REST context', async () => {
    const agent = await authenticatedAgent(app, {
      tokens: { access_token: 'at', refresh_token: 'rt' },
      mccId: '999',
    });
    await agent.post('/api/audit/run?customerId=1234567890').expect(200);

    expect(googleAds.refreshAccessToken).toHaveBeenCalledWith(
      expect.any(Object),
      'rt'
    );
    expect(auditEngine.runAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'fresh-access-token',
        customerId: '1234567890',
        loginCustomerId: '999',
      }),
      expect.any(Object)
    );
  });

  test('stores audit result for later retrieval', async () => {
    const agent = await authenticatedAgent(app);
    await agent.post('/api/audit/run?customerId=1234567890').expect(200);

    const stored = auditStore.getLatest('1234567890');
    expect(stored).toBeDefined();
    expect(stored.summary.critical).toBe(1);
  });

  test('strips dashes from customerId', async () => {
    const agent = await authenticatedAgent(app);
    await agent.post('/api/audit/run?customerId=123-456-7890').expect(200);

    expect(auditEngine.runAudit).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: '1234567890' }),
      expect.any(Object)
    );
  });

  test('rejects invalid customerId format', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.post('/api/audit/run?customerId=abc').expect(400);
    expect(res.body.error).toMatch(/Invalid customerId/);
  });

  test('passes request body as options to runAudit', async () => {
    const agent = await authenticatedAgent(app);
    await agent
      .post('/api/audit/run?customerId=1234567890')
      .send({ checks: ['bidding_strategy'] })
      .expect(200);

    expect(auditEngine.runAudit).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ checks: ['bidding_strategy'] })
    );
  });

  test('returns 500 when audit engine throws', async () => {
    auditEngine.runAudit.mockRejectedValue(new Error('API quota exceeded'));

    const agent = await authenticatedAgent(app);
    const res = await agent.post('/api/audit/run?customerId=1234567890').expect(500);
    expect(res.body.error).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────
// GET /api/audit/results
// ─────────────────────────────────────────────────────────────
describe('GET /api/audit/results', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
    auditStore.clear();
  });

  test('returns 401 when not authenticated', async () => {
    await supertest(app).get('/api/audit/results?customerId=1234567890').expect(401);
  });

  test('returns 400 when customerId is missing', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/audit/results').expect(400);
    expect(res.body.error).toMatch(/Missing customerId/);
  });

  test('returns 404 when no audit exists for account', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/audit/results?customerId=9999999999').expect(404);
    expect(res.body.error).toMatch(/No audit results/);
  });

  test('returns stored audit result', async () => {
    auditStore.save('1234567890', SAMPLE_AUDIT_RESULT);

    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/audit/results?customerId=1234567890').expect(200);

    expect(res.body.customerId).toBe('1234567890');
    expect(res.body.summary.critical).toBe(1);
  });

  test('strips dashes from customerId', async () => {
    auditStore.save('1234567890', SAMPLE_AUDIT_RESULT);

    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/audit/results?customerId=123-456-7890').expect(200);
    expect(res.body.customerId).toBe('1234567890');
  });
});

// ─────────────────────────────────────────────────────────────
// GET /api/audit/results/all
// ─────────────────────────────────────────────────────────────
describe('GET /api/audit/results/all', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
    auditStore.clear();
  });

  test('returns 401 when not authenticated', async () => {
    await supertest(app).get('/api/audit/results/all').expect(401);
  });

  test('returns empty array when no audits exist', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/audit/results/all').expect(200);
    expect(res.body.accounts).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  test('returns latest results for all audited accounts', async () => {
    auditStore.save('1111111111', { ...SAMPLE_AUDIT_RESULT, accountId: '1111111111' });
    auditStore.save('2222222222', { ...SAMPLE_AUDIT_RESULT, accountId: '2222222222', summary: { total: 0, critical: 0, warning: 0, info: 0 } });

    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/audit/results/all').expect(200);

    expect(res.body.total).toBe(2);
    expect(res.body.accounts).toHaveLength(2);
  });
});
