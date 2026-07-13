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
const math = require('./budget-adjust-math');

// ── In-memory fallback state (used when DATABASE_URL is not set) ──
const inMemoryGoals = new Map();   // dealerName → goal object
const inMemoryChanges = [];        // [{ id, dealerName, oldBudget, newBudget, note, changedAt, changedBy, changeScope, changeAmount, linkedRevertId }]
const inMemoryReverts = [];        // [{ id, dealerName, bumpAmount, baselineMonthlyBudget, bumpedMonthlyBudget, appliedChangeId, appliedAt, appliedBy, revertDueDate, status, ticketId, ticketFiledAt }]
let nextChangeId = 1;
let nextRevertId = 1;

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
    dailyBudget:   row.daily_budget   != null ? Number(row.daily_budget)    : null,
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
    id:               row.id,
    oldBudget:        row.old_monthly_budget !== null ? Number(row.old_monthly_budget) : null,
    newBudget:        Number(row.new_monthly_budget),
    note:             row.note,
    changedAt:        row.changed_at,
    changedBy:        row.changed_by ?? null,
    changeScope:      row.change_scope ?? null,
    changeAmount:     row.change_amount != null ? Number(row.change_amount) : null,
    linkedRevertId:   row.linked_revert_id ?? null,
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
    dailyBudget:   inMemoryGoals.get(dealerName)?.dailyBudget ?? null,
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
      id:             nextChangeId++,
      dealerName,
      oldBudget:      null,
      newBudget:      Number(monthlyBudget),
      note:           'Dealer added',
      changedAt:      new Date(),
      changedBy:      updatedBy ?? null,
      changeScope:    null,
      changeAmount:   null,
      linkedRevertId: null,
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
async function updateMonthlyBudget(dealerName, newBudget, note, changedBy, options = {}) {
  const today = options.today || new Date();
  const D = math.daysInMonth(today);
  const newDaily = Math.round((newBudget / D) * 100) / 100;

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
        `UPDATE pending_budget_reverts
            SET status='cancelled'
          WHERE dealer_name = $1 AND status = 'pending'`,
        [dealerName]
      );

      await client.query(
        `UPDATE dealer_goals
            SET monthly_budget = $1, daily_budget = $2,
                updated_at = NOW(), updated_by = $3
          WHERE dealer_name = $4`,
        [newBudget, newDaily, changedBy ?? null, dealerName]
      );

      await client.query(`
        INSERT INTO dealer_budget_changes
          (dealer_name, old_monthly_budget, new_monthly_budget, note, changed_by, change_scope)
        VALUES ($1, $2, $3, $4, $5, 'set_total')
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

  for (const r of inMemoryReverts) {
    if (r.dealerName === dealerName && r.status === 'pending') {
      r.status = 'cancelled';
    }
  }

  const existing = inMemoryGoals.get(dealerName);
  const oldBudget = existing.monthlyBudget;

  inMemoryGoals.set(dealerName, {
    ...existing,
    monthlyBudget: newBudget,
    dailyBudget:   newDaily,
  });
  inMemoryChanges.push({
    id:             nextChangeId++,
    dealerName,
    oldBudget,
    newBudget,
    note:           String(note).trim(),
    changedAt:      new Date(),
    changedBy:      changedBy ?? null,
    changeScope:    'set_total',
    changeAmount:   null,
    linkedRevertId: null,
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
    // pending_budget_reverts.applied_change_id FKs into dealer_budget_changes, and
    // dealer_budget_changes.linked_revert_id FKs back into pending_budget_reverts —
    // so reverts must go first (with the back-reference nulled), then history, then
    // the goal, all atomically. Without this, any dealer with a pending revert 500s
    // on delete with FK 23503 (prod bug, 2026-07-13).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE dealer_budget_changes SET linked_revert_id = NULL WHERE dealer_name = $1',
        [dealerName]);
      await client.query('DELETE FROM pending_budget_reverts WHERE dealer_name = $1', [dealerName]);
      await client.query('DELETE FROM dealer_budget_changes WHERE dealer_name = $1', [dealerName]);
      await client.query('DELETE FROM dealer_goals WHERE dealer_name = $1', [dealerName]);
      await client.query('COMMIT');
      cache = null;
      return;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* connection may be gone */ }
      console.error('[dealer-goals-store] deleteGoal DB error:', err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  // In-memory fallback — same order for parity: reverts, then history, then goal.
  const revertsToRemove = inMemoryReverts
    .map((r, i) => r.dealerName === dealerName ? i : -1)
    .filter(i => i !== -1)
    .reverse();
  for (const idx of revertsToRemove) {
    inMemoryReverts.splice(idx, 1);
  }
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
      id:             c.id,
      oldBudget:      c.oldBudget,
      newBudget:      c.newBudget,
      note:           c.note,
      changedAt:      c.changedAt,
      changedBy:      c.changedBy,
      changeScope:    c.changeScope ?? null,
      changeAmount:   c.changeAmount ?? null,
      linkedRevertId: c.linkedRevertId ?? null,
    }));
}

/**
 * Applies a budget adjustment with one of four scopes. Persists atomically to
 * dealer_goals + dealer_budget_changes (+ pending_budget_reverts for rest_of_month).
 * Cancels any open pending revert for this dealer regardless of new scope.
 */
async function applyBudgetAdjust(args) {
  const {
    dealerName, scope, daySubScope, amount, note, changedBy = null,
    today = new Date(),
  } = args;

  if (!note || String(note).trim().length < 5) {
    throw new Error('Note must be at least 5 characters');
  }

  const pool = db.getPool();
  if (pool) {
    return await applyBudgetAdjustDb({
      pool, dealerName, scope, daySubScope, amount, note: String(note).trim(),
      changedBy, today,
    });
  }
  return applyBudgetAdjustInMemory({
    dealerName, scope, daySubScope, amount, note: String(note).trim(),
    changedBy, today,
  });
}

function applyBudgetAdjustInMemory({ dealerName, scope, daySubScope, amount, note, changedBy, today }) {
  const existing = inMemoryGoals.get(dealerName);
  if (!existing) throw new Error(`Dealer not found: ${dealerName}`);
  const currentMonthly = existing.monthlyBudget;

  const { newMonthlyBudget, newDailyBudget, dailyBudgetWritten } = math.compute({
    scope, daySubScope, amount, currentMonthly, today,
  });

  for (const r of inMemoryReverts) {
    if (r.dealerName === dealerName && r.status === 'pending') {
      r.status = 'cancelled';
    }
  }

  inMemoryGoals.set(dealerName, {
    ...existing,
    monthlyBudget: newMonthlyBudget,
    dailyBudget:   dailyBudgetWritten ? newDailyBudget : existing.dailyBudget,
  });

  const changeId = nextChangeId++;
  const changeRow = {
    id: changeId, dealerName,
    oldBudget: currentMonthly, newBudget: newMonthlyBudget,
    note, changedAt: new Date(), changedBy,
    changeScope: scope === 'day' ? `day_${daySubScope}` : scope,
    changeAmount: amount,
    linkedRevertId: null,
  };
  inMemoryChanges.push(changeRow);

  let pendingRevertId = null;
  const isTemporary = scope === 'rest_of_month' || (scope === 'day' && daySubScope === 'rest_of_month');
  if (isTemporary) {
    pendingRevertId = nextRevertId++;
    inMemoryReverts.push({
      id: pendingRevertId, dealerName,
      bumpAmount: Math.round((newMonthlyBudget - currentMonthly) * 100) / 100,
      baselineMonthlyBudget: currentMonthly,
      bumpedMonthlyBudget: newMonthlyBudget,
      appliedChangeId: changeId,
      appliedAt: new Date(),
      appliedBy: changedBy,
      revertDueDate: math.firstOfNextMonth(today),
      status: 'pending',
      ticketId: null,
      ticketFiledAt: null,
    });
    changeRow.linkedRevertId = pendingRevertId;
  }

  cache = null;
  return { newMonthlyBudget, newDailyBudget: dailyBudgetWritten ? newDailyBudget : null, pendingRevertId };
}

async function applyBudgetAdjustDb({ pool, dealerName, scope, daySubScope, amount, note, changedBy, today }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existingRes = await client.query(
      'SELECT monthly_budget, daily_budget FROM dealer_goals WHERE dealer_name = $1',
      [dealerName]
    );
    if (existingRes.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error(`Dealer not found: ${dealerName}`);
    }
    const currentMonthly = Number(existingRes.rows[0].monthly_budget);

    const { newMonthlyBudget, newDailyBudget, dailyBudgetWritten } = math.compute({
      scope, daySubScope, amount, currentMonthly, today,
    });

    await client.query(
      `UPDATE pending_budget_reverts
          SET status = 'cancelled'
        WHERE dealer_name = $1 AND status = 'pending'`,
      [dealerName]
    );

    if (dailyBudgetWritten) {
      await client.query(
        `UPDATE dealer_goals
            SET monthly_budget = $1, daily_budget = $2,
                updated_at = NOW(), updated_by = $3
          WHERE dealer_name = $4`,
        [newMonthlyBudget, newDailyBudget, changedBy, dealerName]
      );
    } else {
      await client.query(
        `UPDATE dealer_goals
            SET monthly_budget = $1, updated_at = NOW(), updated_by = $2
          WHERE dealer_name = $3`,
        [newMonthlyBudget, changedBy, dealerName]
      );
    }

    const changeScope = scope === 'day' ? `day_${daySubScope}` : scope;
    const changeRes = await client.query(
      `INSERT INTO dealer_budget_changes
         (dealer_name, old_monthly_budget, new_monthly_budget, note, changed_by,
          change_scope, change_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [dealerName, currentMonthly, newMonthlyBudget, note, changedBy, changeScope, amount]
    );
    const newChangeId = changeRes.rows[0].id;

    let pendingRevertId = null;
    const isTemporary = scope === 'rest_of_month' || (scope === 'day' && daySubScope === 'rest_of_month');
    if (isTemporary) {
      const monthlyDelta = Math.round((newMonthlyBudget - currentMonthly) * 100) / 100;
      const revertRes = await client.query(
        `INSERT INTO pending_budget_reverts
           (dealer_name, bump_amount, baseline_monthly_budget, bumped_monthly_budget,
            applied_change_id, applied_by, revert_due_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [dealerName, monthlyDelta, currentMonthly, newMonthlyBudget, newChangeId, changedBy,
         math.firstOfNextMonth(today)]
      );
      pendingRevertId = revertRes.rows[0].id;

      await client.query(
        `UPDATE dealer_budget_changes SET linked_revert_id = $1 WHERE id = $2`,
        [pendingRevertId, newChangeId]
      );
    }

    await client.query('COMMIT');
    cache = null;
    return { newMonthlyBudget, newDailyBudget: dailyBudgetWritten ? newDailyBudget : null, pendingRevertId };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Returns the most recent OPEN pending revert for a dealer, or null if none.
 */
async function getPendingRevert(dealerName) {
  const pool = db.getPool();
  if (pool) {
    const res = await pool.query(
      `SELECT id, dealer_name, bump_amount, baseline_monthly_budget,
              bumped_monthly_budget, applied_change_id, applied_at, applied_by,
              revert_due_date, status, ticket_id, ticket_filed_at
         FROM pending_budget_reverts
        WHERE dealer_name = $1 AND status = 'pending'
        ORDER BY applied_at DESC
        LIMIT 1`,
      [dealerName]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      dealerName: r.dealer_name,
      bumpAmount: Number(r.bump_amount),
      baselineMonthlyBudget: Number(r.baseline_monthly_budget),
      bumpedMonthlyBudget: Number(r.bumped_monthly_budget),
      appliedChangeId: r.applied_change_id,
      appliedAt: r.applied_at,
      appliedBy: r.applied_by,
      revertDueDate: r.revert_due_date,
      status: r.status,
      ticketId: r.ticket_id,
      ticketFiledAt: r.ticket_filed_at,
    };
  }
  for (let i = inMemoryReverts.length - 1; i >= 0; i--) {
    const r = inMemoryReverts[i];
    if (r.dealerName === dealerName && r.status === 'pending') {
      return { ...r };
    }
  }
  return null;
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
  inMemoryReverts.length = 0;
  nextChangeId = 1;
  nextRevertId = 1;
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
  applyBudgetAdjust,
  getPendingRevert,
  deleteGoal,
  getBudgetHistory,
  // Testing
  _resetForTesting,
};
