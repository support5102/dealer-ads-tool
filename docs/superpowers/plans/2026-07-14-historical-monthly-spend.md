# Historical Monthly Spend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record each dealer's total monthly spend and let the user see a dealer's month-over-month history by expanding its row on the pacing overview.

**Architecture:** A new `dealer_monthly_spend` table is upserted (latest-wins, keyed by `(dealer_name, period)`) on every capture opportunity — primarily `GET /api/pacing/all`, secondarily `spend-sync`. Because Google Ads MTD resets on the 1st, the current-month row keeps getting overwritten with the running total and settles at the final figure once the calendar rolls over. A new store module owns the table; a new API route serves per-dealer history; the pacing-overview UI adds a per-row expand toggle.

**Tech Stack:** Node.js, Express, `pg` (Neon Postgres, optional — in-memory fallback when `DATABASE_URL` unset), Jest + supertest, vanilla-JS front end.

## Global Constraints

- **DB is optional.** Every store method MUST work with an in-memory fallback when `DATABASE_URL` is unset — mirror `src/services/dealer-goals-store.js` exactly. Tests run with no DB (`delete process.env.DATABASE_URL`).
- **Canonical dealer key** is the dealer's account name in original case (e.g. `Thayer Chevrolet`), matching `dealer_goals.dealer_name` and `results[].dealerName`. Never store the lowercased sheet-key form.
- **`period`** is always the first day of the month as the string `YYYY-MM-01`.
- **Capture is fire-and-forget:** it must never block, delay, or fail the request/job it rides on. Wrap in try/catch, log on error, swallow.
- Test framework: `npx jest <path>`. Unit tests live in `tests/unit/`, integration in `tests/integration/`, named `test_*.js`.
- Follow existing file conventions: block comment header, `module.exports` at bottom, `_resetForTesting()` on stores.

---

### Task 1: `dealer_monthly_spend` table + store module

**Files:**
- Modify: `src/services/database.js` (add table in `initialize()`, ~after line 169)
- Create: `src/services/dealer-spend-history-store.js`
- Test: `tests/unit/test_dealer_spend_history_store.js`

**Interfaces:**
- Consumes: `src/services/database.js` `getPool()`.
- Produces:
  - `monthPeriod(date = new Date()) → 'YYYY-MM-01'` (UTC month of `date`)
  - `recordSpend({ dealerName, period, totalSpend, monthlyBudget?, source? }) → Promise<void>` (upsert)
  - `recordManyForCurrentMonth(rows, source, now = new Date()) → Promise<void>` where each row is `{ dealerName, totalSpend?, mtdSpend?, monthlyBudget? }`
  - `getSpendHistory(dealerName) → Promise<Array<{ dealerName, period, totalSpend, monthlyBudget, source, updatedAt }>>` (newest period first)
  - `_resetForTesting() → void`

- [ ] **Step 1: Write the failing store tests**

Create `tests/unit/test_dealer_spend_history_store.js`:

