/**
 * Tests for inventory-baseline-runner.js
 *
 * Uses Jest module mocking to replace siteIdRegistry, savvyInventory, and
 * baselineStore with fakes. All tests run in-process without I/O.
 */

// ── Module mocks ─────────────────────────────────────────────────────────────

// We need the runner to use our fakes. Since the runner uses top-level requires,
// we mock the modules before requiring the runner.

jest.mock('../../src/services/site-id-registry');
jest.mock('../../src/services/savvy-inventory');
jest.mock('../../src/services/inventory-baseline-store');

const siteIdRegistry = require('../../src/services/site-id-registry');
const savvyInventory = require('../../src/services/savvy-inventory');
const baselineStore = require('../../src/services/inventory-baseline-store');
const runner = require('../../src/services/inventory-baseline-runner');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('inventory-baseline-runner run()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: recordSample succeeds
    baselineStore.recordSample = jest.fn().mockResolvedValue(undefined);
  });

  test('returns correct summary for empty mapping', async () => {
    siteIdRegistry.loadAll.mockResolvedValue(new Map());

    const summary = await runner.run();

    expect(summary.total).toBe(0);
    expect(summary.sampled).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.samples).toEqual([]);
  });

  test('iterates all mapped dealers and records a sample for each', async () => {
    const mappings = new Map([
      ['Dealer A', { siteId: 10 }],
      ['Dealer B', { siteId: 20 }],
      ['Dealer C', { siteId: 30 }],
    ]);
    siteIdRegistry.loadAll.mockResolvedValue(mappings);
    savvyInventory.getNewVinCount
      .mockResolvedValueOnce(18)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(25);

    const summary = await runner.run();

    expect(summary.total).toBe(3);
    expect(summary.sampled).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.samples).toEqual([
      { dealerName: 'Dealer A', count: 18 },
      { dealerName: 'Dealer B', count: 7 },
      { dealerName: 'Dealer C', count: 25 },
    ]);

    expect(savvyInventory.getNewVinCount).toHaveBeenCalledTimes(3);
    expect(savvyInventory.getNewVinCount).toHaveBeenCalledWith(10);
    expect(savvyInventory.getNewVinCount).toHaveBeenCalledWith(20);
    expect(savvyInventory.getNewVinCount).toHaveBeenCalledWith(30);

    expect(baselineStore.recordSample).toHaveBeenCalledTimes(3);
    expect(baselineStore.recordSample).toHaveBeenCalledWith('Dealer A', 18);
    expect(baselineStore.recordSample).toHaveBeenCalledWith('Dealer B', 7);
    expect(baselineStore.recordSample).toHaveBeenCalledWith('Dealer C', 25);
  });

  test('per-dealer failure does not stop the run — other dealers still sampled', async () => {
    const mappings = new Map([
      ['Good Dealer', { siteId: 1 }],
      ['Bad Dealer', { siteId: 2 }],
      ['Also Good', { siteId: 3 }],
    ]);
    siteIdRegistry.loadAll.mockResolvedValue(mappings);

    savvyInventory.getNewVinCount
      .mockResolvedValueOnce(10)
      .mockRejectedValueOnce(new Error('API timeout'))
      .mockResolvedValueOnce(5);

    const summary = await runner.run();

    expect(summary.total).toBe(3);
    expect(summary.sampled).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.samples).toHaveLength(2);
    expect(summary.samples).toEqual([
      { dealerName: 'Good Dealer', count: 10 },
      { dealerName: 'Also Good', count: 5 },
    ]);
  });

  test('recordSample failure is counted as failed', async () => {
    const mappings = new Map([
      ['Dealer A', { siteId: 10 }],
    ]);
    siteIdRegistry.loadAll.mockResolvedValue(mappings);
    savvyInventory.getNewVinCount.mockResolvedValue(15);
    baselineStore.recordSample.mockRejectedValue(new Error('DB error'));

    const summary = await runner.run();

    expect(summary.total).toBe(1);
    expect(summary.sampled).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.samples).toHaveLength(0);
  });

  test('summary counts are correct with mixed successes and failures', async () => {
    const mappings = new Map([
      ['D1', { siteId: 1 }],
      ['D2', { siteId: 2 }],
      ['D3', { siteId: 3 }],
      ['D4', { siteId: 4 }],
    ]);
    siteIdRegistry.loadAll.mockResolvedValue(mappings);

    savvyInventory.getNewVinCount
      .mockResolvedValueOnce(20)
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(10)
      .mockRejectedValueOnce(new Error('fail'));

    const summary = await runner.run();

    expect(summary.total).toBe(4);
    expect(summary.sampled).toBe(2);
    expect(summary.failed).toBe(2);
  });
});
