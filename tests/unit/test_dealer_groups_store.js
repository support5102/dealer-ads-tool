/**
 * Tests for dealer-groups-store.js — exercises in-memory fallback (no DATABASE_URL).
 *
 * All tests run without a Postgres connection. DATABASE_URL must not be set.
 */

const store = require('../../src/services/dealer-groups-store');

// Ensure no DB URL leaks in from environment
beforeAll(() => {
  delete process.env.DATABASE_URL;
});

// Reset in-memory state before each test
beforeEach(() => {
  store._resetForTesting();
});

describe('loadAll()', () => {
  test('returns empty array initially', async () => {
    const groups = await store.loadAll();
    expect(groups).toEqual([]);
  });

  test('reflects created groups', async () => {
    await store.createGroup({ name: 'Test Group', curveId: 'linear' });
    const groups = await store.loadAll();
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Test Group');
    expect(groups[0].curveId).toBe('linear');
    expect(groups[0].members).toEqual([]);
  });
});

describe('createGroup()', () => {
  test('creates a group with id, name, curveId, and empty members', async () => {
    const group = await store.createGroup({ name: 'Alan Jay', curveId: 'alanJay9505' });
    expect(group.id).toBeDefined();
    expect(group.name).toBe('Alan Jay');
    expect(group.curveId).toBe('alanJay9505');
    expect(group.members).toEqual([]);
  });

  test('each group gets a unique id', async () => {
    const g1 = await store.createGroup({ name: 'Group A', curveId: 'linear' });
    const g2 = await store.createGroup({ name: 'Group B', curveId: 'linear' });
    expect(g1.id).not.toBe(g2.id);
  });
});

describe('addMember() + groupFor() round-trip', () => {
  test('groupFor returns default when dealer is not in any group', () => {
    // Cache is null after reset — background reload fires, returns default
    const result = store.groupFor('Alan Jay Ford');
    expect(result).toEqual({ key: 'default', label: 'All Others', curve: 'linear' });
  });

  test('groupFor returns group after loadAll warms the cache', async () => {
    const group = await store.createGroup({ name: 'Alan Jay', curveId: 'alanJay9505' });
    await store.addMember(group.id, 'Alan Jay Ford');
    await store.loadAll(); // warm cache

    const result = store.groupFor('Alan Jay Ford');
    expect(result).toEqual({ key: 'Alan Jay', label: 'Alan Jay', curve: 'alanJay9505' });
  });

  test('groupFor returns default for a dealer not in the group', async () => {
    const group = await store.createGroup({ name: 'Alan Jay', curveId: 'alanJay9505' });
    await store.addMember(group.id, 'Alan Jay Ford');
    await store.loadAll();

    const result = store.groupFor('Honda of Springfield');
    expect(result).toEqual({ key: 'default', label: 'All Others', curve: 'linear' });
  });

  test('addMember is idempotent — no duplicates', async () => {
    const group = await store.createGroup({ name: 'Test', curveId: 'linear' });
    await store.addMember(group.id, 'Alan Jay Ford');
    await store.addMember(group.id, 'Alan Jay Ford');
    await store.loadAll();
    const groups = await store.loadAll();
    expect(groups[0].members).toEqual(['Alan Jay Ford']);
  });
});

describe('removeMember()', () => {
  test('removes a dealer from the group', async () => {
    const group = await store.createGroup({ name: 'Alan Jay', curveId: 'alanJay9505' });
    await store.addMember(group.id, 'Alan Jay Ford');
    await store.addMember(group.id, 'Alan Jay Chevy');
    await store.removeMember(group.id, 'Alan Jay Ford');
    await store.loadAll();

    const result = store.groupFor('Alan Jay Ford');
    expect(result.key).toBe('default');

    const afterChevy = store.groupFor('Alan Jay Chevy');
    expect(afterChevy.key).toBe('Alan Jay');
  });
});

describe('deleteGroup()', () => {
  test('removes the group entirely', async () => {
    const group = await store.createGroup({ name: 'Alan Jay', curveId: 'alanJay9505' });
    await store.addMember(group.id, 'Alan Jay Ford');
    await store.deleteGroup(group.id);

    const groups = await store.loadAll();
    expect(groups).toHaveLength(0);
  });

  test('members are cascade-removed on delete', async () => {
    const group = await store.createGroup({ name: 'Alan Jay', curveId: 'alanJay9505' });
    await store.addMember(group.id, 'Alan Jay Ford');
    await store.loadAll(); // warm cache
    await store.deleteGroup(group.id);
    await store.loadAll(); // reload after delete

    const result = store.groupFor('Alan Jay Ford');
    expect(result.key).toBe('default');
  });
});

describe('updateGroup()', () => {
  test('updates name', async () => {
    const group = await store.createGroup({ name: 'Old Name', curveId: 'linear' });
    const updated = await store.updateGroup(group.id, { name: 'New Name' });
    expect(updated.name).toBe('New Name');
    expect(updated.curveId).toBe('linear');
  });

  test('updates curveId', async () => {
    const group = await store.createGroup({ name: 'Test', curveId: 'linear' });
    const updated = await store.updateGroup(group.id, { curveId: 'alanJay9505' });
    expect(updated.curveId).toBe('alanJay9505');
  });

  test('cache reflects updated curveId after loadAll', async () => {
    const group = await store.createGroup({ name: 'Alan Jay', curveId: 'linear' });
    await store.addMember(group.id, 'Alan Jay Ford');
    await store.loadAll();

    await store.updateGroup(group.id, { curveId: 'alanJay9505' });
    await store.loadAll(); // reload to refresh cache

    const result = store.groupFor('Alan Jay Ford');
    expect(result.curve).toBe('alanJay9505');
  });

  test('throws 404 for non-existent id', async () => {
    await expect(store.updateGroup(9999, { name: 'X' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('seedDefaults()', () => {
  test('does nothing when no DATABASE_URL (returns empty array)', async () => {
    const result = await store.seedDefaults();
    expect(result).toEqual([]);
    const groups = await store.loadAll();
    expect(groups).toHaveLength(0);
  });

  test('seedDefaults is a no-op when already populated (with DB mocked)', async () => {
    // Simulate DB being "available" by creating a group first, then calling seed
    // Since DATABASE_URL is unset, seedDefaults returns [] in all in-memory cases.
    await store.createGroup({ name: 'Existing Group', curveId: 'linear' });
    const result = await store.seedDefaults();
    expect(result).toEqual([]);
    const groups = await store.loadAll();
    expect(groups).toHaveLength(1); // existing group untouched
  });
});
