/**
 * Tier 3 Change Route Tests — validates task parsing and change application.
 *
 * Tests: src/routes/changes.js
 * Mocks: services/claude-parser.js, services/change-executor.js, services/google-ads.js
 */

const supertest = require('supertest');
const claudeParser = require('../../src/services/claude-parser');
const changeExecutor = require('../../src/services/change-executor');
const googleAds = require('../../src/services/google-ads');
const { createTestApp, authenticatedAgent } = require('./test-helpers');

jest.mock('../../src/services/claude-parser');
jest.mock('../../src/services/change-executor');
jest.mock('../../src/services/google-ads');

// ---------------------------------------------------------------------------
// POST /api/parse-task
// ---------------------------------------------------------------------------
describe('POST /api/parse-task', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
  });

  test('returns 401 when not authenticated', async () => {
    await supertest(app)
      .post('/api/parse-task')
      .send({ task: 'pause Honda campaign' })
      .expect(401);
  });

  test('returns 400 when no task provided', async () => {
    const agent = await authenticatedAgent(app);

    const res = await agent
      .post('/api/parse-task')
      .send({})
      .expect(400);

    expect(res.body.error).toMatch(/no task/i);
  });

  test('returns 400 when task is empty string', async () => {
    const agent = await authenticatedAgent(app);

    const res = await agent
      .post('/api/parse-task')
      .send({ task: '' })
      .expect(400);

    expect(res.body.error).toMatch(/no task/i);
  });

  test('returns 400 when task is whitespace only', async () => {
    const agent = await authenticatedAgent(app);

    const res = await agent
      .post('/api/parse-task')
      .send({ task: '   ' })
      .expect(400);

    expect(res.body.error).toMatch(/no task/i);
  });

  test('calls Claude parser with task and returns change plan', async () => {
    const fakePlan = {
      summary: 'Pause Honda campaign',
      changes: [{ type: 'pause_campaign', campaignName: 'Honda Civic - Search' }],
      warnings: [],
      affectedCampaigns: ['Honda Civic - Search'],
    };
    claudeParser.parseTask.mockResolvedValue(fakePlan);

    const agent = await authenticatedAgent(app);
    const res = await agent
      .post('/api/parse-task')
      .send({
        task: 'pause Honda campaign',
        accountStructure: { campaigns: [] },
        accountName: 'Test Dealer',
      })
      .expect(200);

    expect(res.body.summary).toBe('Pause Honda campaign');
    expect(res.body.changes).toHaveLength(1);
    expect(res.body.changes[0].type).toBe('pause_campaign');
  });

  test('passes config, task, structure, and accountName to parser', async () => {
    claudeParser.parseTask.mockResolvedValue({ summary: '', changes: [] });

    const agent = await authenticatedAgent(app);
    await agent
      .post('/api/parse-task')
      .send({
        task: 'add negative keyword',
        accountStructure: { campaigns: [{ name: 'Test' }] },
        accountName: 'Honda Dealer',
      });

    expect(claudeParser.parseTask).toHaveBeenCalledWith(
      expect.any(Object),          // config.claude
      'add negative keyword',       // task
      { campaigns: [{ name: 'Test' }] },  // structure
      'Honda Dealer'                // accountName
    );
  });

  test('passes error to error handler when Claude fails', async () => {
    claudeParser.parseTask.mockRejectedValue(new Error('Claude API timeout'));

    const agent = await authenticatedAgent(app);
    const res = await agent
      .post('/api/parse-task')
      .send({ task: 'pause everything' })
      .expect(500);

    expect(res.body.error).toMatch(/internal server error/i);
  });
});

