/**
 * Tests for savvy-inventory.js — uses injected _fetchFn fake, no real HTTP.
 */

const inventory = require('../../src/services/savvy-inventory');

// Reset cache before each test
beforeEach(() => {
  inventory._resetCacheForTesting();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Builds a fake _fetchFn that simulates Savvy API responses.
 *
 * @param {string[]} vins - VINs returned by GetAllVinsBySiteId
 * @param {Object<string, string>} statuses - vin → 'NEW'|'USED'|'CPO'
 * @param {{ callLog?: string[], delay?: number }} [opts]
 */
function makeFakeFetch(vins, statuses, { callLog, delay = 0 } = {}) {
  return async function fakeFetch(url) {
    if (callLog) callLog.push(url);
    if (delay > 0) await new Promise(r => setTimeout(r, delay));

    if (url.includes('/GetAllVinsBySiteId/')) {
      return vins;
    }

    // Extract VIN from URL  …/GetVehicleOffersAndIncentives/{VIN}
    const vin = url.split('/').pop();
    if (!(vin in statuses)) throw new Error(`Unknown VIN: ${vin}`);
    return { status: statuses[vin], vin };
  };
}

// ── getNewVinCount — basic filtering ────────────────────────────────────────

describe('getNewVinCount()', () => {
  test('counts only NEW VINs, filters out USED and CPO', async () => {
    const _fetchFn = makeFakeFetch(
      ['V1', 'V2', 'V3', 'V4'],
      { V1: 'NEW', V2: 'USED', V3: 'NEW', V4: 'CPO' }
    );

    const count = await inventory.getNewVinCount(78, { _fetchFn });
    expect(count).toBe(2);
  });

  test('returns 0 for empty VIN list', async () => {
    const _fetchFn = makeFakeFetch([], {});
    const count = await inventory.getNewVinCount(78, { _fetchFn });
    expect(count).toBe(0);
  });

  test('returns 0 when all VINs are USED', async () => {
    const _fetchFn = makeFakeFetch(
      ['V1', 'V2'],
      { V1: 'USED', V2: 'USED' }
    );
    const count = await inventory.getNewVinCount(78, { _fetchFn });
    expect(count).toBe(0);
  });

  test('handles per-VIN fetch failure gracefully (does not throw, counts remaining)', async () => {
    let callCount = 0;
    const _fetchFn = async (url) => {
      callCount++;
      if (url.includes('/GetAllVinsBySiteId/')) return ['V1', 'V2', 'V3'];
      const vin = url.split('/').pop();
      if (vin === 'V2') throw new Error('Network timeout');
      return { status: 'NEW', vin };
    };

    const count = await inventory.getNewVinCount(78, { _fetchFn });
    // V1=NEW, V2=error (skip), V3=NEW → count should be 2
    expect(count).toBe(2);
  });

  test('returns 0 when VIN-list fetch fails (logs warning, does not throw)', async () => {
    const _fetchFn = async (url) => {
      if (url.includes('/GetAllVinsBySiteId/')) throw new Error('API unavailable');
      return { status: 'NEW' };
    };

    await expect(inventory.getNewVinCount(78, { _fetchFn })).resolves.toBe(0);
  });
});

// ── getNewVinsList ────────────────────────────────────────────────────────────

describe('getNewVinsList()', () => {
  test('returns only NEW VIN strings', async () => {
    const _fetchFn = makeFakeFetch(
      ['V1', 'V2', 'V3'],
      { V1: 'NEW', V2: 'USED', V3: 'NEW' }
    );

    const vins = await inventory.getNewVinsList(78, { _fetchFn });
    expect(vins).toEqual(expect.arrayContaining(['V1', 'V3']));
    expect(vins).toHaveLength(2);
    expect(vins).not.toContain('V2');
  });

  test('returns [] on empty VIN list', async () => {
    const _fetchFn = makeFakeFetch([], {});
    const vins = await inventory.getNewVinsList(78, { _fetchFn });
    expect(vins).toEqual([]);
  });
});

// ── Cache hit ─────────────────────────────────────────────────────────────────

describe('cache behaviour', () => {
  test('cache hit: second call within 4h does not re-fetch (fetch called once)', async () => {
    const callLog = [];
    const _fetchFn = makeFakeFetch(
      ['V1', 'V2'],
      { V1: 'NEW', V2: 'USED' },
      { callLog }
    );

    const count1 = await inventory.getNewVinCount(78, { _fetchFn });
    const count2 = await inventory.getNewVinCount(78, { _fetchFn });

    expect(count1).toBe(1);
    expect(count2).toBe(1);

    // VIN list fetch (1) + 2 per-VIN fetches = 3 calls total, all on first request
    const vinListCalls = callLog.filter(u => u.includes('GetAllVinsBySiteId'));
    expect(vinListCalls).toHaveLength(1); // only fetched once
  });

  test('cache expiry: after clearing cache, refetches', async () => {
    const callLog = [];
    const _fetchFn = makeFakeFetch(
      ['V1'],
      { V1: 'NEW' },
      { callLog }
    );

    await inventory.getNewVinCount(78, { _fetchFn });
    const callsAfterFirst = callLog.length;

    // Simulate cache expiry by clearing the cache
    inventory._resetCacheForTesting();

    await inventory.getNewVinCount(78, { _fetchFn });
    const callsAfterSecond = callLog.length;

    expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst); // refetched
  });

  test('cache expiry: manipulating fetchedAt forces refetch', async () => {
    const callLog = [];
    const _fetchFn = makeFakeFetch(
      ['V1'],
      { V1: 'NEW' },
      { callLog }
    );

    await inventory.getNewVinCount(78, { _fetchFn });

    // Wind back fetchedAt to 5 hours ago
    const cacheMap = inventory._getCacheForTesting();
    const entry = cacheMap.get(78);
    entry.fetchedAt = Date.now() - (5 * 60 * 60 * 1000); // 5h ago

    await inventory.getNewVinCount(78, { _fetchFn });

    const vinListCalls = callLog.filter(u => u.includes('GetAllVinsBySiteId'));
    expect(vinListCalls).toHaveLength(2); // fetched twice (expired)
  });

  test('different siteIds are cached independently', async () => {
    const callLog78 = [];
    const callLog99 = [];

    const fetch78 = makeFakeFetch(['V1'], { V1: 'NEW' }, { callLog: callLog78 });
    const fetch99 = makeFakeFetch(['V2', 'V3'], { V2: 'USED', V3: 'CPO' }, { callLog: callLog99 });

    const count78 = await inventory.getNewVinCount(78, { _fetchFn: fetch78 });
    const count99 = await inventory.getNewVinCount(99, { _fetchFn: fetch99 });

    expect(count78).toBe(1);
    expect(count99).toBe(0);
  });
});

// ── Concurrency capping ───────────────────────────────────────────────────────

describe('concurrency', () => {
  test('per-VIN fetches are capped at 20 concurrent requests per batch', async () => {
    // Create 45 VINs — should process in 3 batches: 20, 20, 5
    const vins = Array.from({ length: 45 }, (_, i) => `VIN${i}`);
    const statuses = Object.fromEntries(vins.map(v => [v, 'NEW']));

    let maxConcurrent = 0;
    let activeCalls = 0;

    const _fetchFn = async (url) => {
      if (url.includes('/GetAllVinsBySiteId/')) return vins;

      activeCalls++;
      if (activeCalls > maxConcurrent) maxConcurrent = activeCalls;

      // Small delay so concurrent calls can overlap
      await new Promise(r => setTimeout(r, 5));
      activeCalls--;

      const vin = url.split('/').pop();
      return { status: statuses[vin] || 'USED', vin };
    };

    const count = await inventory.getNewVinCount(1, { _fetchFn });
    expect(count).toBe(45);

    // Max concurrent per-VIN calls should never exceed CONCURRENCY_LIMIT (20)
    expect(maxConcurrent).toBeLessThanOrEqual(20);
    // And we should have seen some concurrency (> 1) to prove batching works
    expect(maxConcurrent).toBeGreaterThan(1);
  });
});
