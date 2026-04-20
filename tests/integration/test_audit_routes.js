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
const auditScheduler = require('../../src/services/audit-scheduler');
const { createTestApp, authenticatedAgent } = require('./test-helpers');

jest.mock('../../src/services/google-ads');
jest.mock('../../src/services/audit-engine');
jest.mock('../../src/services/audit-scheduler');

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

// ─────────────────────────────────────────────────────────────
// POST /api/audit/schedule/start
// ─────────────────────────────────────────────────────────────
describe('POST /api/audit/schedule/start', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
    auditScheduler.startScheduledAudit.mockReturnValue({
      started: true, jobName: 'mcc-audit', intervalMs: 14400000, mccId: '9999999999',
    });
  });

  test('returns 401 when not authenticated', async () => {
    await supertest(app).post('/api/audit/schedule/start').expect(401);
  });

  test('starts scheduler and returns result', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.post('/api/audit/schedule/start').expect(200);

    expect(res.body.started).toBe(true);
    expect(res.body.jobName).toBe('mcc-audit');
    expect(auditScheduler.startScheduledAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshToken: 'fake-refresh-token',
      })
    );
  });

  test('returns 401 when not authenticated (no refresh token)', async () => {
    // requireAuth rejects before route handler runs
    await supertest(app).post('/api/audit/schedule/start').expect(401);
  });

  test('passes custom intervalMs from body', async () => {
    const agent = await authenticatedAgent(app);
    await agent
      .post('/api/audit/schedule/start')
      .send({ intervalMs: 3600000 })
      .expect(200);

    expect(auditScheduler.startScheduledAudit).toHaveBeenCalledWith(
      expect.objectContaining({ intervalMs: 3600000 })
    );
  });

  test('rejects invalid intervalMs', async () => {
    auditScheduler.startScheduledAudit.mockImplementation(() => {
      throw new Error('intervalMs must be between');
    });

    const agent = await authenticatedAgent(app);
    const res = await agent
      .post('/api/audit/schedule/start')
      .send({ intervalMs: 100 })
      .expect(500);
    expect(res.body.error).toBeDefined();
  });

  test('returns 500 when scheduler throws', async () => {
    auditScheduler.startScheduledAudit.mockImplementation(() => { throw new Error('bad'); });

    const agent = await authenticatedAgent(app);
    const res = await agent.post('/api/audit/schedule/start').expect(500);
    expect(res.body.error).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/audit/schedule/stop
// ─────────────────────────────────────────────────────────────
describe('POST /api/audit/schedule/stop', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
    auditScheduler.stopScheduledAudit.mockReturnValue({ stopped: true });
  });

  test('returns 401 when not authenticated', async () => {
    await supertest(app).post('/api/audit/schedule/stop').expect(401);
  });

  test('stops scheduler and returns result', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.post('/api/audit/schedule/stop').expect(200);
    expect(res.body.stopped).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// GET /api/audit/schedule/status
// ─────────────────────────────────────────────────────────────
describe('GET /api/audit/schedule/status', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
    auditScheduler.getScheduleStatus.mockReturnValue({
      active: true, running: false, intervalMs: 14400000, mccId: '9999999999',
      runCount: 5, lastRunAccounts: 10, lastRunFindings: 3,
    });
  });

  test('returns 401 when not authenticated', async () => {
    await supertest(app).get('/api/audit/schedule/status').expect(401);
  });

  test('returns scheduler status', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/audit/schedule/status').expect(200);

    expect(res.body.active).toBe(true);
    expect(res.body.mccId).toBe('9999999999');
    expect(res.body.runCount).toBe(5);
  });

  test('returns inactive when no schedule exists', async () => {
    auditScheduler.getScheduleStatus.mockReturnValue({ active: false });

    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/audit/schedule/status').expect(200);
    expect(res.body.active).toBe(false);
  });
});
