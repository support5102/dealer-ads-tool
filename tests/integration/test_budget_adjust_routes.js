/**
 * Integration tests for /api/dealers/:dealerName/budget-adjust
 * and /api/dealers/:dealerName/pending-revert.
 *
 * Uses the in-memory fallback path of dealer-goals-store (no DATABASE_URL).
 */

const { createTestApp, authenticatedAgent } = require('./test-helpers');
const store = require('../../src/services/dealer-goals-store');

beforeAll(() => {
  delete process.env.DATABASE_URL;
});

beforeEach(() => {
  store._resetForTesting();
});

describe('POST /api/dealers/:dealerName/budget-adjust', () => {
  test('rest_of_month +$30: returns new total + pending revert id', async () => {
    await store.upsertGoal({ dealerName: 'Test Dealer', monthlyBudget: 3000 });

    const app = createTestApp();
    const agent = await authenticatedAgent(app);

    const res = await agent
      .post(`/api/dealers/${encodeURIComponent('Test Dealer')}/budget-adjust`)
      .send({
        amount: 30, scope: 'rest_of_month', note: 'May only push',
      });

    expect(res.status).toBe(200);
    expect(res.body.newMonthlyBudget).toBe(3030);
    expect(res.body.pendingRevertId).not.toBeNull();
  });

  test('day scope without daySubScope returns 400', async () => {
    await store.upsertGoal({ dealerName: 'Test Dealer', monthlyBudget: 3000 });
    const app = createTestApp();
    const agent = await authenticatedAgent(app);

    const res = await agent
      .post(`/api/dealers/${encodeURIComponent('Test Dealer')}/budget-adjust`)
      .send({ amount: 30, scope: 'day', note: 'forgot subscope' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/daySubScope/);
  });

  test('note too short returns 400', async () => {
    await store.upsertGoal({ dealerName: 'Test Dealer', monthlyBudget: 3000 });
    const app = createTestApp();
    const agent = await authenticatedAgent(app);

    const res = await agent
      .post(`/api/dealers/${encodeURIComponent('Test Dealer')}/budget-adjust`)
      .send({ amount: 30, scope: 'month', note: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 5 characters/);
  });

  test('amount = 0 returns 400', async () => {
    await store.upsertGoal({ dealerName: 'Test Dealer', monthlyBudget: 3000 });
    const app = createTestApp();
    const agent = await authenticatedAgent(app);

    const res = await agent
      .post(`/api/dealers/${encodeURIComponent('Test Dealer')}/budget-adjust`)
      .send({ amount: 0, scope: 'month', note: 'zero amount' });

    expect(res.status).toBe(400);
  });

  test('unknown dealer returns 404', async () => {
    const app = createTestApp();
    const agent = await authenticatedAgent(app);

    const res = await agent
      .post(`/api/dealers/${encodeURIComponent('Nope')}/budget-adjust`)
      .send({ amount: 30, scope: 'month', note: 'valid note' });

    expect(res.status).toBe(404);
  });
});

describe('GET /api/dealers/:dealerName/pending-revert', () => {
  test('returns null when no pending revert', async () => {
    await store.upsertGoal({ dealerName: 'Test Dealer', monthlyBudget: 3000 });
    const app = createTestApp();
    const agent = await authenticatedAgent(app);

    const res = await agent.get(`/api/dealers/${encodeURIComponent('Test Dealer')}/pending-revert`);
    expect(res.status).toBe(200);
    expect(res.body.pendingRevert).toBeNull();
  });

  test('returns the pending revert when one exists', async () => {
    await store.upsertGoal({ dealerName: 'Test Dealer', monthlyBudget: 3000 });
    await store.applyBudgetAdjust({
      dealerName: 'Test Dealer', scope: 'rest_of_month', amount: 30,
      note: 'May only', today: new Date(Date.UTC(2026, 4, 15)),
    });

    const app = createTestApp();
    const agent = await authenticatedAgent(app);

    const res = await agent.get(`/api/dealers/${encodeURIComponent('Test Dealer')}/pending-revert`);
    expect(res.status).toBe(200);
    expect(res.body.pendingRevert).not.toBeNull();
    expect(res.body.pendingRevert.bumpAmount).toBe(30);
  });
});

describe('GET /api/config/features', () => {
  test('default config (flag unset) → budgetAdjustByAmountEnabled is false', async () => {
    const app = createTestApp();
    const agent = await authenticatedAgent(app);

    const res = await agent.get('/api/config/features');
    expect(res.status).toBe(200);
    expect(res.body.budgetAdjustByAmountEnabled).toBe(false);
  });

  test('flag set to true in config → budgetAdjustByAmountEnabled is true', async () => {
    const app = createTestApp({ budgetAdjustByAmountEnabled: true });
    const agent = await authenticatedAgent(app);

    const res = await agent.get('/api/config/features');
    expect(res.status).toBe(200);
    expect(res.body.budgetAdjustByAmountEnabled).toBe(true);
  });

  test('returns 401 when not authenticated', async () => {
    const app = createTestApp();
    const supertest = require('supertest');
    const res = await supertest(app).get('/api/config/features');
    expect(res.status).toBe(401);
  });
});
