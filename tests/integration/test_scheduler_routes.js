/**
 * Integration tests for scheduler routes.
 *
 * Tier 3 (integration): uses supertest against the Express app.
 */

const request = require('supertest');
const { createTestApp, authenticatedAgent } = require('./test-helpers');
const scheduler = require('../../src/services/scheduler');

const app = createTestApp();

afterEach(() => {
  scheduler.clearAll();
});

describe('GET /api/scheduler/status', () => {
  test('returns 401 without authentication', async () => {
    await request(app).get('/api/scheduler/status').expect(401);
  });

  test('returns empty jobs array when no jobs registered', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/scheduler/status').expect(200);
    expect(res.body.jobs).toEqual([]);
  });

  test('returns registered jobs with status', async () => {
    scheduler.registerJob('daily-audit', async () => {}, 86400000);
    scheduler.registerJob('weekly-offers', async () => {}, 604800000);

    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/scheduler/status').expect(200);
    expect(res.body.jobs).toHaveLength(2);

    const names = res.body.jobs.map(j => j.name);
    expect(names).toContain('daily-audit');
    expect(names).toContain('weekly-offers');

    const audit = res.body.jobs.find(j => j.name === 'daily-audit');
    expect(audit.intervalMs).toBe(86400000);
    expect(audit.running).toBe(false);
    expect(audit.runCount).toBe(0);
  });
});
