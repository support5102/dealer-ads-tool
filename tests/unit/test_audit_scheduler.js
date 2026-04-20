/**
 * Tier 2 Audit Scheduler Tests — validates scheduled audit orchestration.
 *
 * Tests: src/services/audit-scheduler.js
 * Mocks: scheduler, account-iterator, audit-engine, audit-store, google-ads
 */

jest.mock('../../src/services/scheduler');
jest.mock('../../src/services/account-iterator');
jest.mock('../../src/services/audit-engine');
jest.mock('../../src/services/audit-store');
jest.mock('../../src/services/google-ads');

const scheduler = require('../../src/services/scheduler');
const { discoverAccounts } = require('../../src/services/account-iterator');
const { runAudit } = require('../../src/services/audit-engine');
const auditStore = require('../../src/services/audit-store');
const googleAds = require('../../src/services/google-ads');

const {
  startScheduledAudit,
  stopScheduledAudit,
  getScheduleStatus,
  runScheduledAuditCycle,
  JOB_NAME,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
} = require('../../src/services/audit-scheduler');

const TEST_CONFIG = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  developerToken: 'test-dev-token',
};

const SAMPLE_ACCOUNTS = [
  { customerId: '1111111111', name: 'Dealer A', currency: 'USD', isManager: false },
  { customerId: '2222222222', name: 'Dealer B', currency: 'USD', isManager: false },
];

const SAMPLE_AUDIT_RESULT = {
  findings: [{ checkId: 'test', severity: 'warning', category: 'test', title: 'Test', message: 'msg', details: {} }],
  summary: { total: 1, critical: 0, warning: 1, info: 0 },
  ranAt: '2026-03-19T12:00:00.000Z',
  accountId: '1111111111',
};

