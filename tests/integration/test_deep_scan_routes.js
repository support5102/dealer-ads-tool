/**
 * Tier 3 Deep Scan Route Tests — validates POST /api/deep-scan endpoint.
 *
 * Tests: src/routes/audit.js (deep-scan route)
 * Mocks: services/google-ads.js, services/deep-scanner.js
 */

const supertest = require('supertest');
const googleAds = require('../../src/services/google-ads');
const deepScanner = require('../../src/services/deep-scanner');
const auditStore = require('../../src/services/audit-store');
const { createTestApp, authenticatedAgent } = require('./test-helpers');

jest.mock('../../src/services/google-ads');
jest.mock('../../src/services/deep-scanner');
jest.mock('../../src/services/audit-engine');
jest.mock('../../src/services/audit-scheduler');

const SAMPLE_DEEP_SCAN_RESULT = {
  findings: [
    {
      checkId: 'bidding_not_manual_cpc',
      severity: 'critical',
      category: 'bidding',
      title: 'Not using Manual CPC',
      message: 'Campaign using wrong strategy',
    },
    {
      checkId: 'negative_conflicts',
      severity: 'warning',
      category: 'negative_keywords',
      title: 'Negative blocks active keyword',
      message: 'Negative "honda" blocks keyword "honda civic"',
    },
  ],
  summary: { total: 2, critical: 1, warning: 1, info: 0 },
  ranAt: '2026-03-19T12:00:00.000Z',
  accountId: '1234567890',
  scanType: 'deep',
  checksRun: ['bidding_strategy', 'negative_conflicts', 'stale_year_references'],
};

function setupMocks() {
  googleAds.refreshAccessToken.mockResolvedValue('fresh-access-token');
  deepScanner.runDeepScan.mockResolvedValue(SAMPLE_DEEP_SCAN_RESULT);
}

describe('POST /api/deep-scan', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
    auditStore.clear();
    setupMocks();
  });

  test('returns 401 when not authenticated', async () => {
    await supertest(app).post('/api/deep-scan?customerId=1234567890').expect(401);
  });

  test('returns 400 when customerId is missing', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.post('/api/deep-scan').expect(400);
    expect(res.body.error).toMatch(/Missing customerId/);
  });

  test('returns 400 for invalid customerId format', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.post('/api/deep-scan?customerId=abc').expect(400);
    expect(res.body.error).toMatch(/Invalid customerId/);
  });

  test('returns deep scan result on success', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.post('/api/deep-scan?customerId=1234567890').expect(200);

    expect(res.body.findings).toHaveLength(2);
    expect(res.body.summary.critical).toBe(1);
    expect(res.body.scanType).toBe('deep');
  });

  test('stores result in audit store', async () => {
    const agent = await authenticatedAgent(app);
    await agent.post('/api/deep-scan?customerId=1234567890').expect(200);

    const stored = auditStore.getLatest('1234567890');
    expect(stored).toBeDefined();
    expect(stored.scanType).toBe('deep');
  });

  test('strips dashes from customerId', async () => {
    const agent = await authenticatedAgent(app);
    await agent.post('/api/deep-scan?customerId=123-456-7890').expect(200);

    expect(deepScanner.runDeepScan).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: '1234567890' })
    );
  });

  test('refreshes access token', async () => {
    const agent = await authenticatedAgent(app, {
      tokens: { access_token: 'at', refresh_token: 'rt' },
      mccId: '999',
    });
    await agent.post('/api/deep-scan?customerId=1234567890').expect(200);

    expect(googleAds.refreshAccessToken).toHaveBeenCalledWith(
      expect.any(Object),
      'rt'
    );
    expect(deepScanner.runDeepScan).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'fresh-access-token',
        loginCustomerId: '999',
      })
    );
  });

  test('returns 500 when deep scanner throws', async () => {
    deepScanner.runDeepScan.mockRejectedValue(new Error('Deep scan failed'));

    const agent = await authenticatedAgent(app);
    const res = await agent.post('/api/deep-scan?customerId=1234567890').expect(500);
    expect(res.body.error).toBeDefined();
  });
});
