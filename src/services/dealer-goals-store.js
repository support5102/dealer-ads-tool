/**
 * Dealer Goals Store — DB-backed registry of dealer goals (budgets, pacing config, splits).
 *
 * Goals are the source of truth for monthly budgets, pacing modes, curve assignments,
 * and budget sub-splits (new/used/VLA/keyword). Budget changes require a mandatory
 * note for audit purposes.
 *
 * Storage: PostgreSQL when DATABASE_URL is set, in-memory fallback otherwise.
 * Cache: module-level sync cache so goalFor() can remain synchronous.
 *
 * Called by: (Phase B) goal-reader.js, (Phase C) admin UI, (Phase D) overview inline edit
 */

const db = require('./database');

// ── In-memory fallback state (used when DATABASE_URL is not set) ──
const inMemoryGoals = new Map();   // dealerName → goal object
const inMemoryChanges = [];        // [{ id, dealerName, oldBudget, newBudget, note, changedAt, changedBy }]
let nextChangeId = 1;

// ── Sync cache (populated by loadAll, invalidated on writes) ──
let cache = null; // null = stale; Map<dealerName, goal> = fresh

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a DB row from dealer_goals to the canonical goal object shape.
 *
 * @param {object} row
 * @returns {object}
 */
function rowToGoal(row) {
  return {
    dealerName:    row.dealer_name,
    monthlyBudget: row.monthly_budget !== null ? Number(row.monthly_budget) : null,
    newBudget:     row.new_budget     !== null ? Number(row.new_budget)     : null,
    usedBudget:    row.used_budget    !== null ? Number(row.used_budget)    : null,
    miscNotes:     row.misc_notes     ?? null,
    pacingMode:    row.pacing_mode    ?? 'one_click',
    pacingCurveId: row.pacing_curve_id ?? null,
    vlaBudget:     row.vla_budget     !== null ? Number(row.vla_budget)     : null,
    keywordBudget: row.keyword_budget !== null ? Number(row.keyword_budget) : null,
  };
}

/**
 * Maps a DB row from dealer_budget_changes to the canonical change object shape.
 *
 * @param {object} row
 * @returns {object}
 */
