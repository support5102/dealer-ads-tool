/**
 * Unit tests for change-alerts-runner.js (Phase 7 / R8).
 *
 * Strategy: jest.mock the three dependencies (google-ads, freshdesk, database)
 * before requiring the runner. Each test configures mocks via mockImplementation /
 * mockResolvedValue to keep the real modules out of the picture entirely.
 *
 * The feature flag (CHANGE_ALERTS_ENABLED) is exercised by temporarily setting
 * process.env and clearing the module registry so config.js re-evaluates.
 */

// ── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../../src/services/google-ads');
jest.mock('../../src/services/freshdesk');
jest.mock('../../src/services/database');
jest.mock('../../src/utils/config');

const googleAds = require('../../src/services/google-ads');
const freshdesk = require('../../src/services/freshdesk');
const database = require('../../src/services/database');
const config = require('../../src/utils/config');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Builds a minimal fake change_event row as Google Ads REST would return it.
 */
function fakeChange(overrides = {}) {
  return {
    changeEvent: {
      resourceName: 'customers/123/changeEvents/456',
      changeDateTime: '2026-04-16 10:00:00',
      changeResourceType: 'CAMPAIGN_BUDGET',
      changeResourceName: 'customers/123/campaignBudgets/789',
      operation: 'UPDATE',
      userEmail: 'user@example.com',
      changedFields: 'campaign_budget.amount_micros',
      oldResource: { campaignBudget: { amountMicros: '5000000' } },
      newResource: { campaignBudget: { amountMicros: '6000000' } },
      ...overrides,
    },
  };
}

/**
 * Returns stub deps (listAccounts / getRestCtxForAccount) that the runner
 * receives as injected arguments.
 */
function makeDeps(accounts = [], restCtx = {}) {
  return {
    listAccounts: jest.fn().mockResolvedValue(accounts),
    getRestCtxForAccount: jest.fn().mockResolvedValue(restCtx),
  };
}

/**
 * Builds a minimal fake Freshdesk client with createTicket captured.
 */