function setupMocks() {
  googleAds.refreshAccessToken.mockResolvedValue('fresh-token');
  discoverAccounts.mockResolvedValue(SAMPLE_ACCOUNTS);
  runAudit.mockResolvedValue(SAMPLE_AUDIT_RESULT);
  auditStore.save.mockImplementation(() => {});
  scheduler.registerJob.mockImplementation(() => {});
  scheduler.unregisterJob.mockReturnValue(true);
  scheduler.getJob.mockReturnValue({
    name: JOB_NAME,
    running: false,
    intervalMs: DEFAULT_INTERVAL_MS,
    lastRun: '2026-03-19T12:00:00.000Z',
    lastError: null,
    runCount: 3,
    nextRun: '2026-03-19T16:00:00.000Z',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  setupMocks();
  // Reset module state by stopping any existing schedule
  scheduler.unregisterJob.mockReturnValue(true);
  stopScheduledAudit();
  // Re-setup mocks after stop
  setupMocks();
});

// ─────────────────────────────────────────────────────────────
// startScheduledAudit
// ─────────────────────────────────────────────────────────────
describe('startScheduledAudit', () => {
  test('registers job with scheduler', () => {
    const result = startScheduledAudit({
      config: TEST_CONFIG,
      refreshToken: 'rt-123',
      mccId: '9999999999',
    });

    expect(result.started).toBe(true);
    expect(result.jobName).toBe(JOB_NAME);
    expect(result.intervalMs).toBe(DEFAULT_INTERVAL_MS);
    expect(result.mccId).toBe('9999999999');

    expect(scheduler.registerJob).toHaveBeenCalledWith(
      JOB_NAME,
      expect.any(Function),
      DEFAULT_INTERVAL_MS,
      { runImmediately: false }
    );
  });

  test('accepts custom interval within valid range', () => {
    const twoHours = 2 * 60 * 60 * 1000;
    startScheduledAudit({
      config: TEST_CONFIG,
      refreshToken: 'rt-123',
      mccId: '9999999999',
      intervalMs: twoHours,
    });

    expect(scheduler.registerJob).toHaveBeenCalledWith(
      JOB_NAME,
      expect.any(Function),
      twoHours,
      expect.any(Object)
    );
  });

  test('passes runImmediately option', () => {
    startScheduledAudit({
      config: TEST_CONFIG,
      refreshToken: 'rt-123',
      mccId: '9999999999',
      runImmediately: true,
    });

    expect(scheduler.registerJob).toHaveBeenCalledWith(
      JOB_NAME,
      expect.any(Function),
      expect.any(Number),
      { runImmediately: true }
    );
  });

  test('throws when required params are missing', () => {
    expect(() => startScheduledAudit({})).toThrow(/config, refreshToken, and mccId are required/);
    expect(() => startScheduledAudit({ config: TEST_CONFIG })).toThrow();
    expect(() => startScheduledAudit({ config: TEST_CONFIG, refreshToken: 'rt' })).toThrow();
  });

  test('rejects intervalMs below minimum (30 min)', () => {
    expect(() => startScheduledAudit({
      config: TEST_CONFIG,
      refreshToken: 'rt-123',
      mccId: '9999999999',
      intervalMs: 1000, // 1 second — way too fast
    })).toThrow(/intervalMs must be between/);
  });

  test('rejects intervalMs above maximum (24 hours)', () => {
    expect(() => startScheduledAudit({
      config: TEST_CONFIG,
      refreshToken: 'rt-123',
      mccId: '9999999999',
      intervalMs: 48 * 60 * 60 * 1000, // 48 hours
    })).toThrow(/intervalMs must be between/);
  });

  test('strips dashes from mccId', () => {
    const result = startScheduledAudit({
      config: TEST_CONFIG,
      refreshToken: 'rt-123',
      mccId: '999-999-9999',
    });
    expect(result.mccId).toBe('9999999999');
  });
});

// ─────────────────────────────────────────────────────────────
// stopScheduledAudit
// ─────────────────────────────────────────────────────────────
describe('stopScheduledAudit', () => {
  test('stops running audit schedule', () => {
    startScheduledAudit({
      config: TEST_CONFIG,
      refreshToken: 'rt-123',
      mccId: '9999999999',
    });

    const result = stopScheduledAudit();
    expect(result.stopped).toBe(true);
    expect(scheduler.unregisterJob).toHaveBeenCalledWith(JOB_NAME);
  });

  test('returns false when no schedule is running', () => {
    scheduler.unregisterJob.mockReturnValue(false);
    const result = stopScheduledAudit();
    expect(result.stopped).toBe(false);
    expect(result.reason).toMatch(/No scheduled audit/);
  });
});

// ─────────────────────────────────────────────────────────────
// getScheduleStatus
// ─────────────────────────────────────────────────────────────
describe('getScheduleStatus', () => {
  test('returns inactive when no schedule exists', () => {
    scheduler.getJob.mockReturnValue(null);
    const status = getScheduleStatus();
    expect(status.active).toBe(false);
  });

  test('returns full status when schedule is active', () => {
    startScheduledAudit({
      config: TEST_CONFIG,
      refreshToken: 'rt-123',
      mccId: '9999999999',
    });

    const status = getScheduleStatus();
    expect(status.active).toBe(true);
    expect(status.mccId).toBe('9999999999');
    expect(status.intervalMs).toBe(DEFAULT_INTERVAL_MS);
    expect(status.startedAt).toBeDefined();
    expect(status.runCount).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────
// runScheduledAuditCycle
// ─────────────────────────────────────────────────────────────
describe('runScheduledAuditCycle', () => {
  beforeEach(() => {
    startScheduledAudit({
      config: TEST_CONFIG,
      refreshToken: 'rt-123',
      mccId: '9999999999',
    });
  });

  test('refreshes token, discovers accounts, audits each, stores results', async () => {
    const result = await runScheduledAuditCycle();

    expect(googleAds.refreshAccessToken).toHaveBeenCalledWith(TEST_CONFIG, 'rt-123');
    expect(discoverAccounts).toHaveBeenCalledWith(TEST_CONFIG, 'fresh-token', '9999999999');
    expect(runAudit).toHaveBeenCalledTimes(2); // 2 accounts
    expect(auditStore.save).toHaveBeenCalledTimes(2);

    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.totalFindings).toBe(2); // 1 finding per account × 2
  });

  test('continues when one account audit fails', async () => {
    runAudit.mockResolvedValueOnce(SAMPLE_AUDIT_RESULT)
            .mockRejectedValueOnce(new Error('API error'));

    const result = await runScheduledAuditCycle();

    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
  });

  test('throws when token refresh fails', async () => {
    googleAds.refreshAccessToken.mockRejectedValue(new Error('invalid_grant'));

    await expect(runScheduledAuditCycle()).rejects.toThrow(/Token refresh failed/);
  });

  test('throws when account discovery fails', async () => {
    discoverAccounts.mockRejectedValue(new Error('MCC not found'));

    await expect(runScheduledAuditCycle()).rejects.toThrow(/Account discovery failed/);
  });

  test('throws when no scheduled state exists', async () => {
    stopScheduledAudit();
    await expect(runScheduledAuditCycle()).rejects.toThrow(/No scheduled audit state/);
  });

  test('passes correct restCtx to each audit', async () => {
    await runScheduledAuditCycle();

    expect(runAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'fresh-token',
        developerToken: 'test-dev-token',
        customerId: '1111111111',
        loginCustomerId: '9999999999',
      })
    );
    expect(runAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: '2222222222',
      })
    );
  });

  test('skips cycle if one is already running (concurrency guard)', async () => {
    // Simulate a long-running audit
    runAudit.mockImplementation(() => new Promise(resolve =>
      setTimeout(() => resolve(SAMPLE_AUDIT_RESULT), 1000)
    ));

    const first = runScheduledAuditCycle();
    // Second call while first is in-flight
    const second = await runScheduledAuditCycle();

    expect(second.skipped).toBe(true);
    expect(second.total).toBe(0);

    await first; // Clean up
  });

  test('updates state with run statistics', async () => {
    await runScheduledAuditCycle();

    const status = getScheduleStatus();
    expect(status.lastRunAccounts).toBe(2);
    expect(status.lastRunFindings).toBe(2);
  });
});
