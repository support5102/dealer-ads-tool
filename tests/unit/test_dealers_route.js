/**
 * Unit tests for dealers router — uses supertest with a minimal Express app.
 *
 * No DATABASE_URL is set; dealer-goals-store runs in-memory fallback.
 * Session is stubbed via a test-only endpoint that sets req.session.tokens
 * and req.session.userEmail.
 */

const express = require('express');
const session = require('express-session');
const supertest = require('supertest');

// Ensure no DB connection leaks in from environment
beforeAll(() => {
  delete process.env.DATABASE_URL;
});

const store = require('../../src/services/dealer-goals-store');
const { createDealersRouter } = require('../../src/routes/dealers');

// ── Build a minimal test app ──────────────────────────────────────────────────

function buildApp(opts = {}) {
  const app = express();
  app.use(express.json());
  app.use(session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false,
  }));

  // Stub session injection endpoint
  app.get('/__test__/set-session', (req, res) => {
    req.session.tokens = { access_token: 'fake', refresh_token: 'fake' };
    req.session.userEmail = req.query.email || 'test@example.com';
    res.json({ ok: true });
  });

  // Build config. Sheet ID is read from process.env by the import route
  // (matches auth.js + budget-adjustments.js pattern), so set/unset the env
  // var here instead of nesting it in the config.
  if (opts.noSpreadsheet) delete process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  else process.env.GOOGLE_SHEETS_SPREADSHEET_ID = 'fake-sheet-id';

  const config = { googleAds: { clientId: 'x', clientSecret: 'x', developerToken: 'x' } };

  app.use(createDealersRouter(config));
  return app;
}

async function authAgent(app, email = 'test@example.com') {
  const agent = supertest.agent(app);
  await agent.get(`/__test__/set-session?email=${encodeURIComponent(email)}`).expect(200);
  return agent;
}

// ── Reset store before each test ──────────────────────────────────────────────

beforeEach(() => {
  store._resetForTesting();
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/dealers', () => {
  test('returns empty array when no dealers exist', async () => {
    const app = buildApp();
    const agent = await authAgent(app);
    const res = await agent.get('/api/dealers').expect(200);
    expect(res.body).toHaveProperty('dealers');
    expect(res.body.dealers).toEqual([]);
  });

  test('returns array of dealers', async () => {
    const app = buildApp();
    await store.upsertGoal({ dealerName: 'Test Dealer', monthlyBudget: 5000 });
    const agent = await authAgent(app);
    const res = await agent.get('/api/dealers').expect(200);
    expect(res.body.dealers).toHaveLength(1);
    expect(res.body.dealers[0].dealerName).toBe('Test Dealer');
  });

  test('returns 401 when not authenticated', async () => {
    const app = buildApp();
    await supertest(app).get('/api/dealers').expect(401);
  });
});

describe('POST /api/dealers', () => {
  test('creates a dealer and returns 201', async () => {
    const app = buildApp();
    const agent = await authAgent(app);
    const res = await agent
      .post('/api/dealers')
      .send({ dealerName: 'New Dealer', monthlyBudget: 8000 })
      .expect(201);
    expect(res.body.dealer.dealerName).toBe('New Dealer');
    expect(res.body.dealer.monthlyBudget).toBe(8000);
  });

  test('created dealer is visible in GET /api/dealers', async () => {
    const app = buildApp();
    const agent = await authAgent(app);
    await agent.post('/api/dealers').send({ dealerName: 'My Dealer', monthlyBudget: 3000 }).expect(201);
    const res = await agent.get('/api/dealers').expect(200);
    expect(res.body.dealers.some(d => d.dealerName === 'My Dealer')).toBe(true);
  });

  test('writing "Dealer added" audit entry happens via store (upsertGoal)', async () => {
    const app = buildApp();
    const agent = await authAgent(app);
    await agent.post('/api/dealers').send({ dealerName: 'Audit Dealer', monthlyBudget: 1000 }).expect(201);
    const history = await store.getBudgetHistory('Audit Dealer');
    expect(history).toHaveLength(1);
    expect(history[0].note).toBe('Dealer added');
  });

  test('returns 400 when dealerName is missing', async () => {
    const app = buildApp();
    const agent = await authAgent(app);
    const res = await agent.post('/api/dealers').send({ monthlyBudget: 5000 }).expect(400);
    expect(res.body.error).toMatch(/dealerName/);
  });

  test('returns 400 when monthlyBudget is missing', async () => {
    const app = buildApp();
    const agent = await authAgent(app);
    const res = await agent.post('/api/dealers').send({ dealerName: 'No Budget' }).expect(400);
    expect(res.body.error).toMatch(/monthlyBudget/);
  });
});

