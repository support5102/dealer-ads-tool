/**
 * Tier 3 Builder Route Tests — validates Campaign Builder AI proxy.
 *
 * Tests: src/routes/builder.js
 * Mocks: axios (to intercept Anthropic API calls)
 */

const supertest = require('supertest');
const axios = require('axios');
const { createTestApp } = require('./test-helpers');

jest.mock('axios');

describe('POST /api/builder/ai', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
  });

  test('proxies a simple Claude call and returns the response', async () => {
    const anthropicResponse = {
      content: [{ type: 'text', text: '{"lat": 41.66, "lng": -83.55}' }],
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'end_turn',
    };

    axios.post.mockResolvedValue({ data: anthropicResponse });

    const res = await supertest(app)
      .post('/api/builder/ai')
      .send({
        system: 'You return GPS coordinates as JSON.',
        prompt: 'GPS coordinates for Toledo, OH USA.',
        tokens: 300,
      })
      .expect(200);

    expect(res.body.content).toEqual(anthropicResponse.content);
    expect(res.body.content[0].text).toContain('41.66');

    // Verify the call to Anthropic
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, payload, options] = axios.post.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(payload.model).toBe('claude-sonnet-4-20250514');
    expect(payload.max_tokens).toBe(300);
    expect(payload.system).toBe('You return GPS coordinates as JSON.');
    expect(payload.messages[0].content).toBe('GPS coordinates for Toledo, OH USA.');
    expect(options.headers['x-api-key']).toBe('test-anthropic-key');
    expect(options.headers['anthropic-version']).toBe('2023-06-01');
  });

  test('forwards tools array when provided (web_search)', async () => {
    const anthropicResponse = {
      content: [
        { type: 'tool_use', name: 'web_search', id: 'ws1' },
        { type: 'text', text: '{"dealerName":"Thayer Ford"}' },
      ],
    };

    axios.post.mockResolvedValue({ data: anthropicResponse });

    const tools = [{ type: 'web_search_20250305', name: 'web_search' }];

    const res = await supertest(app)
      .post('/api/builder/ai')
      .send({
        system: 'Extract dealer info.',
        prompt: 'Fetch this page: https://example.com',
        tokens: 1000,
        tools,
      })
      .expect(200);

    const [, payload] = axios.post.mock.calls[0];
    expect(payload.tools).toEqual(tools);
    expect(res.body.content).toHaveLength(2);
  });

  test('returns 400 when system is missing', async () => {
    const res = await supertest(app)
      .post('/api/builder/ai')
      .send({ prompt: 'hello' })
      .expect(400);

    expect(res.body.error).toMatch(/system and prompt are required/);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('returns 400 when prompt is missing', async () => {
    const res = await supertest(app)
      .post('/api/builder/ai')
      .send({ system: 'hello' })
      .expect(400);

    expect(res.body.error).toMatch(/system and prompt are required/);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('caps max_tokens at 4096', async () => {
    axios.post.mockResolvedValue({ data: { content: [] } });

    await supertest(app)
      .post('/api/builder/ai')
      .send({
        system: 'test',
        prompt: 'test',
        tokens: 99999,
      })
      .expect(200);

    const [, payload] = axios.post.mock.calls[0];
    expect(payload.max_tokens).toBe(4096);
  });

  test('defaults max_tokens to 300 when not provided', async () => {
    axios.post.mockResolvedValue({ data: { content: [] } });

    await supertest(app)
      .post('/api/builder/ai')
      .send({ system: 'test', prompt: 'test' })
      .expect(200);

    const [, payload] = axios.post.mock.calls[0];
    expect(payload.max_tokens).toBe(300);
  });

  test('forwards Anthropic API errors with status code', async () => {
    axios.post.mockRejectedValue({
      response: {
        status: 429,
        data: { error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } },
      },
    });

    const res = await supertest(app)
      .post('/api/builder/ai')
      .send({ system: 'test', prompt: 'test' })
      .expect(429);

    expect(res.body.error).toBe('Rate limit exceeded');
  });

  test('does not include tools in payload when not provided', async () => {
    axios.post.mockResolvedValue({ data: { content: [] } });

    await supertest(app)
      .post('/api/builder/ai')
      .send({ system: 'test', prompt: 'test' })
      .expect(200);

    const [, payload] = axios.post.mock.calls[0];
    expect(payload.tools).toBeUndefined();
  });

  test('does not require authentication (no Google OAuth needed)', async () => {
    // Calling without setting up a session should still work
    axios.post.mockResolvedValue({ data: { content: [{ type: 'text', text: 'ok' }] } });

    await supertest(app)
      .post('/api/builder/ai')
      .send({ system: 'test', prompt: 'test' })
      .expect(200);
  });
});
