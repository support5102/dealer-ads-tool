/**
 * Unit tests for claude-parser.js — prompt building and task parsing.
 *
 * Tests: buildSystemPrompt, buildUserMessage, parseTask
 * Fakes: tests/fakes/claude-api-fake.js (Anthropic API response doubles)
 */

const axios = require('axios');
const {
  buildSystemPrompt,
  buildUserMessage,
  parseTask,
} = require('../../src/services/claude-parser');
const {
  fakeClaudeResponse,
  fakeClaudeResponseWithMarkdown,
  fakeClaudeInvalidResponse,
  fakeClaudeEmptyResponse,
  SAMPLE_CHANGE_PLAN,
} = require('../fakes/claude-api-fake');

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SAMPLE_STRUCTURE = {
  campaigns: [
    {
      name: 'Honda Civic - Search',
      status: 'ENABLED',
      budget: 50,
      type: 'SEARCH',
      adGroups: [
        {
          name: 'Civic Sedans',
          status: 'ENABLED',
          defaultBid: 1.5,
          keywords: [{ text: 'honda civic' }, { text: 'buy civic' }],
        },
        {
          name: 'Civic Specials',
          status: 'PAUSED',
          defaultBid: 2.0,
          keywords: [{ text: 'civic deal' }],
        },
      ],
    },
    {
      name: 'Toyota Trucks',
      status: 'PAUSED',
      budget: 100,
      type: 'SEARCH',
      adGroups: [],
    },
  ],
};

const CLAUDE_CONFIG = {
  apiKey: 'test-api-key-123',
  model: 'claude-sonnet-4-20250514',
};

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

