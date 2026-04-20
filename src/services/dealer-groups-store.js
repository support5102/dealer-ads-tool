/**
 * Dealer Groups Store — DB-backed registry of dealer groups with curve assignments.
 *
 * Replaces the hardcoded DEALER_GROUPS regex array in strategy-rules.js.
 * Groups are created and managed via the admin UI (/groups.html).
 *
 * Storage: PostgreSQL when DATABASE_URL is set, in-memory fallback otherwise.
 * Cache: module-level sync cache so groupFor() can remain synchronous.
 *
 * Called by: strategy-rules.js (resolveCurveId), pacing-fetcher.js (groupFor),
 *            routes/groups.js (CRUD endpoints)
 */

const db = require('./database');

// ── In-memory fallback state (used when DATABASE_URL is not set) ──
const memGroups = []; // [{ id, name, curveId, members: [dealerName, ...] }]
let nextMemId = 1;

// ── Sync cache (populated by loadAll, invalidated on writes) ──
let cache = null; // null = stale, array = fresh

// ── Default group returned when a dealer isn't in any group ──
const DEFAULT_GROUP = { key: 'default', label: 'All Others', curve: 'linear' };

/**
 * Loads all groups + their members from DB (or in-memory), refreshes cache.
 *
 * @returns {Promise<Array<{id: number, name: string, curveId: string, members: string[]}>>}
 */
async function loadAll() {
  const pool = db.getPool();
  if (pool) {
    try {
      const groupsRes = await pool.query(
        'SELECT id, name, curve_id FROM dealer_groups ORDER BY id'
      );
      const membersRes = await pool.query(
        'SELECT group_id, dealer_name FROM dealer_group_members ORDER BY group_id, dealer_name'
      );

      const membersByGroup = new Map();
      for (const row of membersRes.rows) {
        if (!membersByGroup.has(row.group_id)) membersByGroup.set(row.group_id, []);
        membersByGroup.get(row.group_id).push(row.dealer_name);
      }

      const groups = groupsRes.rows.map(row => ({
        id: row.id,
        name: row.name,
        curveId: row.curve_id,
        members: membersByGroup.get(row.id) || [],
      }));

      cache = groups;
      return groups;
    } catch (err) {
      console.error('[dealer-groups-store] loadAll DB error:', err.message);
      // Fall through to in-memory
    }
  }

  // In-memory fallback
  cache = memGroups.map(g => ({ ...g, members: [...g.members] }));
  return cache;
}

/**
 * Returns the group for a dealer name. SYNCHRONOUS — reads from cache.
 * If cache is stale, triggers an async reload and returns the default group
 * for this call. Next call will have a fresh cache.
 *
 * @param {string} dealerName
 * @returns {{ key: string, label: string, curve: string }}
 */
function groupFor(dealerName) {
  if (cache === null) {
    // Fire-and-forget reload so next call has fresh data
    loadAll().catch(err => console.error('[dealer-groups-store] background loadAll failed:', err.message));
    return DEFAULT_GROUP;
  }

  const name = String(dealerName || '').trim();
  for (const group of cache) {
    if (group.members.includes(name)) {
      return { key: group.name, label: group.name, curve: group.curveId };
    }
  }
  return DEFAULT_GROUP;
}

/**
 * Creates a new group.
 *
 * @param {{ name: string, curveId: string }} params
 * @returns {Promise<{ id: number, name: string, curveId: string, members: string[] }>}
 */
async function createGroup({ name, curveId }) {
  const pool = db.getPool();
  if (pool) {
    try {
      const res = await pool.query(
        'INSERT INTO dealer_groups (name, curve_id) VALUES ($1, $2) RETURNING id, name, curve_id',
        [name, curveId]
      );
      const row = res.rows[0];
      cache = null;
      return { id: row.id, name: row.name, curveId: row.curve_id, members: [] };
    } catch (err) {
      console.error('[dealer-groups-store] createGroup DB error:', err.message);
      throw err;
    }
  }

  // In-memory fallback
  const group = { id: nextMemId++, name, curveId, members: [] };
  memGroups.push(group);
  cache = null;
  return { ...group, members: [] };
}

/**
 * Updates an existing group's name and/or curveId.
 *
 * @param {number} id
 * @param {{ name?: string, curveId?: string }} updates
 * @returns {Promise<{ id: number, name: string, curveId: string, members: string[] }>}
 */
