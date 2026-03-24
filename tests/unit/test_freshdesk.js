/**
 * Unit tests for services/freshdesk.js
 */
const axios = require('axios');
const { createClient } = require('../../src/services/freshdesk');

jest.mock('axios');

const FAKE_CONFIG = { apiKey: 'test-key-123', domain: 'testdealer' };

// Mock axios.create to return a mock instance with get()
let mockGet;
beforeEach(() => {
  mockGet = jest.fn();
  axios.create.mockReturnValue({ get: mockGet });
});

describe('createClient', () => {
  test('creates axios instance with correct base URL and auth', () => {
    createClient(FAKE_CONFIG);
    expect(axios.create).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: 'https://testdealer.freshdesk.com/api/v2',
      timeout: 15000,
    }));
    const callArgs = axios.create.mock.calls[0][0];
    const expectedAuth = Buffer.from('test-key-123:X').toString('base64');
    expect(callArgs.headers.Authorization).toBe(`Basic ${expectedAuth}`);
  });
});

describe('checkConnection', () => {
  test('returns agent info on success', async () => {
    mockGet.mockResolvedValue({
      data: { id: 42, contact: { name: 'Brian', email: 'brian@savvydealer.com' } },
    });
    const client = createClient(FAKE_CONFIG);
    const agent = await client.checkConnection();
    expect(agent).toEqual({ id: 42, name: 'Brian', email: 'brian@savvydealer.com' });
    expect(mockGet).toHaveBeenCalledWith('/agents/me');
  });

  test('throws descriptive error on 401', async () => {
    mockGet.mockRejectedValue({ response: { status: 401 } });
    const client = createClient(FAKE_CONFIG);
    await expect(client.checkConnection()).rejects.toThrow('invalid or expired');
  });

  test('throws descriptive error on 403', async () => {
    mockGet.mockRejectedValue({ response: { status: 403 } });
    const client = createClient(FAKE_CONFIG);
    await expect(client.checkConnection()).rejects.toThrow('lacks permission');
  });
});

describe('listTickets', () => {
  test('returns mapped ticket summaries', async () => {
    mockGet.mockResolvedValue({
      data: {
        results: [
          { id: 100, subject: 'Pause Honda campaign', requester: { name: 'John' }, priority: 3, status: 2, created_at: '2026-03-24T10:00:00Z', updated_at: '2026-03-24T11:00:00Z' },
          { id: 101, subject: 'Increase budget', requester: { name: 'Jane' }, priority: 1, status: 3, created_at: '2026-03-23T08:00:00Z', updated_at: '2026-03-23T09:00:00Z' },
        ],
      },
    });
    const client = createClient(FAKE_CONFIG);
    const tickets = await client.listTickets(42);

    expect(tickets).toHaveLength(2);
    expect(tickets[0]).toEqual(expect.objectContaining({
      id: 100,
      subject: 'Pause Honda campaign',
      requesterName: 'John',
      priorityLabel: 'High',
      statusLabel: 'Open',
    }));
    expect(tickets[1].priorityLabel).toBe('Low');
    expect(tickets[1].statusLabel).toBe('Pending');
  });

  test('builds correct search query with agent ID', async () => {
    mockGet.mockResolvedValue({ data: { results: [] } });
    const client = createClient(FAKE_CONFIG);
    await client.listTickets(99);
    expect(mockGet).toHaveBeenCalledWith('/search/tickets', {
      params: { query: '"agent_id:99 AND (status:2 OR status:3)"' },
    });
  });

  test('returns empty array when no results', async () => {
    mockGet.mockResolvedValue({ data: { results: [] } });
    const client = createClient(FAKE_CONFIG);
    const tickets = await client.listTickets(42);
    expect(tickets).toEqual([]);
  });

  test('throws on 429 rate limit', async () => {
    mockGet.mockRejectedValue({ response: { status: 429 }, message: 'Too Many Requests' });
    const client = createClient(FAKE_CONFIG);
    await expect(client.listTickets(42)).rejects.toThrow('rate limit');
  });
});

describe('getTicket', () => {
  test('returns ticket detail with description_text', async () => {
    mockGet.mockResolvedValue({
      data: {
        id: 100,
        subject: 'Pause Honda campaign',
        description_text: 'Please pause the Honda Civic campaign in Florida.',
        description: '<div>Please pause the Honda Civic campaign in Florida.</div>',
        requester: { name: 'John', email: 'john@dealer.com' },
        priority: 4,
        status: 2,
        created_at: '2026-03-24T10:00:00Z',
        updated_at: '2026-03-24T11:00:00Z',
      },
    });
    const client = createClient(FAKE_CONFIG);
    const ticket = await client.getTicket(100);

    expect(ticket.description).toBe('Please pause the Honda Civic campaign in Florida.');
    expect(ticket.priorityLabel).toBe('Urgent');
    expect(ticket.requesterEmail).toBe('john@dealer.com');
    expect(mockGet).toHaveBeenCalledWith('/tickets/100', { params: { include: 'requester' } });
  });

  test('throws on 404', async () => {
    mockGet.mockRejectedValue({ response: { status: 404 }, message: 'Not Found' });
    const client = createClient(FAKE_CONFIG);
    await expect(client.getTicket(999)).rejects.toThrow('not found');
  });

  test('uses subject when description_text is missing', async () => {
    mockGet.mockResolvedValue({
      data: { id: 101, subject: 'Quick fix', priority: 1, status: 2, created_at: '2026-03-24' },
    });
    const client = createClient(FAKE_CONFIG);
    const ticket = await client.getTicket(101);
    expect(ticket.description).toBe('');
    expect(ticket.subject).toBe('Quick fix');
  });
});
