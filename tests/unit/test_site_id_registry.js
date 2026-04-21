/**
 * Tests for site-id-registry.js — exercises in-memory fallback (no DATABASE_URL).
 *
 * All tests run without a Postgres connection. DATABASE_URL must not be set.
 */

const registry = require('../../src/services/site-id-registry');

// Ensure no DB URL leaks in from environment
beforeAll(() => {
  delete process.env.DATABASE_URL;
});

// Reset in-memory state before each test
beforeEach(() => {
  registry._resetForTesting();
});

// ── deriveDealerName ────────────────────────────────────────────────────────

describe('deriveDealerName()', () => {
  // NOTE: Domain slugs like "bobweaverauto" have no word delimiters —
  // derivation produces a single Title Case word for each hyphen-delimited segment.
  // The spec explicitly calls this "approximate" and expects operators to correct
  // names via setMapping() after setup.

  test('strips www. and TLD, Title Cases the slug', () => {
    // "bobweaverauto" has no hyphens → single word capitalized
    expect(registry.deriveDealerName('www.bobweaverauto.com')).toBe('Bobweaverauto');
  });

  test('strips www. and TLD for multi-word-like domain', () => {
    // "alanjaychevrolet" is one slug with no hyphens → "Alanjaychevrolet"
    expect(registry.deriveDealerName('www.alanjaychevrolet.com')).toBe('Alanjaychevrolet');
  });

  test('handles hyphens as word separators', () => {
    // "alanjayfordofsebring-old" → two segments → "Alanjayfordofsebring Old"
    expect(registry.deriveDealerName('alanjayfordofsebring-old.azurewebsites.net'))
      .toBe('Alanjayfordofsebring Old');
  });

  test('handles no-www domain (azurewebsites) — returns non-empty string', () => {
    const name = registry.deriveDealerName('alanjayfordofsebring-old.azurewebsites.net');
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });

  test('simple domain srqauto.com yields "Srqauto"', () => {
    expect(registry.deriveDealerName('www.srqauto.com')).toBe('Srqauto');
  });
});

// ── loadAll ─────────────────────────────────────────────────────────────────