```javascript
/**
 * Tests for dealer-spend-history-store.js — in-memory fallback (no DATABASE_URL).
 */

const store = require('../../src/services/dealer-spend-history-store');

beforeAll(() => { delete process.env.DATABASE_URL; });
beforeEach(() => { store._resetForTesting(); });

describe('monthPeriod()', () => {
  test('returns first-of-month YYYY-MM-01 in UTC', () => {
    expect(store.monthPeriod(new Date('2026-07-14T12:00:00Z'))).toBe('2026-07-01');
    expect(store.monthPeriod(new Date('2026-01-31T23:59:00Z'))).toBe('2026-01-01');
  });
});

describe('recordSpend() + getSpendHistory()', () => {
  test('records a single month for a dealer', async () => {
    await store.recordSpend({ dealerName: 'Thayer Chevrolet', period: '2026-07-01', totalSpend: 1217.93, monthlyBudget: 2000, source: 'pacing-overview' });
    const hist = await store.getSpendHistory('Thayer Chevrolet');
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ dealerName: 'Thayer Chevrolet', period: '2026-07-01', totalSpend: 1217.93, monthlyBudget: 2000, source: 'pacing-overview' });
    expect(hist[0].updatedAt).toBeTruthy();
  });

  test('same (dealer, period) upsert overwrites, does not duplicate', async () => {
    await store.recordSpend({ dealerName: 'Karl Flammer', period: '2026-07-01', totalSpend: 100 });
    await store.recordSpend({ dealerName: 'Karl Flammer', period: '2026-07-01', totalSpend: 22350.61, monthlyBudget: 50000 });
    const hist = await store.getSpendHistory('Karl Flammer');
    expect(hist).toHaveLength(1);
    expect(hist[0].totalSpend).toBe(22350.61);
    expect(hist[0].monthlyBudget).toBe(50000);
  });

  test('distinct periods accumulate separate rows, newest first', async () => {
    await store.recordSpend({ dealerName: 'Cogswell Motors', period: '2026-05-01', totalSpend: 15000 });
    await store.recordSpend({ dealerName: 'Cogswell Motors', period: '2026-07-01', totalSpend: 7808.32 });
    await store.recordSpend({ dealerName: 'Cogswell Motors', period: '2026-06-01', totalSpend: 16000 });
    const hist = await store.getSpendHistory('Cogswell Motors');
    expect(hist.map(h => h.period)).toEqual(['2026-07-01', '2026-06-01', '2026-05-01']);
  });

  test('normalizes YYYY-MM and full dates to first-of-month', async () => {
    await store.recordSpend({ dealerName: 'X', period: '2026-07', totalSpend: 1 });
    await store.recordSpend({ dealerName: 'X', period: '2026-07-31', totalSpend: 2 });
    const hist = await store.getSpendHistory('X');
    expect(hist).toHaveLength(1);
    expect(hist[0].period).toBe('2026-07-01');
    expect(hist[0].totalSpend).toBe(2);
  });

  test('coerces numeric strings to numbers, missing budget is null', async () => {
    await store.recordSpend({ dealerName: 'Y', period: '2026-07-01', totalSpend: '123.45' });
    const hist = await store.getSpendHistory('Y');
    expect(hist[0].totalSpend).toBe(123.45);
    expect(hist[0].monthlyBudget).toBeNull();
  });

  test('unknown dealer returns empty array', async () => {
    expect(await store.getSpendHistory('Nobody')).toEqual([]);
  });
});

describe('recordManyForCurrentMonth()', () => {
  test('records one row per dealer for the current month, accepting mtdSpend or totalSpend', async () => {
    const now = new Date('2026-07-14T10:00:00Z');
    await store.recordManyForCurrentMonth([
      { dealerName: 'A', mtdSpend: 100, monthlyBudget: 500 },
      { dealerName: 'B', totalSpend: 200 },
    ], 'pacing-overview', now);
    expect((await store.getSpendHistory('A'))[0]).toMatchObject({ period: '2026-07-01', totalSpend: 100, monthlyBudget: 500, source: 'pacing-overview' });
    expect((await store.getSpendHistory('B'))[0]).toMatchObject({ period: '2026-07-01', totalSpend: 200 });
  });

  test('a bad row does not abort the batch', async () => {
    const now = new Date('2026-07-14T10:00:00Z');
    await store.recordManyForCurrentMonth([
      { dealerName: null, mtdSpend: 1 },       // bad — no dealer name
      { dealerName: 'Good', mtdSpend: 50 },
    ], 'pacing-overview', now);
    expect((await store.getSpendHistory('Good'))[0].totalSpend).toBe(50);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/unit/test_dealer_spend_history_store.js`
Expected: FAIL — `Cannot find module '.../dealer-spend-history-store'`.

- [ ] **Step 3: Create the store module**

Create `src/services/dealer-spend-history-store.js`:

```javascript
/**
 * Dealer Spend History Store — DB-backed record of each dealer's total monthly spend.
 *
 * One row per (dealer_name, period), where period is the first day of a calendar
 * month. Written by the capture hooks (routes/pacing.js overview, services/spend-sync.js)
 * via latest-wins upsert: the current month's row is overwritten with the running MTD
 * total on every capture, and settles at the final figure once the month rolls over.
 *
 * Storage: PostgreSQL when DATABASE_URL is set, in-memory Map fallback otherwise.
 *
 * Read by: routes/dealers.js (GET /api/dealers/:dealerName/spend-history)
 */

const db = require('./database');

// ── In-memory fallback: key `${dealerName}::${period}` → record ──
const inMemory = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Period helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * First day of the UTC month for a given date, as 'YYYY-MM-01'.
 * @param {Date} [date]
 * @returns {string}
 */
function monthPeriod(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/**
 * Normalizes a period input ('YYYY-MM', 'YYYY-MM-DD', or Date) to 'YYYY-MM-01'.
 * @param {string|Date} period
 * @returns {string}
 */
function normalizePeriod(period) {
  if (period instanceof Date) return monthPeriod(period);
  const s = String(period);
  const m = s.match(/^(\d{4})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-01`;
  return monthPeriod(new Date(s));
}