describe('buildSystemPrompt', () => {
  test('returns a non-empty string', () => {
    const result = buildSystemPrompt();

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('contains JSON format instruction', () => {
    const result = buildSystemPrompt();

    expect(result).toContain('Return ONLY valid JSON');
  });

  test('contains all supported change types', () => {
    const result = buildSystemPrompt();
    const expectedTypes = [
      'pause_campaign',
      'enable_campaign',
      'update_budget',
      'pause_ad_group',
      'enable_ad_group',
      'pause_keyword',
      'add_keyword',
      'add_negative_keyword',
      'exclude_radius',
      'add_radius',
    ];

    for (const type of expectedTypes) {
      expect(result).toContain(type);
    }
  });

  test('contains rules about exact naming and budget format', () => {
    const result = buildSystemPrompt();

    expect(result).toContain('exact campaign/ad group names');
    expect(result).toContain('Budget values');
    expect(result).toContain('Match types');
  });
});

// ---------------------------------------------------------------------------
// buildUserMessage
// ---------------------------------------------------------------------------

describe('buildUserMessage', () => {
  test('returns just the task when no structure provided', () => {
    const task = 'Pause all Honda campaigns';

    const result = buildUserMessage(task, null, 'Test Dealer');

    expect(result).toBe(task);
  });

  test('returns just the task when structure is undefined', () => {
    const task = 'Enable Toyota trucks campaign';

    const result = buildUserMessage(task, undefined, 'Test Dealer');

    expect(result).toBe(task);
  });

  test('includes account name header when structure provided', () => {
    const result = buildUserMessage('some task', SAMPLE_STRUCTURE, 'ABC Motors');

    expect(result).toContain('ACCOUNT: ABC Motors');
  });

  test('includes FRESHDESK TASK section with the task text', () => {
    const task = 'Pause Honda Civic - Search campaign';

    const result = buildUserMessage(task, SAMPLE_STRUCTURE, 'ABC Motors');

    expect(result).toContain('FRESHDESK TASK:');
    expect(result).toContain(task);
  });

  test('formats campaign names, statuses, and budgets', () => {
    const result = buildUserMessage('task', SAMPLE_STRUCTURE, 'ABC Motors');

    expect(result).toContain('"Honda Civic - Search"');
    expect(result).toContain('ENABLED');
    expect(result).toContain('$50/day');
    expect(result).toContain('"Toyota Trucks"');
    expect(result).toContain('PAUSED');
    expect(result).toContain('$100/day');
  });

  test('formats campaign type', () => {
    const result = buildUserMessage('task', SAMPLE_STRUCTURE, 'ABC Motors');

    expect(result).toContain('SEARCH');
  });

  test('includes ad group details with name, status, bid, and keyword count', () => {
    const result = buildUserMessage('task', SAMPLE_STRUCTURE, 'ABC Motors');

    expect(result).toContain('"Civic Sedans"');
    expect(result).toContain('bid:$1.5');
    expect(result).toContain('2 keywords');

    expect(result).toContain('"Civic Specials"');
    expect(result).toContain('bid:$2');
    expect(result).toContain('1 keywords');
  });

  test('includes CURRENT STRUCTURE header', () => {
    const result = buildUserMessage('task', SAMPLE_STRUCTURE, 'ABC Motors');

    expect(result).toContain('CURRENT STRUCTURE:');
  });
});

// ---------------------------------------------------------------------------
// parseTask
// ---------------------------------------------------------------------------

describe('parseTask', () => {
  let axiosPostSpy;

  beforeEach(() => {
    axiosPostSpy = jest.spyOn(axios, 'post');
  });

  afterEach(() => {
    axiosPostSpy.mockRestore();
  });

  test('successfully parses valid JSON response', async () => {
    // Arrange
    axiosPostSpy.mockResolvedValue(fakeClaudeResponse(SAMPLE_CHANGE_PLAN));

    // Act
    const result = await parseTask(CLAUDE_CONFIG, 'Pause Honda campaign', SAMPLE_STRUCTURE, 'ABC Motors');

    // Assert
    expect(result).toEqual(SAMPLE_CHANGE_PLAN);
    expect(result.summary).toBe('Pause Honda Civic campaign and add negative keyword');
    expect(result.changes).toHaveLength(2);
  });

  test('strips markdown code fences from response', async () => {
    // Arrange
    axiosPostSpy.mockResolvedValue(fakeClaudeResponseWithMarkdown(SAMPLE_CHANGE_PLAN));

    // Act
    const result = await parseTask(CLAUDE_CONFIG, 'Pause Honda campaign', SAMPLE_STRUCTURE, 'ABC Motors');

    // Assert
    expect(result).toEqual(SAMPLE_CHANGE_PLAN);
  });

  test('throws on invalid JSON response with descriptive error', async () => {
    // Arrange
    const badText = 'I cannot parse that task, sorry!';
    axiosPostSpy.mockResolvedValue(fakeClaudeInvalidResponse(badText));

    // Act & Assert
    await expect(
      parseTask(CLAUDE_CONFIG, 'some task', SAMPLE_STRUCTURE, 'ABC Motors')
    ).rejects.toThrow('Claude returned invalid JSON');

    await expect(
      parseTask(CLAUDE_CONFIG, 'some task', SAMPLE_STRUCTURE, 'ABC Motors')
    ).rejects.toThrow(/Raw response:/);
  });

  test('throws on empty content array', async () => {
    // Arrange
    axiosPostSpy.mockResolvedValue(fakeClaudeEmptyResponse());

    // Act & Assert
    await expect(
      parseTask(CLAUDE_CONFIG, 'some task', SAMPLE_STRUCTURE, 'ABC Motors')
    ).rejects.toThrow('Claude returned invalid JSON');
  });

  test('passes correct headers including x-api-key and anthropic-version', async () => {
    // Arrange
    axiosPostSpy.mockResolvedValue(fakeClaudeResponse(SAMPLE_CHANGE_PLAN));

    // Act
    await parseTask(CLAUDE_CONFIG, 'Pause Honda campaign', SAMPLE_STRUCTURE, 'ABC Motors');

    // Assert
    const callArgs = axiosPostSpy.mock.calls[0];
    const headers = callArgs[2].headers;

    expect(headers['x-api-key']).toBe('test-api-key-123');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['Content-Type']).toBe('application/json');
  });

  test('passes correct model and max_tokens in request body', async () => {
    // Arrange
    axiosPostSpy.mockResolvedValue(fakeClaudeResponse(SAMPLE_CHANGE_PLAN));

    // Act
    await parseTask(CLAUDE_CONFIG, 'Pause Honda campaign', SAMPLE_STRUCTURE, 'ABC Motors');

    // Assert
    const callArgs = axiosPostSpy.mock.calls[0];
    const body = callArgs[1];

    expect(body.model).toBe('claude-sonnet-4-20250514');
    expect(body.max_tokens).toBe(4096);
  });

  test('sends request to the correct Anthropic API endpoint', async () => {
    // Arrange
    axiosPostSpy.mockResolvedValue(fakeClaudeResponse(SAMPLE_CHANGE_PLAN));

    // Act
    await parseTask(CLAUDE_CONFIG, 'Pause Honda campaign', SAMPLE_STRUCTURE, 'ABC Motors');

    // Assert
    const url = axiosPostSpy.mock.calls[0][0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
  });

  test('sends system prompt and user message in request body', async () => {
    // Arrange
    axiosPostSpy.mockResolvedValue(fakeClaudeResponse(SAMPLE_CHANGE_PLAN));

    // Act
    await parseTask(CLAUDE_CONFIG, 'Pause Honda campaign', SAMPLE_STRUCTURE, 'ABC Motors');

    // Assert
    const body = axiosPostSpy.mock.calls[0][1];

    expect(typeof body.system).toBe('string');
    expect(body.system.length).toBeGreaterThan(0);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toContain('ABC Motors');
    expect(body.messages[0].content).toContain('Pause Honda campaign');
  });
});