describe('loadAll()', () => {
  test('returns empty Map initially (in-memory mode)', async () => {
    const result = await registry.loadAll();
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  test('reflects mappings added via setMapping', async () => {
    await registry.setMapping('Alan Jay Ford', 66, 'www.alanjayfordofsebring.com');
    const result = await registry.loadAll();
    expect(result.size).toBe(1);
    expect(result.get('Alan Jay Ford')).toEqual({ siteId: 66, liveUrl: 'www.alanjayfordofsebring.com' });
  });
});

// ── setMapping + siteIdFor round-trip ────────────────────────────────────────

describe('setMapping() + siteIdFor() round-trip', () => {
  test('siteIdFor returns null for unmapped dealer', () => {
    // Cache is null after reset — background reload fires, returns null
    const result = registry.siteIdFor('Unknown Dealer');
    expect(result).toBeNull();
  });

  test('siteIdFor returns mapping after loadAll warms cache', async () => {
    await registry.setMapping('SRQ Auto', 78, 'www.srqauto.com');
    await registry.loadAll(); // warm cache

    const result = registry.siteIdFor('SRQ Auto');
    expect(result).toEqual({ siteId: 78, liveUrl: 'www.srqauto.com' });
  });

  test('siteIdFor returns null for a dealer not in the registry', async () => {
    await registry.setMapping('SRQ Auto', 78, 'www.srqauto.com');
    await registry.loadAll();

    const result = registry.siteIdFor('Honda of Springfield');
    expect(result).toBeNull();
  });

  test('setMapping updates an existing entry (upsert)', async () => {
    await registry.setMapping('SRQ Auto', 78, 'www.srqauto.com');
    await registry.setMapping('SRQ Auto', 78, 'www.srqauto-updated.com'); // update URL
    await registry.loadAll();

    const result = registry.siteIdFor('SRQ Auto');
    expect(result.liveUrl).toBe('www.srqauto-updated.com');
  });

  test('after setMapping, siteIdFor reflects new value immediately after loadAll', async () => {
    await registry.setMapping('Dealer A', 10, 'www.dealera.com');
    await registry.loadAll();
    expect(registry.siteIdFor('Dealer A')).toEqual({ siteId: 10, liveUrl: 'www.dealera.com' });

    await registry.setMapping('Dealer A', 99, 'www.dealera-new.com');
    await registry.loadAll();
    expect(registry.siteIdFor('Dealer A')).toEqual({ siteId: 99, liveUrl: 'www.dealera-new.com' });
  });
});

// ── removeMapping ────────────────────────────────────────────────────────────

describe('removeMapping()', () => {
  test('removes an existing entry', async () => {
    await registry.setMapping('SRQ Auto', 78, 'www.srqauto.com');
    await registry.loadAll();
    expect(registry.siteIdFor('SRQ Auto')).not.toBeNull();

    await registry.removeMapping('SRQ Auto');
    await registry.loadAll();
    expect(registry.siteIdFor('SRQ Auto')).toBeNull();
  });

  test('is a no-op for a non-existent entry (does not throw)', async () => {
    await expect(registry.removeMapping('Nonexistent Dealer')).resolves.toBeUndefined();
  });
});

// ── seedDefaults ─────────────────────────────────────────────────────────────

describe('seedDefaults()', () => {
  test('populates all 50+ mappings in in-memory mode', async () => {
    const count = await registry.seedDefaults();
    expect(count).toBe(registry.SEED_MAPPINGS.length);
    expect(count).toBeGreaterThanOrEqual(50);

    const all = await registry.loadAll();
    expect(all.size).toBe(registry.SEED_MAPPINGS.length);
  });

  test('idempotent — second call is a no-op, count stays the same', async () => {
    await registry.seedDefaults();
    const sizeAfterFirst = (await registry.loadAll()).size;

    const secondCount = await registry.seedDefaults();
    expect(secondCount).toBe(0);

    const sizeAfterSecond = (await registry.loadAll()).size;
    expect(sizeAfterSecond).toBe(sizeAfterFirst);
  });

  test('all seeded entries have positive siteId', async () => {
    await registry.seedDefaults();
    const all = await registry.loadAll();
    for (const [, value] of all) {
      expect(value.siteId).toBeGreaterThan(0);
    }
  });

  test('SRQ Auto entry (siteId 78) is present after seed', async () => {
    await registry.seedDefaults();
    await registry.loadAll();

    // The seeded name for www.srqauto.com is "Srqauto" (derived from URL slug —
    // operators will correct this to "SRQ Auto" via setMapping() after setup)
    const entry = registry.siteIdFor('Srqauto');
    expect(entry).not.toBeNull();
    expect(entry.siteId).toBe(78);
  });
});

// ── fuzzy (normalized) matching ───────────────────────────────────────────────

describe('siteIdFor() fuzzy/normalized matching', () => {
  test('seed-derived compact name is found by human-readable name with spaces', async () => {
    // Seed key has no spaces (compact, derived from URL slug)
    await registry.setMapping('Alanjayfordofsebring', 66, 'www.alanjayfordofsebring.com');
    await registry.loadAll();

    // Query using the human-readable form (with spaces and mixed case)
    const result = registry.siteIdFor('Alan Jay Ford of Sebring');
    expect(result).not.toBeNull();
    expect(result.siteId).toBe(66);
  });

  test('exact match takes priority over fuzzy when both would match', async () => {
    // Exact entry with correct liveUrl
    await registry.setMapping('Alan Jay Ford of Sebring', 66, 'www.exact.com');
    // Compact entry that would fuzzy-match the same normalized form
    await registry.setMapping('Alanjayfordofsebring', 99, 'www.fuzzy.com');
    await registry.loadAll();

    // Exact key should win
    const result = registry.siteIdFor('Alan Jay Ford of Sebring');
    expect(result).not.toBeNull();
    expect(result.siteId).toBe(66);
    expect(result.liveUrl).toBe('www.exact.com');
  });

  test('fuzzy match is case-insensitive', async () => {
    await registry.setMapping('srqauto', 78, 'www.srqauto.com');
    await registry.loadAll();

    const result = registry.siteIdFor('SRQ AUTO');
    expect(result).not.toBeNull();
    expect(result.siteId).toBe(78);
  });

  test('fuzzy match strips hyphens and underscores', async () => {
    await registry.setMapping('banner-ford', 41, 'www.bannerford.com');
    await registry.loadAll();

    const result = registry.siteIdFor('banner ford');
    expect(result).not.toBeNull();
    expect(result.siteId).toBe(41);
  });

  test('returns null when no exact or fuzzy match exists', async () => {
    await registry.setMapping('SRQ Auto', 78, 'www.srqauto.com');
    await registry.loadAll();

    const result = registry.siteIdFor('Completely Different Dealer');
    expect(result).toBeNull();
  });
});

// ── cache invalidation ────────────────────────────────────────────────────────

describe('cache invalidation', () => {
  test('siteIdFor returns null when cache is stale (not yet loaded)', () => {
    // After reset, cache is null — siteIdFor should return null
    expect(registry.siteIdFor('Any Dealer')).toBeNull();
  });

  test('after setMapping, cache is invalidated; siteIdFor returns new value after reload', async () => {
    await registry.setMapping('Test Dealer', 42, 'www.test.com');
    await registry.loadAll();
    expect(registry.siteIdFor('Test Dealer')).toEqual({ siteId: 42, liveUrl: 'www.test.com' });

    // Now update
    await registry.setMapping('Test Dealer', 43, 'www.test2.com');
    // Cache is now invalidated — before reload, stale
    // Reload and verify
    await registry.loadAll();
    expect(registry.siteIdFor('Test Dealer')).toEqual({ siteId: 43, liveUrl: 'www.test2.com' });
  });
});