describe('PATCH /api/dealers/:dealerName', () => {
  test('updates non-budget fields', async () => {
    const app = buildApp();
    await store.upsertGoal({ dealerName: 'Patch Dealer', monthlyBudget: 5000 });
    const agent = await authAgent(app);
    const res = await agent
      .patch('/api/dealers/Patch%20Dealer')
      .send({ pacingMode: 'auto_apply', miscNotes: 'test notes' })
      .expect(200);
    expect(res.body.dealer.pacingMode).toBe('auto_apply');
    expect(res.body.dealer.miscNotes).toBe('test notes');
  });

  test('PATCH does NOT write an additional audit entry', async () => {
    const app = buildApp();
    await store.upsertGoal({ dealerName: 'Patch Dealer', monthlyBudget: 5000 });
    // Clear history: only "Dealer added" exists
    const agent = await authAgent(app);
    await agent.patch('/api/dealers/Patch%20Dealer').send({ pacingMode: 'advisory' }).expect(200);

    const history = await store.getBudgetHistory('Patch Dealer');
    // Still only the original "Dealer added" entry — no new audit entry
    expect(history).toHaveLength(1);
    expect(history[0].note).toBe('Dealer added');
  });

  test('PATCH preserves monthlyBudget', async () => {
    const app = buildApp();
    await store.upsertGoal({ dealerName: 'Patch Dealer', monthlyBudget: 5000 });
    const agent = await authAgent(app);
    const res = await agent
      .patch('/api/dealers/Patch%20Dealer')
      .send({ miscNotes: 'update' })
      .expect(200);
    expect(res.body.dealer.monthlyBudget).toBe(5000);
  });

  test('returns 404 when dealer not found', async () => {
    const app = buildApp();
    const agent = await authAgent(app);
    await agent.patch('/api/dealers/Nobody').send({ pacingMode: 'advisory' }).expect(404);
  });
});

describe('PUT /api/dealers/:dealerName/budget', () => {
  test('updates monthly budget with valid note', async () => {
    const app = buildApp();
    await store.upsertGoal({ dealerName: 'Budget Dealer', monthlyBudget: 5000 });
    const agent = await authAgent(app, 'editor@savvy.com');
    const res = await agent
      .put('/api/dealers/Budget%20Dealer/budget')
      .send({ monthlyBudget: 8000, note: 'Q2 budget increase' })
      .expect(200);
    expect(res.body.updated).toBe(true);
  });

  test('budget change is reflected in history', async () => {
    const app = buildApp();
    await store.upsertGoal({ dealerName: 'Budget Dealer', monthlyBudget: 5000 });
    const agent = await authAgent(app, 'editor@savvy.com');
    await agent
      .put('/api/dealers/Budget%20Dealer/budget')
      .send({ monthlyBudget: 9000, note: 'Annual increase' })
      .expect(200);

    const history = await store.getBudgetHistory('Budget Dealer');
    const change = history.find(h => h.note === 'Annual increase');
    expect(change).toBeDefined();
    expect(change.newBudget).toBe(9000);
    expect(change.changedBy).toBe('editor@savvy.com');
  });

  test('returns 400 when note is missing', async () => {
    const app = buildApp();
    await store.upsertGoal({ dealerName: 'Budget Dealer', monthlyBudget: 5000 });
    const agent = await authAgent(app);
    const res = await agent
      .put('/api/dealers/Budget%20Dealer/budget')
      .send({ monthlyBudget: 6000 })
      .expect(400);
    expect(res.body.error).toMatch(/note/i);
  });

  test('returns 400 when note is 3 characters (too short)', async () => {
    const app = buildApp();
    await store.upsertGoal({ dealerName: 'Budget Dealer', monthlyBudget: 5000 });
    const agent = await authAgent(app);
    const res = await agent
      .put('/api/dealers/Budget%20Dealer/budget')
      .send({ monthlyBudget: 6000, note: 'abc' })
      .expect(400);
    expect(res.body.error).toMatch(/5 char/i);
  });

  test('returns 400 when note is 4 characters (still too short)', async () => {
    const app = buildApp();
    await store.upsertGoal({ dealerName: 'Budget Dealer', monthlyBudget: 5000 });
    const agent = await authAgent(app);
    const res = await agent
      .put('/api/dealers/Budget%20Dealer/budget')
      .send({ monthlyBudget: 6000, note: 'abcd' })
      .expect(400);
    expect(res.body.error).toMatch(/5 char/i);
  });

  test('returns 400 when monthlyBudget is negative', async () => {
    const app = buildApp();
    await store.upsertGoal({ dealerName: 'Budget Dealer', monthlyBudget: 5000 });
    const agent = await authAgent(app);
    const res = await agent
      .put('/api/dealers/Budget%20Dealer/budget')
      .send({ monthlyBudget: -100, note: 'Valid note here' })
      .expect(400);
    expect(res.body.error).toMatch(/positive/i);
  });

  test('returns 400 when monthlyBudget is non-numeric string', async () => {
    const app = buildApp();
    await store.upsertGoal({ dealerName: 'Budget Dealer', monthlyBudget: 5000 });
    const agent = await authAgent(app);
    const res = await agent
      .put('/api/dealers/Budget%20Dealer/budget')
      .send({ monthlyBudget: 'not-a-number', note: 'Valid note here' })
      .expect(400);
    expect(res.body.error).toMatch(/positive/i);
  });

  test('returns 404 when dealer does not exist', async () => {
    const app = buildApp();
    const agent = await authAgent(app);
    await agent
      .put('/api/dealers/Nonexistent/budget')
      .send({ monthlyBudget: 5000, note: 'Valid note here' })
      .expect(404);
  });
});