function makeFdClient(ticketIdCounter = { n: 100 }) {
  const created = [];
  return {
    client: {
      createTicket: jest.fn().mockImplementation(async (params) => {
        const id = ticketIdCounter.n++;
        created.push({ id, params });
        return { id, url: `https://savvydealer.freshdesk.com/a/tickets/${id}` };
      }),
    },
    created,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('change-alerts-runner', () => {
  // Fresh require on every test to avoid module-level state contamination
  // (inMemoryDedup set persists across re-requires of the same cached module;
  //  we clear it via the exported reference instead).
  let runner;

  beforeEach(() => {
    jest.clearAllMocks();

    // Default: pool is null (in-memory dedup path)
    database.getPool.mockReturnValue(null);

    // Default: flag enabled
    config.validateEnv.mockReturnValue({
      changeAlertsEnabled: true,
      freshdesk: { apiKey: 'fake-key', domain: 'savvydealer' },
    });

    // Re-require the runner to get a fresh inMemoryDedup
    jest.resetModules();

    // Re-mock after resetModules
    jest.mock('../../src/services/google-ads');
    jest.mock('../../src/services/freshdesk');
    jest.mock('../../src/services/database');
    jest.mock('../../src/utils/config');

    // Re-assign mocked modules after resetModules
    const ga = require('../../src/services/google-ads');
    const fd = require('../../src/services/freshdesk');
    const db = require('../../src/services/database');
    const cfg = require('../../src/utils/config');

    db.getPool.mockReturnValue(null);
    cfg.validateEnv.mockReturnValue({
      changeAlertsEnabled: true,
      freshdesk: { apiKey: 'fake-key', domain: 'savvydealer' },
    });

    runner = require('../../src/services/change-alerts-runner');

    // Expose local refs for test bodies (after resetModules the top-level
    // jest.mock references are stale; we use module-scoped vars instead)
    runner._ga = ga;
    runner._fd = fd;
    runner._db = db;
    runner._cfg = cfg;
  });

  // ── Flag-off ────────────────────────────────────────────────────────────────

  test('flag off → returns disabled:true without calling any dep', async () => {
    const cfg = require('../../src/utils/config');
    cfg.validateEnv.mockReturnValue({ changeAlertsEnabled: false });

    const fd = require('../../src/services/freshdesk');
    fd.getDefaultClient.mockReturnValue(null);

    const deps = makeDeps();
    const result = await runner.run(deps);

    expect(result.disabled).toBe(true);
    expect(result.ticketsCreated).toBe(0);
    expect(deps.listAccounts).not.toHaveBeenCalled();
  });

  // ── Freshdesk not configured ────────────────────────────────────────────────

  test('flag on + Freshdesk not configured → returns fdNotConfigured:true', async () => {
    const fd = require('../../src/services/freshdesk');
    fd.getDefaultClient.mockReturnValue(null);

    const deps = makeDeps();
    const result = await runner.run(deps);

    expect(result.fdNotConfigured).toBe(true);
    expect(result.ticketsCreated).toBe(0);
    expect(deps.listAccounts).not.toHaveBeenCalled();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  test('iterates accounts → creates a ticket per unique change', async () => {
    const { client, created } = makeFdClient();
    const fd = require('../../src/services/freshdesk');
    fd.getDefaultClient.mockReturnValue(client);

    const ga = require('../../src/services/google-ads');
    ga.getRecentChangeEvents.mockResolvedValue([fakeChange()]);

    const account = { name: 'Test Dealer', customerId: '123' };
    const deps = makeDeps([account]);

    const result = await runner.run(deps);

    expect(result.ticketsCreated).toBe(1);
    expect(result.deduped).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.processed).toBe(1);

    expect(created).toHaveLength(1);
    expect(created[0].params.subject).toContain('Test Dealer');
    expect(created[0].params.subject).toContain('[Auto-detect]');
    expect(created[0].params.tags).toContain('auto-detect');
    expect(created[0].params.tags).toContain('pacing-recs-v2');
  });

  // ── Deduplication ───────────────────────────────────────────────────────────

  test('duplicate change → deduped on second run, ticket NOT created again', async () => {
    const { client, created } = makeFdClient();
    const fd = require('../../src/services/freshdesk');
    fd.getDefaultClient.mockReturnValue(client);

    const ga = require('../../src/services/google-ads');
    const change = fakeChange();
    ga.getRecentChangeEvents.mockResolvedValue([change]);

    const account = { name: 'Test Dealer', customerId: '123' };
    const deps = makeDeps([account]);

    // First run — creates ticket
    const result1 = await runner.run(deps);
    expect(result1.ticketsCreated).toBe(1);
    expect(result1.deduped).toBe(0);

    // Second run — same change returned, should be deduped
    const result2 = await runner.run(deps);
    expect(result2.ticketsCreated).toBe(0);
    expect(result2.deduped).toBe(1);

    // Only one ticket ever created
    expect(created).toHaveLength(1);
  });

  // ── Per-account error isolation ─────────────────────────────────────────────

  test('one account query fails → errors incremented, other accounts still processed', async () => {
    const { client, created } = makeFdClient();
    const fd = require('../../src/services/freshdesk');
    fd.getDefaultClient.mockReturnValue(client);

    const ga = require('../../src/services/google-ads');
    ga.getRecentChangeEvents
      .mockRejectedValueOnce(new Error('API timeout'))
      .mockResolvedValueOnce([fakeChange({ resourceName: 'customers/999/changeEvents/1' })]);

    const accounts = [
      { name: 'Bad Dealer', customerId: '111' },
      { name: 'Good Dealer', customerId: '999' },
    ];
    const deps = makeDeps(accounts);

    const result = await runner.run(deps);

    expect(result.processed).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.ticketsCreated).toBe(1);
  });

  // ── buildTicketBody HTML ─────────────────────────────────────────────────────

  test('buildTicketBody includes all key fields in HTML', () => {
    // Access the internal function via a real runner instance.
    // We import it from the same module path as runner.
    // Since runner is already required above, re-use it.
    const account = { name: 'Coleman Chevrolet', customerId: '123-456' };
    const change = fakeChange();

    // We call run() with a single change to capture the description passed to createTicket
    const fd = require('../../src/services/freshdesk');
    const ga = require('../../src/services/google-ads');

    const capturedDescriptions = [];
    fd.getDefaultClient.mockReturnValue({
      createTicket: jest.fn().mockImplementation(async (params) => {
        capturedDescriptions.push(params.description);
        return { id: 200, url: 'https://x.freshdesk.com/a/tickets/200' };
      }),
    });
    ga.getRecentChangeEvents.mockResolvedValue([change]);

    const deps = makeDeps([account]);

    return runner.run(deps).then(() => {
      expect(capturedDescriptions).toHaveLength(1);
      const body = capturedDescriptions[0];

      expect(body).toContain('Coleman Chevrolet');
      expect(body).toContain('123-456');
      expect(body).toContain('CAMPAIGN_BUDGET');
      expect(body).toContain('UPDATE');
      expect(body).toContain('user@example.com');
      expect(body).toContain('campaign_budget.amount_micros');
      expect(body).toContain('pacing-overview.html');
    });
  });

  // ── Multiple changes per account ─────────────────────────────────────────────

  test('multiple changes per account → one ticket each', async () => {
    const { client, created } = makeFdClient();
    const fd = require('../../src/services/freshdesk');
    fd.getDefaultClient.mockReturnValue(client);

    const ga = require('../../src/services/google-ads');
    ga.getRecentChangeEvents.mockResolvedValue([
      fakeChange({ resourceName: 'customers/1/changeEvents/A' }),
      fakeChange({ resourceName: 'customers/1/changeEvents/B', changeDateTime: '2026-04-16 11:00:00' }),
    ]);

    const account = { name: 'Multi Dealer', customerId: '1' };
    const deps = makeDeps([account]);

    const result = await runner.run(deps);

    expect(result.ticketsCreated).toBe(2);
    expect(created).toHaveLength(2);
  });

  // ── Missing resource fields — silently skip ───────────────────────────────────

  test('change with missing resourceName or changeDateTime → skipped, no ticket', async () => {
    const { client, created } = makeFdClient();
    const fd = require('../../src/services/freshdesk');
    fd.getDefaultClient.mockReturnValue(client);

    const ga = require('../../src/services/google-ads');
    ga.getRecentChangeEvents.mockResolvedValue([
      { changeEvent: { changeDateTime: '2026-04-16 10:00:00' } }, // no resourceName
      { changeEvent: { resourceName: 'customers/1/changeEvents/X' } }, // no changeDateTime
    ]);

    const account = { name: 'Test Dealer', customerId: '1' };
    const deps = makeDeps([account]);

    const result = await runner.run(deps);

    expect(result.ticketsCreated).toBe(0);
    expect(result.errors).toBe(0); // silently skipped, not errors
    expect(created).toHaveLength(0);
  });

  // ── createTicket failure → error counted, run continues ──────────────────────

  test('createTicket throws → error counted, subsequent changes still processed', async () => {
    const fd = require('../../src/services/freshdesk');
    const created = [];
    fd.getDefaultClient.mockReturnValue({
      createTicket: jest.fn()
        .mockRejectedValueOnce(new Error('Freshdesk 429'))
        .mockImplementation(async (params) => {
          const id = 300;
          created.push({ id, params });
          return { id, url: `https://x.freshdesk.com/a/tickets/${id}` };
        }),
    });

    const ga = require('../../src/services/google-ads');
    ga.getRecentChangeEvents.mockResolvedValue([
      fakeChange({ resourceName: 'customers/1/changeEvents/A' }),
      fakeChange({ resourceName: 'customers/1/changeEvents/B', changeDateTime: '2026-04-16 11:00:00' }),
    ]);

    const account = { name: 'Test Dealer', customerId: '1' };
    const deps = makeDeps([account]);

    const result = await runner.run(deps);

    expect(result.errors).toBe(1);
    expect(result.ticketsCreated).toBe(1);
  });

  // ── Empty accounts list ───────────────────────────────────────────────────────

  test('empty accounts list → returns clean summary with no activity', async () => {
    const fd = require('../../src/services/freshdesk');
    fd.getDefaultClient.mockReturnValue({ createTicket: jest.fn() });

    const deps = makeDeps([]);

    const result = await runner.run(deps);

    expect(result.processed).toBe(0);
    expect(result.ticketsCreated).toBe(0);
    expect(result.deduped).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.disabled).toBeUndefined();
    expect(result.fdNotConfigured).toBeUndefined();
  });

  // ── CAMPAIGN / AD_GROUP / CAMPAIGN_CRITERION change types ──────────────────────

  test.each([
    ['CAMPAIGN', 'Campaign added/removed'],
    ['AD_GROUP', 'Ad group added/removed'],
    ['CAMPAIGN_CRITERION', 'Location targeting changed'],
  ])('%s change type → subject contains correct label', async (type, label) => {
    const capturedSubjects = [];
    const fd = require('../../src/services/freshdesk');
    fd.getDefaultClient.mockReturnValue({
      createTicket: jest.fn().mockImplementation(async (params) => {
        capturedSubjects.push(params.subject);
        return { id: 1, url: 'https://x.freshdesk.com/a/tickets/1' };
      }),
    });

    const ga = require('../../src/services/google-ads');
    ga.getRecentChangeEvents.mockResolvedValue([
      fakeChange({ changeResourceType: type }),
    ]);

    const account = { name: 'Type Test Dealer', customerId: '9' };
    const deps = makeDeps([account]);

    await runner.run(deps);

    expect(capturedSubjects).toHaveLength(1);
    expect(capturedSubjects[0]).toContain(label);
  });
});