async function updateGroup(id, { name, curveId }) {
  const pool = db.getPool();
  if (pool) {
    try {
      const res = await pool.query(
        'UPDATE dealer_groups SET name = COALESCE($1, name), curve_id = COALESCE($2, curve_id) WHERE id = $3 RETURNING id, name, curve_id',
        [name || null, curveId || null, id]
      );
      if (res.rows.length === 0) throw Object.assign(new Error('Group not found'), { status: 404 });
      const row = res.rows[0];
      // Get current members
      const mRes = await pool.query(
        'SELECT dealer_name FROM dealer_group_members WHERE group_id = $1 ORDER BY dealer_name',
        [id]
      );
      cache = null;
      return { id: row.id, name: row.name, curveId: row.curve_id, members: mRes.rows.map(r => r.dealer_name) };
    } catch (err) {
      console.error('[dealer-groups-store] updateGroup DB error:', err.message);
      throw err;
    }
  }

  // In-memory fallback
  const group = memGroups.find(g => g.id === id);
  if (!group) throw Object.assign(new Error('Group not found'), { status: 404 });
  if (name !== undefined) group.name = name;
  if (curveId !== undefined) group.curveId = curveId;
  cache = null;
  return { ...group, members: [...group.members] };
}

/**
 * Deletes a group (cascade removes members).
 *
 * @param {number} id
 * @returns {Promise<void>}
 */
async function deleteGroup(id) {
  const pool = db.getPool();
  if (pool) {
    try {
      await pool.query('DELETE FROM dealer_groups WHERE id = $1', [id]);
      cache = null;
      return;
    } catch (err) {
      console.error('[dealer-groups-store] deleteGroup DB error:', err.message);
      throw err;
    }
  }

  // In-memory fallback
  const idx = memGroups.findIndex(g => g.id === id);
  if (idx !== -1) memGroups.splice(idx, 1);
  cache = null;
}

/**
 * Adds a dealer to a group. Idempotent (ON CONFLICT DO NOTHING equivalent).
 *
 * @param {number} groupId
 * @param {string} dealerName
 * @returns {Promise<void>}
 */
async function addMember(groupId, dealerName) {
  const pool = db.getPool();
  if (pool) {
    try {
      await pool.query(
        'INSERT INTO dealer_group_members (group_id, dealer_name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [groupId, dealerName]
      );
      cache = null;
      return;
    } catch (err) {
      console.error('[dealer-groups-store] addMember DB error:', err.message);
      throw err;
    }
  }

  // In-memory fallback
  const group = memGroups.find(g => g.id === groupId);
  if (!group) throw Object.assign(new Error('Group not found'), { status: 404 });
  if (!group.members.includes(dealerName)) group.members.push(dealerName);
  cache = null;
}

/**
 * Removes a dealer from a group.
 *
 * @param {number} groupId
 * @param {string} dealerName
 * @returns {Promise<void>}
 */
async function removeMember(groupId, dealerName) {
  const pool = db.getPool();
  if (pool) {
    try {
      await pool.query(
        'DELETE FROM dealer_group_members WHERE group_id = $1 AND dealer_name = $2',
        [groupId, dealerName]
      );
      cache = null;
      return;
    } catch (err) {
      console.error('[dealer-groups-store] removeMember DB error:', err.message);
      throw err;
    }
  }

  // In-memory fallback
  const group = memGroups.find(g => g.id === groupId);
  if (group) {
    group.members = group.members.filter(m => m !== dealerName);
  }
  cache = null;
}

/**
 * Seeds default groups at startup. Creates an empty "Alan Jay" group with
 * curveId 'alanJay9505' if no groups exist and DATABASE_URL is set.
 * Idempotent — does nothing if groups already exist.
 *
 * @returns {Promise<Array>} Created groups (empty array if already seeded or no DB)
 */
async function seedDefaults() {
  const pool = db.getPool();
  // Seed only when DB is available (in-memory dev doesn't need default groups)
  if (!pool) return [];

  try {
    const existing = await loadAll();
    if (existing.length > 0) return []; // already seeded

    const group = await createGroup({ name: 'Alan Jay', curveId: 'alanJay9505' });
    console.log('[dealer-groups-store] Seeded default Alan Jay group (id=%d)', group.id);
    return [group];
  } catch (err) {
    console.error('[dealer-groups-store] seedDefaults error:', err.message);
    return [];
  }
}

/**
 * Resets in-memory state. Used by tests only.
 */
function _resetForTesting() {
  memGroups.length = 0;
  nextMemId = 1;
  cache = null;
}

module.exports = {
  loadAll,
  groupFor,
  createGroup,
  updateGroup,
  deleteGroup,
  addMember,
  removeMember,
  seedDefaults,
  _resetForTesting,
};