describe('DELETE /api/dealers/:dealerName', () => {
  test('removes a dealer and returns deleted: true', async () => {
    const app = buildApp();
    await store.upsertGoal({ dealerName: 'To Delete', monthlyBudget: 1000 });
    const agent = await authAgent(app);
    const res = await agent.delete('/api/dealers/To%20Delete').expect(200);
    expect(res.body.deleted).toBe(true);
  });

  test('dealer no longer appears in GET after delete', async () => {
    const app = buildApp();
    await store.upsertGoal({ dealerName: 'To Delete', monthlyBudget: 1000 });
    const agent = await authAgent(app);
    await agent.delete('/api/dealers/To%20Delete').expect(200);
    const res = await agent.get('/api/dealers').expect(200);
    expect(res.body.dealers.some(d => d.dealerName === 'To Delete')).toBe(false);
  });

  test('returns 404 when dealer does not exist', async () => {
    const app = buildApp();
    const agent = await authAgent(app);
    await agent.delete('/api/dealers/Ghost%20Dealer').expect(404);
  });
});

describe('GET /api/dealers/:dealerName/history', () => {
  test('returns empty array for dealer with no manual budget changes', async () => {
    const app = buildApp();
    await store.upsertGoal({ dealerName: 'Hist Dealer', monthlyBudget: 5000 });
    const agent = await authAgent(app);
    const res = await agent.get('/api/dealers/Hist%20Dealer/history').expect(200);
    // "Dealer added" is written on creation
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0].note).toBe('Dealer added');
  });

  test('returns changes in newest-first order', async () => {
    const app = buildApp();
    await store.upsertGoal({ dealerName: 'Hist Dealer', monthlyBudget: 5000 });
    await store.updateMonthlyBudget('Hist Dealer', 6000, 'First raise', 'admin');
    await store.updateMonthlyBudget('Hist Dealer', 7000, 'Second raise', 'admin');

    const agent = await authAgent(app);
    const res = await agent.get('/api/dealers/Hist%20Dealer/history').expect(200);
    expect(res.body.history).toHaveLength(3); // Dealer added + 2 changes
    expect(res.body.history[0].newBudget).toBe(7000);
    expect(res.body.history[1].newBudget).toBe(6000);
  });

  test('returns empty history for unknown dealer (no error)', async () => {
    const app = buildApp();
    const agent = await authAgent(app);
    const res = await agent.get('/api/dealers/Nobody/history').expect(200);
    expect(res.body.history).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/dealers/import-from-sheet
// ─────────────────────────────────────────────────────────────────────────────

// ── Helpers: mock googleAds + readGoalsFromSheet for import tests ─────────────

const goalReaderModule = require('../../src/services/goal-reader');
const googleAdsModule  = require('../../src/services/google-ads');

function makeSheetGoals(overrides = []) {
  const defaults = [
    {
      dealerName: 'Alpha Motors',
      monthlyBudget: 10000,
      newBudget: 6000,
      usedBudget: 4000,
      dealerNotes: 'test note',
      pacingMode: 'one_click',
      pacingCurveId: null,
    },
    {
      dealerName: 'Beta Auto',
      monthlyBudget: 8000,
      newBudget: null,
      usedBudget: null,
      dealerNotes: null,
      pacingMode: 'advisory',
      pacingCurveId: 'linear',
    },
  ];
  return overrides.length ? overrides : defaults;
}

describe('POST /api/dealers/import-from-sheet', () => {
  let origRefreshAccessToken;
  let origReadGoalsFromSheet;

  beforeEach(() => {
    store._resetForTesting();
    // Stub out the OAuth token refresh — no real network call needed
    origRefreshAccessToken = googleAdsModule.refreshAccessToken;
    googleAdsModule.refreshAccessToken = async () => 'test-access-token';

    // Stub out readGoalsFromSheet — return controlled data
    origReadGoalsFromSheet = goalReaderModule.readGoalsFromSheet;
  });

  afterEach(() => {
    googleAdsModule.refreshAccessToken = origRefreshAccessToken;
    goalReaderModule.readGoalsFromSheet = origReadGoalsFromSheet;
  });

  test('happy path: 2 goals from sheet, DB empty → both created', async () => {
    goalReaderModule.readGoalsFromSheet = async () => makeSheetGoals();

    const app = buildApp();
    const agent = await authAgent(app);
    const res = await agent.post('/api/dealers/import-from-sheet').expect(200);

    expect(res.body.imported).toBe(2);
    expect(res.body.created).toEqual(['Alpha Motors', 'Beta Auto']);
    expect(res.body.updated).toEqual([]);
    expect(res.body.skipped).toEqual([]);
  });

  test('idempotent: running twice → first all created, second all skipped', async () => {
    goalReaderModule.readGoalsFromSheet = async () => makeSheetGoals();

    const app = buildApp();
    const agent = await authAgent(app);

    const first = await agent.post('/api/dealers/import-from-sheet').expect(200);
    expect(first.body.created).toHaveLength(2);
    expect(first.body.skipped).toHaveLength(0);

    const second = await agent.post('/api/dealers/import-from-sheet').expect(200);
    expect(second.body.imported).toBe(0);
    expect(second.body.created).toHaveLength(0);
    expect(second.body.updated).toHaveLength(0);
    expect(second.body.skipped).toHaveLength(2);
    expect(second.body.skipped[0].reason).toBe('no changes');
  });

  test('partial change: one dealer budget changed → updated:1, other skipped', async () => {
    // Seed DB with the original data
    goalReaderModule.readGoalsFromSheet = async () => makeSheetGoals();
    const app = buildApp();
    const agent = await authAgent(app);
    await agent.post('/api/dealers/import-from-sheet').expect(200);

    // Now sheet has Alpha Motors with a different budget
    const updatedSheet = makeSheetGoals().map(g =>
      g.dealerName === 'Alpha Motors' ? { ...g, monthlyBudget: 12000 } : g
    );
    goalReaderModule.readGoalsFromSheet = async () => updatedSheet;

    const res = await agent.post('/api/dealers/import-from-sheet').expect(200);
    expect(res.body.updated).toEqual(['Alpha Motors']);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].name).toBe('Beta Auto');
    expect(res.body.imported).toBe(1);
  });

  test('missing spreadsheet ID → 500 with clear error', async () => {
    goalReaderModule.readGoalsFromSheet = async () => makeSheetGoals();

    const app = buildApp({ noSpreadsheet: true });
    const agent = await authAgent(app);
    const res = await agent.post('/api/dealers/import-from-sheet').expect(500);
    expect(res.body.error).toMatch(/GOOGLE_SHEETS_SPREADSHEET_ID/i);
  });

  test('sheet fetch throws → 500 response with error message', async () => {
    goalReaderModule.readGoalsFromSheet = async () => {
      throw new Error('Sheets API quota exceeded');
    };

    const app = buildApp();
    const agent = await authAgent(app);
    const res = await agent.post('/api/dealers/import-from-sheet').expect(500);
    expect(res.body.error).toMatch(/Sheets API quota exceeded/);
  });

  test('returns 401 when not authenticated', async () => {
    const app = buildApp();
    await supertest(app).post('/api/dealers/import-from-sheet').expect(401);
  });
});