function rowToRecord(row) {
  return {
    dealerName:    row.dealer_name,
    period:        row.period, // already 'YYYY-MM-01' via TO_CHAR in query
    totalSpend:    row.total_spend    !== null ? Number(row.total_spend)    : null,
    monthlyBudget: row.monthly_budget !== null ? Number(row.monthly_budget) : null,
    source:        row.source ?? null,
    updatedAt:     row.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upsert a dealer's spend for one month. Latest write wins.
 *
 * @param {object} p
 * @param {string} p.dealerName        Required, original-case account name
 * @param {string|Date} p.period       Any month-ish value; normalized to YYYY-MM-01
 * @param {number} p.totalSpend        Required
 * @param {number} [p.monthlyBudget]
 * @param {string} [p.source]
 * @returns {Promise<void>}
 */
async function recordSpend({ dealerName, period, totalSpend, monthlyBudget = null, source = null }) {
  if (!dealerName) throw new Error('recordSpend: dealerName is required');
  const p = normalizePeriod(period);
  const spend = Number(totalSpend);
  const budget = monthlyBudget == null ? null : Number(monthlyBudget);

  const pool = db.getPool();
  if (pool) {
    await pool.query(`
      INSERT INTO dealer_monthly_spend (dealer_name, period, total_spend, monthly_budget, source, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (dealer_name, period) DO UPDATE SET
        total_spend    = EXCLUDED.total_spend,
        monthly_budget = EXCLUDED.monthly_budget,
        source         = EXCLUDED.source,
        updated_at     = NOW()
    `, [dealerName, p, spend, budget, source]);
    return;
  }

  // In-memory fallback
  inMemory.set(`${dealerName}::${p}`, {
    dealerName,
    period: p,
    totalSpend: spend,
    monthlyBudget: budget,
    source: source ?? null,
    updatedAt: new Date(),
  });
}

/**
 * Upsert many dealers' spend for the current month. Never throws — logs and
 * continues so one bad row can't abort the batch or the caller.
 *
 * @param {Array<{dealerName:string, totalSpend?:number, mtdSpend?:number, monthlyBudget?:number}>} rows
 * @param {string} source
 * @param {Date} [now]
 * @returns {Promise<void>}
 */
async function recordManyForCurrentMonth(rows, source, now = new Date()) {
  const period = monthPeriod(now);
  for (const r of rows || []) {
    try {
      const totalSpend = r.totalSpend != null ? r.totalSpend : r.mtdSpend;
      await recordSpend({
        dealerName: r.dealerName,
        period,
        totalSpend,
        monthlyBudget: r.monthlyBudget != null ? r.monthlyBudget : null,
        source,
      });
    } catch (err) {
      console.error('[dealer-spend-history-store] recordSpend failed for', r && r.dealerName, '-', err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All recorded months for a dealer, newest period first.
 * @param {string} dealerName
 * @returns {Promise<Array<object>>}
 */
async function getSpendHistory(dealerName) {
  const pool = db.getPool();
  if (pool) {
    const res = await pool.query(`
      SELECT dealer_name,
             TO_CHAR(period, 'YYYY-MM-01') AS period,
             total_spend, monthly_budget, source, updated_at
        FROM dealer_monthly_spend
       WHERE dealer_name = $1
       ORDER BY period DESC
    `, [dealerName]);
    return res.rows.map(rowToRecord);
  }

  // In-memory fallback — newest first
  return Array.from(inMemory.values())
    .filter(r => r.dealerName === dealerName)
    .sort((a, b) => b.period.localeCompare(a.period))
    .map(r => ({ ...r }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Testing
// ─────────────────────────────────────────────────────────────────────────────

function _resetForTesting() {
  inMemory.clear();
}

module.exports = {
  monthPeriod,
  recordSpend,
  recordManyForCurrentMonth,
  getSpendHistory,
  _resetForTesting,
};
```

- [ ] **Step 4: Add the table to `database.js`**

In `src/services/database.js`, immediately after the `idx_dealer_budget_changes_dealer` block (after line 169, before `initialized = true;`), add:

```javascript
    try {
      await p.query(`
        CREATE TABLE IF NOT EXISTS dealer_monthly_spend (
          dealer_name    TEXT NOT NULL,
          period         DATE NOT NULL,
          total_spend    NUMERIC(12,2) NOT NULL,
          monthly_budget NUMERIC(10,2),
          source         TEXT,
          updated_at     TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (dealer_name, period)
        )
      `);
      await p.query(`
        CREATE INDEX IF NOT EXISTS idx_dealer_monthly_spend_dealer
          ON dealer_monthly_spend (dealer_name, period DESC)
      `);
    } catch (err) {
      console.error('Database initialization error (dealer_monthly_spend):', err.message);
    }
```

Also append `, dealer_monthly_spend` to the success `console.log` table list on line ~172.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest tests/unit/test_dealer_spend_history_store.js`
Expected: PASS (all tests green).

- [ ] **Step 6: Commit**

```bash
git add src/services/dealer-spend-history-store.js src/services/database.js tests/unit/test_dealer_spend_history_store.js
git commit -m "feat: dealer_monthly_spend table + spend history store"
```

---

### Task 2: Capture hooks (pacing overview + spend-sync)

**Files:**
- Modify: `src/routes/pacing.js` (in `GET /api/pacing/all`, just before `res.json({ accounts: results, ... })` ~line 634)
- Modify: `src/services/spend-sync.js` (collect original-case rows in `runSpendSync`, capture after the batch loop ~line 187)
- Test: `tests/unit/test_spend_history_capture.js`

**Interfaces:**
- Consumes: `dealer-spend-history-store.recordManyForCurrentMonth(rows, source, now?)` from Task 1.
- Produces: no new exports — behavioral hooks only. Capture rows shape: `{ dealerName, totalSpend, monthlyBudget }`.

- [ ] **Step 1: Write the failing capture test**

This test asserts the store is fed the right rows given a `results[]`-shaped array, using the store's own in-memory state as the observable outcome. Create `tests/unit/test_spend_history_capture.js`:

```javascript
/**
 * Verifies that the pacing-overview capture shape feeds the spend-history store
 * correctly (in-memory fallback, no DATABASE_URL).
 */

const store = require('../../src/services/dealer-spend-history-store');

beforeAll(() => { delete process.env.DATABASE_URL; });
beforeEach(() => { store._resetForTesting(); });

// Mirrors the mapping the pacing route performs on its `results` array.
function mapPacingResults(results) {
  return results.map(r => ({ dealerName: r.dealerName, totalSpend: r.mtdSpend, monthlyBudget: r.monthlyBudget }));
}

test('pacing results are captured one row per dealer for the current month', async () => {
  const now = new Date('2026-07-14T10:00:00Z');
  const results = [
    { dealerName: 'Thayer Chevrolet', mtdSpend: 1217.93, monthlyBudget: 2000 },
    { dealerName: 'Karl Flammer',     mtdSpend: 22350.61, monthlyBudget: 50000 },
  ];
  await store.recordManyForCurrentMonth(mapPacingResults(results), 'pacing-overview', now);

  const thayer = await store.getSpendHistory('Thayer Chevrolet');
  expect(thayer[0]).toMatchObject({ period: '2026-07-01', totalSpend: 1217.93, monthlyBudget: 2000, source: 'pacing-overview' });
  const karl = await store.getSpendHistory('Karl Flammer');
  expect(karl[0].totalSpend).toBe(22350.61);
});
```

- [ ] **Step 2: Run test to verify it passes for the mapping, then wire the routes**

Run: `npx jest tests/unit/test_spend_history_capture.js`
Expected: PASS (this validates the row shape against the Task 1 store; the route wiring below has no separate unit test because it is fire-and-forget glue over already-tested pieces — it is verified end-to-end in Task 4's manual check).

- [ ] **Step 3: Wire the pacing-overview capture**

In `src/routes/pacing.js`, inside `GET /api/pacing/all`, immediately before the final `res.json({ accounts: results, ... })` (~line 634), add:

```javascript
      // Persist each dealer's month-to-date total for historical comparison.
      // Fire-and-forget — must never delay or fail the overview response.
      try {
        const spendHistory = require('../services/dealer-spend-history-store');
        spendHistory.recordManyForCurrentMonth(
          results.map(r => ({ dealerName: r.dealerName, totalSpend: r.mtdSpend, monthlyBudget: r.monthlyBudget })),
          'pacing-overview'
        ).catch(err => console.error('[pacing] spend history capture failed:', err.message));
      } catch (err) {
        console.error('[pacing] spend history capture hook error:', err.message);
      }
```

- [ ] **Step 4: Wire the spend-sync capture (original-case names)**

In `src/services/spend-sync.js`, inside `runSpendSync`, add a collector alongside `spendByName`. Change the declaration (~line 154) from:

```javascript
    const spendByName = new Map();
```
to:
```javascript
    const spendByName = new Map();
    const spendRows = []; // original-case rows for spend-history capture
```

In the fulfilled-results loop (~lines 174-179), add the push:

```javascript
      for (const r of results) {
        if (r.status === 'fulfilled') {
          const key = r.value.name.trim().toLowerCase();
          spendByName.set(key, r.value.spend);
          spendRows.push({ dealerName: r.value.name, totalSpend: r.value.spend });
        }
      }
```

Then immediately after the batch loop finishes and before `writeSpendToSheet` (~after line 187, the `Fetched spend for...` log), add:

```javascript
    // Persist monthly spend history (fire-and-forget, non-fatal).
    try {
      const spendHistory = require('./dealer-spend-history-store');
      await spendHistory.recordManyForCurrentMonth(spendRows, 'spend-sync');
    } catch (err) {
      console.error('[spend-sync] spend history capture failed:', err.message);
    }
```

- [ ] **Step 5: Run the full suite to confirm nothing broke**

Run: `npx jest tests/unit/test_spend_history_capture.js tests/integration/test_pacing_overview_routes.js`
Expected: PASS (capture test green; existing pacing-overview route tests still green).

- [ ] **Step 6: Commit**

```bash
git add src/routes/pacing.js src/services/spend-sync.js tests/unit/test_spend_history_capture.js
git commit -m "feat: capture dealer monthly spend from pacing overview and spend-sync"
```

---

### Task 3: `GET /api/dealers/:dealerName/spend-history` route

**Files:**
- Modify: `src/routes/dealers.js` (add route after the existing `/history` route, ~line 238; update the header route-list comment ~line 12)
- Test: `tests/unit/test_dealers_route.js` (append a describe block)

**Interfaces:**
- Consumes: `dealer-spend-history-store.getSpendHistory(dealerName)` (Task 1) and `dealer-spend-history-store.recordSpend(...)` for seeding the test.
- Produces: HTTP `GET /api/dealers/:dealerName/spend-history` → `{ history: [{ dealerName, period, totalSpend, monthlyBudget, source, updatedAt }] }`, newest first.

- [ ] **Step 1: Write the failing route test**

Append to `tests/unit/test_dealers_route.js` (uses the existing `buildApp` / `authAgent` helpers already in that file). Add near the top of the file, after the existing `const store = require(...)` line:

```javascript
const spendHistoryStore = require('../../src/services/dealer-spend-history-store');
```

Then append this describe block at the end of the file:

```javascript
describe('GET /api/dealers/:dealerName/spend-history', () => {
  beforeEach(() => { spendHistoryStore._resetForTesting(); });

  test('returns recorded months newest first', async () => {
    await spendHistoryStore.recordSpend({ dealerName: 'Thayer Chevrolet', period: '2026-05-01', totalSpend: 1900, monthlyBudget: 2000, source: 'pacing-overview' });
    await spendHistoryStore.recordSpend({ dealerName: 'Thayer Chevrolet', period: '2026-06-01', totalSpend: 1850, monthlyBudget: 2000, source: 'pacing-overview' });

    const app = buildApp();
    const agent = await authAgent(app);
    const res = await agent.get(`/api/dealers/${encodeURIComponent('Thayer Chevrolet')}/spend-history`).expect(200);

    expect(res.body.history).toHaveLength(2);
    expect(res.body.history[0].period).toBe('2026-06-01');
    expect(res.body.history[0].totalSpend).toBe(1850);
    expect(res.body.history[1].period).toBe('2026-05-01');
  });

  test('returns empty history for a dealer with no records', async () => {
    const app = buildApp();
    const agent = await authAgent(app);
    const res = await agent.get(`/api/dealers/${encodeURIComponent('Nobody Motors')}/spend-history`).expect(200);
    expect(res.body.history).toEqual([]);
  });

  test('requires auth', async () => {
    const app = buildApp();
    await supertest(app).get('/api/dealers/Whoever/spend-history').expect(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/test_dealers_route.js -t "spend-history"`
Expected: FAIL — 404 (route not defined) instead of 200.

- [ ] **Step 3: Add the route**

In `src/routes/dealers.js`, add near the other store require (after line 19 `const store = require('../services/dealer-goals-store');`):

```javascript
const spendHistoryStore = require('../services/dealer-spend-history-store');
```

Then, immediately after the existing `GET /api/dealers/:dealerName/history` handler (after its closing `});` ~line 238), add:

```javascript
  // ── GET /api/dealers/:dealerName/spend-history ────────────────────────────────
  router.get('/api/dealers/:dealerName/spend-history', requireAuth, async (req, res, next) => {
    try {
      const dealerName = decodeURIComponent(req.params.dealerName);
      const history = await spendHistoryStore.getSpendHistory(dealerName);
      res.json({ history });
    } catch (err) {
      next(err);
    }
  });
```

Also add a line to the route-list comment at the top of the file (after line 12's `/history` entry):

```javascript
 *   GET    /api/dealers/:dealerName/spend-history → monthly spend history
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/test_dealers_route.js -t "spend-history"`
Expected: PASS (all three spend-history tests green).

- [ ] **Step 5: Commit**

```bash
git add src/routes/dealers.js tests/unit/test_dealers_route.js
git commit -m "feat: GET /api/dealers/:dealerName/spend-history route"
```

---

### Task 4: Pacing-overview row expand → month history

**Files:**
- Modify: `public/pacing-overview-app.js` (row template ~line 292-302; `renderTable` ~line 261; append expand handlers + `window.*` exposure ~line 423)
- Modify: `public/pacing-styles.css` (append expand/detail styles)

**Interfaces:**
- Consumes: `GET /api/dealers/:dealerName/spend-history` (Task 3); existing helpers in the file: `esc()`, `fmtCurrency()`.
- Produces: browser behavior only. New globals: `window.toggleSpendHistory`.

- [ ] **Step 1: Add a leading expand-toggle cell to each row**

In `public/pacing-overview-app.js`, in `renderTable`, prepend an empty header cell to `headerHtml` so column counts line up. Change the `content.innerHTML` table head from:

```javascript
      <thead><tr>${headerHtml}</tr></thead>
```
to:
```javascript
      <thead><tr><th class="expand-col"></th>${headerHtml}</tr></thead>
```

Then change the row template (line 292's opening `<tr ...>` through the first `<td>`). Replace:

```javascript
    return `<tr onclick="window.location.href='/pacing.html?account=${esc(a.customerId)}'">
      <td>${esc(a.dealerName)}</td>
```
with:
```javascript
    const dealerAttr = esc(a.dealerName).replace(/'/g, "\\'");
    return `<tr class="dealer-row" onclick="window.location.href='/pacing.html?account=${esc(a.customerId)}'">
      <td class="expand-col"><button class="expand-btn" title="Show monthly spend history" onclick="event.stopPropagation(); toggleSpendHistory('${dealerAttr}', this)">▸</button></td>
      <td>${esc(a.dealerName)}</td>
```

The `event.stopPropagation()` keeps the row's navigate-on-click intact — clicking the caret expands, clicking anywhere else still opens `/pacing.html`.

- [ ] **Step 2: Add the toggle + fetch + render handlers**

At the end of `public/pacing-overview-app.js` (before or alongside the `window.*` exposures ~line 423), add:

```javascript
// ── Monthly spend history (row expand) ──

const spendHistoryCache = new Map(); // dealerName → array | 'loading'

function formatMonthLabel(period) {
  // period is 'YYYY-MM-01'
  const [y, m] = period.split('-');
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${names[Number(m) - 1]} ${y}`;
}

function formatUpdated(updatedAt) {
  if (!updatedAt) return '';
  const d = new Date(updatedAt);
  if (isNaN(d)) return '';
  return `updated ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

function renderSpendHistoryRows(history) {
  if (history === 'loading') return '<div class="sh-empty">Loading…</div>';
  if (!history || history.length === 0) {
    return '<div class="sh-empty">No months recorded yet — history starts this month.</div>';
  }
  return '<div class="sh-list">' + history.map(h => {
    const pct = (h.monthlyBudget && h.monthlyBudget > 0)
      ? ` · ${Math.round((h.totalSpend / h.monthlyBudget) * 100)}%`
      : '';
    const budget = (h.monthlyBudget != null) ? ` / ${fmtCurrency(h.monthlyBudget)}` : '';
    return `<div class="sh-entry">
      <span class="sh-month">${esc(formatMonthLabel(h.period))}</span>
      <span class="sh-sep">·</span>
      <span class="sh-spend">${fmtCurrency(h.totalSpend)} spent${budget}${pct}</span>
      <span class="sh-updated">${esc(formatUpdated(h.updatedAt))}</span>
    </div>`;
  }).join('') + '</div>';
}

async function toggleSpendHistory(dealerName, btn) {
  const dealerRow = btn.closest('tr');
  const existing = dealerRow.nextElementSibling;
  // Collapse if already open
  if (existing && existing.classList.contains('sh-detail-row')) {
    existing.remove();
    btn.textContent = '▸';
    btn.classList.remove('open');
    return;
  }

  btn.textContent = '▾';
  btn.classList.add('open');

  const detail = document.createElement('tr');
  detail.className = 'sh-detail-row';
  const colspan = dealerRow.children.length;
  const cached = spendHistoryCache.get(dealerName);
  detail.innerHTML = `<td colspan="${colspan}"><div class="sh-panel">${renderSpendHistoryRows(cached || 'loading')}</div></td>`;
  dealerRow.after(detail);

  if (cached && cached !== 'loading') return; // already have data

  spendHistoryCache.set(dealerName, 'loading');
  try {
    const res = await fetch(`/api/dealers/${encodeURIComponent(dealerName)}/spend-history`, { credentials: 'include' });
    const data = res.ok ? await res.json() : { history: [] };
    spendHistoryCache.set(dealerName, data.history || []);
  } catch (err) {
    spendHistoryCache.set(dealerName, []);
  }
  // Re-render if the panel is still open
  const panel = detail.querySelector('.sh-panel');
  if (panel) panel.innerHTML = renderSpendHistoryRows(spendHistoryCache.get(dealerName));
}

window.toggleSpendHistory = toggleSpendHistory;
```

- [ ] **Step 3: Add styles**

Append to `public/pacing-styles.css`:

```css
/* ── Monthly spend history (pacing-overview row expand) ── */
.overview-table th.expand-col,
.overview-table td.expand-col { width: 28px; text-align: center; padding-left: 4px; padding-right: 0; }
.expand-btn {
  background: none; border: none; cursor: pointer; color: var(--text3);
  font-size: 12px; line-height: 1; padding: 2px 4px;
}
.expand-btn:hover { color: var(--text1); }
.expand-btn.open { color: var(--accent, #3b82f6); }
.sh-detail-row > td { background: var(--bg2, rgba(255,255,255,0.02)); padding: 0; }
.sh-panel { padding: 10px 16px 12px 40px; }
.sh-list { display: flex; flex-direction: column; gap: 6px; }
.sh-entry { display: flex; align-items: baseline; gap: 8px; font-size: 13px; }
.sh-month { min-width: 72px; color: var(--text2); font-variant-numeric: tabular-nums; }
.sh-sep { color: var(--text3); }
.sh-spend { color: var(--text1); font-variant-numeric: tabular-nums; }
.sh-updated { color: var(--text3); font-size: 11px; margin-left: auto; }
.sh-empty { font-size: 13px; color: var(--text3); padding: 2px 0; }
```

- [ ] **Step 4: Manual verification in the browser**

The front end is not covered by Jest; verify by driving the app.

1. Start the server: `npm start` (needs `.env` with Google OAuth + `DATABASE_URL`; use the dev env if configured).
2. Open the pacing overview page, sign in, click **Refresh** to load accounts.
3. Confirm each dealer row now shows a `▸` caret in the new first column.
4. Click a caret → row expands into a detail panel showing month rows (or "No months recorded yet — history starts this month." on first ever load, since capture only just began). The caret flips to `▾`.
5. Click the caret again → panel collapses, caret returns to `▸`.
6. Click the dealer name / rest of the row → still navigates to `/pacing.html?account=…` (expand did not break navigation).
7. Reload the overview once (this triggers a capture), wait for it to finish, then re-expand a dealer → the current month now appears, e.g. `Jul 2026 · $1,217.93 spent / $2,000.00 · 61%   updated Jul 14`.

Expected: all seven checks pass. If the panel is empty even after a second load, check the server logs for `[pacing] spend history capture failed`.

- [ ] **Step 5: Commit**

```bash
git add public/pacing-overview-app.js public/pacing-styles.css
git commit -m "feat: expand pacing-overview row to show monthly spend history"
```

---

## Self-Review Notes

- **Spec coverage:** Capture strategy (Task 2) ✓; `dealer_monthly_spend` table + store (Task 1) ✓; API (Task 3) ✓; row-expand UI with `stopPropagation` and `updated_at` staleness (Task 4) ✓; budget snapshot (Task 1 schema + capture rows) ✓; no-backfill limitation surfaced as the empty-state string (Task 4) ✓. Out-of-scope items (comparison grid, CSV, "last month" column) intentionally absent.
- **Canonical key:** every capture path (pacing `results[].dealerName`, spend-sync `r.value.name`) uses original-case names — no lowercased sheet-keys reach the store.
- **Type consistency:** `recordSpend` / `recordManyForCurrentMonth` / `getSpendHistory` / `monthPeriod` / `_resetForTesting` signatures are identical across Tasks 1–3; `period` is `YYYY-MM-01` everywhere; record shape `{ dealerName, period, totalSpend, monthlyBudget, source, updatedAt }` is consistent from store → route → UI.
```