// ---------------------------------------------------------------------------
// POST /api/apply-changes
// ---------------------------------------------------------------------------
describe('POST /api/apply-changes', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
    googleAds.createClient.mockReturnValue({});
  });

  test('returns 401 when not authenticated', async () => {
    await supertest(app)
      .post('/api/apply-changes')
      .send({ changes: [], customerId: '123' })
      .expect(401);
  });

  test('returns 400 when missing changes', async () => {
    const agent = await authenticatedAgent(app);

    const res = await agent
      .post('/api/apply-changes')
      .send({ customerId: '123' })
      .expect(400);

    expect(res.body.error).toMatch(/missing/i);
  });

  test('returns 400 when missing customerId', async () => {
    const agent = await authenticatedAgent(app);

    const res = await agent
      .post('/api/apply-changes')
      .send({ changes: [{ type: 'pause_campaign' }] })
      .expect(400);

    expect(res.body.error).toMatch(/missing/i);
  });

  test('returns success with zero applied when changes array is empty', async () => {
    const agent = await authenticatedAgent(app);

    const res = await agent
      .post('/api/apply-changes')
      .send({ changes: [], customerId: '123' })
      .expect(200);

    expect(res.body.applied).toBe(0);
    expect(res.body.failed).toBe(0);
    expect(res.body.results).toHaveLength(0);
  });

  test('applies changes and returns results in dry run mode', async () => {
    changeExecutor.applyChange.mockResolvedValue('[DRY RUN] Would pause_campaign — Honda Civic');

    const agent = await authenticatedAgent(app);
    const res = await agent
      .post('/api/apply-changes')
      .send({
        changes: [{ type: 'pause_campaign', campaignName: 'Honda Civic' }],
        customerId: '123',
        dryRun: true,
      })
      .expect(200);

    expect(res.body.dryRun).toBe(true);
    expect(res.body.applied).toBe(1);
    expect(res.body.failed).toBe(0);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].success).toBe(true);
  });

  test('applies multiple changes and reports individual successes and failures', async () => {
    changeExecutor.applyChange
      .mockResolvedValueOnce('Paused campaign: Honda Civic')
      .mockRejectedValueOnce(new Error('Campaign not found: "Ghost"'))
      .mockResolvedValueOnce('Enabled campaign: Toyota Trucks');

    const agent = await authenticatedAgent(app);
    const res = await agent
      .post('/api/apply-changes')
      .send({
        changes: [
          { type: 'pause_campaign', campaignName: 'Honda Civic' },
          { type: 'pause_campaign', campaignName: 'Ghost' },
          { type: 'enable_campaign', campaignName: 'Toyota Trucks' },
        ],
        customerId: '123',
        dryRun: false,
      })
      .expect(200);

    expect(res.body.applied).toBe(2);
    expect(res.body.failed).toBe(1);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results[0].success).toBe(true);
    expect(res.body.results[1].success).toBe(false);
    expect(res.body.results[1].result).toContain('Campaign not found');
    expect(res.body.results[2].success).toBe(true);
    expect(res.body.errors).toHaveLength(1);
  });

  test('defaults dryRun to true when not specified', async () => {
    changeExecutor.applyChange.mockResolvedValue('[DRY RUN] Would do thing');

    const agent = await authenticatedAgent(app);
    await agent
      .post('/api/apply-changes')
      .send({
        changes: [{ type: 'pause_campaign', campaignName: 'Test' }],
        customerId: '123',
      })
      .expect(200);

    // applyChange should be called with dryRun = true (the default)
    expect(changeExecutor.applyChange).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      true
    );
  });

  test('creates client with correct credentials from session', async () => {
    changeExecutor.applyChange.mockResolvedValue('Done');

    const agent = await authenticatedAgent(app, {
      tokens: { access_token: 'at', refresh_token: 'my-refresh-token' },
      mccId: '888',
    });
    await agent
      .post('/api/apply-changes')
      .send({
        changes: [{ type: 'pause_campaign', campaignName: 'Test' }],
        customerId: '456',
        dryRun: false,
      })
      .expect(200);

    expect(googleAds.createClient).toHaveBeenCalledWith(
      expect.any(Object),
      'my-refresh-token',
      '456',
      '888'
    );
  });

  test('passes error to error handler when client creation fails', async () => {
    googleAds.createClient.mockImplementation(() => { throw new Error('Invalid credentials'); });

    const agent = await authenticatedAgent(app);
    const res = await agent
      .post('/api/apply-changes')
      .send({
        changes: [{ type: 'pause_campaign', campaignName: 'Test' }],
        customerId: '123',
        dryRun: false,
      })
      .expect(500);

    expect(res.body.error).toMatch(/internal server error/i);
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
describe('GET /health', () => {
  test('returns ok status', async () => {
    const app = createTestApp();

    const res = await supertest(app).get('/health').expect(200);

    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
  });
});