function rowToChange(row) {
  return {
    id:         row.id,
    oldBudget:  row.old_monthly_budget !== null ? Number(row.old_monthly_budget) : null,
    newBudget:  Number(row.new_monthly_budget),
    note:       row.note,
    changedAt:  row.changed_at,
    changedBy:  row.changed_by ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Async loaders — populate cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads all dealer goals from DB (or in-memory), refreshes cache.
 *
 * @returns {Promise<Array<object>>}
 */
async function loadAll() {
  const pool = db.getPool();
  if (pool) {
    try {
      const res = await pool.query(
        'SELECT * FROM dealer_goals ORDER BY dealer_name'
      );
      const goals = res.rows.map(rowToGoal);
      const map = new Map(goals.map(g => [g.dealerName, g]));
      cache = map;
      return goals;
    } catch (err) {
      console.error('[dealer-goals-store] loadAll DB error:', err.message);
      // Fall through to in-memory
    }
  }

  // In-memory fallback
  const goals = Array.from(inMemoryGoals.values());
  cache = new Map(goals.map(g => [g.dealerName, { ...g }]));
  return goals.map(g => ({ ...g }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync reads — cache-backed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the goal for a dealer. SYNCHRONOUS — reads from cache.
 * If cache is stale, triggers an async reload and returns null for this call.
 *
 * @param {string} dealerName
 * @returns {object|null}
 */
function goalFor(dealerName) {
  if (cache === null) {
    loadAll().catch(err =>
      console.error('[dealer-goals-store] background loadAll failed:', err.message)
    );
    return null;
  }
  return cache.get(String(dealerName || '').trim()) ?? null;
}

/**
 * Returns all dealer goals. SYNCHRONOUS — reads from cache.
 * If cache is stale, triggers an async reload and returns empty array for this call.
 *
 * @returns {Array<object>}
 */
function allGoals() {
  if (cache === null) {
    loadAll().catch(err =>
      console.error('[dealer-goals-store] background loadAll failed:', err.message)
    );
    return [];
  }
  return Array.from(cache.values());
}

// ─────────────────────────────────────────────────────────────────────────────
// Async writes — invalidate cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inserts or updates a dealer goal. Does NOT require a note.
 *
 * For NEW dealers: automatically writes a "Dealer added" audit entry to dealer_budget_changes.
 * For UPDATES of existing dealers: no audit entry (use updateMonthlyBudget for budget changes).
 *
 * @param {object} goal
 * @param {string}  goal.dealerName     - Required
 * @param {number}  goal.monthlyBudget  - Required
 * @param {number}  [goal.newBudget]
 * @param {number}  [goal.usedBudget]
 * @param {string}  [goal.miscNotes]
 * @param {string}  [goal.pacingMode]
 * @param {string}  [goal.pacingCurveId]
 * @param {number}  [goal.vlaBudget]
 * @param {number}  [goal.keywordBudget]
 * @param {string}  [goal.updatedBy]
 * @returns {Promise<object>} The upserted goal
 */
async function upsertGoal(goal) {
  const {
    dealerName,
    monthlyBudget,
    newBudget     = null,
    usedBudget    = null,
    miscNotes     = null,
    pacingMode    = 'one_click',
    pacingCurveId = null,
    vlaBudget     = null,
    keywordBudget = null,
    updatedBy     = null,
  } = goal;

  const pool = db.getPool();
  if (pool) {
    try {
      // Check if dealer already exists
      const existing = await pool.query(
        'SELECT dealer_name, monthly_budget FROM dealer_goals WHERE dealer_name = $1',
        [dealerName]
      );
      const isNew = existing.rows.length === 0;

      await pool.query(`
        INSERT INTO dealer_goals
          (dealer_name, monthly_budget, new_budget, used_budget, misc_notes,
           pacing_mode, pacing_curve_id, vla_budget, keyword_budget, updated_at, updated_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10)
        ON CONFLICT (dealer_name) DO UPDATE SET
          monthly_budget  = EXCLUDED.monthly_budget,
          new_budget      = EXCLUDED.new_budget,
          used_budget     = EXCLUDED.used_budget,
          misc_notes      = EXCLUDED.misc_notes,
          pacing_mode     = EXCLUDED.pacing_mode,
          pacing_curve_id = EXCLUDED.pacing_curve_id,
          vla_budget      = EXCLUDED.vla_budget,
          keyword_budget  = EXCLUDED.keyword_budget,
          updated_at      = EXCLUDED.updated_at,
          updated_by      = EXCLUDED.updated_by
      `, [dealerName, monthlyBudget, newBudget, usedBudget, miscNotes,
          pacingMode, pacingCurveId, vlaBudget, keywordBudget, updatedBy]);

      if (isNew) {
        await pool.query(`
          INSERT INTO dealer_budget_changes
            (dealer_name, old_monthly_budget, new_monthly_budget, note, changed_by)
          VALUES ($1, NULL, $2, 'Dealer added', $3)
        `, [dealerName, monthlyBudget, updatedBy]);
      }

      cache = null;
      return rowToGoal({
        dealer_name: dealerName,
        monthly_budget: monthlyBudget,
        new_budget: newBudget,
        used_budget: usedBudget,
        misc_notes: miscNotes,
        pacing_mode: pacingMode,
        pacing_curve_id: pacingCurveId,
        vla_budget: vlaBudget,
        keyword_budget: keywordBudget,
      });
    } catch (err) {
      console.error('[dealer-goals-store] upsertGoal DB error:', err.message);
      throw err;
    }
  }

  // In-memory fallback
  const isNew = !inMemoryGoals.has(dealerName);
  const result = {
    dealerName,
    monthlyBudget: Number(monthlyBudget),
    newBudget:     newBudget     !== null ? Number(newBudget)     : null,
    usedBudget:    usedBudget    !== null ? Number(usedBudget)    : null,
    miscNotes:     miscNotes,
    pacingMode:    pacingMode,
    pacingCurveId: pacingCurveId,
    vlaBudget:     vlaBudget     !== null ? Number(vlaBudget)     : null,
    keywordBudget: keywordBudget !== null ? Number(keywordBudget) : null,
  };
  inMemoryGoals.set(dealerName, result);

  if (isNew) {
    inMemoryChanges.push({
      id:         nextChangeId++,
      dealerName,
      oldBudget:  null,
      newBudget:  Number(monthlyBudget),
      note:       'Dealer added',
      changedAt:  new Date(),
      changedBy:  updatedBy ?? null,
    });
  }

  cache = null;
  return { ...result };
}

/**
 * Updates a dealer's monthly budget. REQUIRES a note of at least 5 characters.
 *
 * Writes atomically to both dealer_goals and dealer_budget_changes.
 * Throws descriptive errors for invalid inputs.
 *
 * @param {string} dealerName
 * @param {number} newBudget
 * @param {string} note         - Required, min 5 characters
 * @param {string} [changedBy]
 * @returns {Promise<void>}
 * @throws {Error} If note is missing/too short, budget is invalid, or dealer not found
 */
async function updateMonthlyBudget(dealerName, newBudget, note, changedBy) {
  // Validate note
  if (note == null || String(note).trim().length === 0) {
    throw new Error('Note must be at least 5 characters');
  }
  if (String(note).trim().length < 5) {
    throw new Error('Note must be at least 5 characters');
  }

  // Validate budget
  if (typeof newBudget !== 'number' || isNaN(newBudget) || newBudget <= 0) {
    throw new Error('Monthly budget must be a positive number');
  }

  const pool = db.getPool();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existingRes = await client.query(
        'SELECT monthly_budget FROM dealer_goals WHERE dealer_name = $1',
        [dealerName]
      );
      if (existingRes.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new Error(`Dealer not found: ${dealerName}`);
      }

      const oldBudget = existingRes.rows[0].monthly_budget !== null
        ? Number(existingRes.rows[0].monthly_budget)
        : null;

      await client.query(
        'UPDATE dealer_goals SET monthly_budget = $1, updated_at = NOW(), updated_by = $2 WHERE dealer_name = $3',
        [newBudget, changedBy ?? null, dealerName]
      );

      await client.query(`
        INSERT INTO dealer_budget_changes
          (dealer_name, old_monthly_budget, new_monthly_budget, note, changed_by)
        VALUES ($1, $2, $3, $4, $5)
      `, [dealerName, oldBudget, newBudget, note, changedBy ?? null]);

      await client.query('COMMIT');
      cache = null;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
    return;
  }

  // In-memory fallback
  if (!inMemoryGoals.has(dealerName)) {
    throw new Error(`Dealer not found: ${dealerName}`);
  }

  const existing = inMemoryGoals.get(dealerName);
  const oldBudget = existing.monthlyBudget;

  inMemoryGoals.set(dealerName, { ...existing, monthlyBudget: newBudget });
  inMemoryChanges.push({
    id:         nextChangeId++,
    dealerName,
    oldBudget,
    newBudget,
    note:       String(note).trim(),
    changedAt:  new Date(),
    changedBy:  changedBy ?? null,
  });

  cache = null;
}

/**
 * Deletes a dealer goal and its full budget-change history.
 *
 * @param {string} dealerName
 * @returns {Promise<void>}
 */
async function deleteGoal(dealerName) {
  const pool = db.getPool();
  if (pool) {
    try {
      // Delete history first (no FK cascade defined — manual delete)
      await pool.query('DELETE FROM dealer_budget_changes WHERE dealer_name = $1', [dealerName]);
      await pool.query('DELETE FROM dealer_goals WHERE dealer_name = $1', [dealerName]);
      cache = null;
      return;
    } catch (err) {
      console.error('[dealer-goals-store] deleteGoal DB error:', err.message);
      throw err;
    }
  }

  // In-memory fallback
  inMemoryGoals.delete(dealerName);
  // Remove all history entries for this dealer
  const toRemove = inMemoryChanges
    .map((c, i) => c.dealerName === dealerName ? i : -1)
    .filter(i => i !== -1)
    .reverse();
  for (const idx of toRemove) {
    inMemoryChanges.splice(idx, 1);
  }

  cache = null;
}

/**
 * Returns budget-change history for a dealer, newest first.
 *
 * @param {string} dealerName
 * @returns {Promise<Array<{ id: number, oldBudget: number|null, newBudget: number, note: string, changedAt: Date, changedBy: string|null }>>}
 */
async function getBudgetHistory(dealerName) {
  const pool = db.getPool();
  if (pool) {
    try {
      const res = await pool.query(
        `SELECT id, old_monthly_budget, new_monthly_budget, note, changed_at, changed_by
           FROM dealer_budget_changes
          WHERE dealer_name = $1
          ORDER BY changed_at DESC`,
        [dealerName]
      );
      return res.rows.map(rowToChange);
    } catch (err) {
      console.error('[dealer-goals-store] getBudgetHistory DB error:', err.message);
      throw err;
    }
  }

  // In-memory fallback — newest first
  return inMemoryChanges
    .filter(c => c.dealerName === dealerName)
    .slice()
    .reverse()
    .map(c => ({
      id:        c.id,
      oldBudget: c.oldBudget,
      newBudget: c.newBudget,
      note:      c.note,
      changedAt: c.changedAt,
      changedBy: c.changedBy,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Testing helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resets in-memory state and cache. Used by tests only.
 */
function _resetForTesting() {
  inMemoryGoals.clear();
  inMemoryChanges.length = 0;
  nextChangeId = 1;
  cache = null;
}

module.exports = {
  // Sync reads
  goalFor,
  allGoals,
  // Async loaders
  loadAll,
  // Async writes
  upsertGoal,
  updateMonthlyBudget,
  deleteGoal,
  getBudgetHistory,
  // Testing
  _resetForTesting,
};
