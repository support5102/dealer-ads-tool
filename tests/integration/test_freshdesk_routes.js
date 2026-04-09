/**
 * Integration tests for Freshdesk routes.
 */
const { createTestApp, authenticatedAgent, TEST_CONFIG } = require('./test-helpers');

// Mock the freshdesk service
jest.mock('../../src/services/freshdesk');
const { createClient } = require('../../src/services/freshdesk');

const FAKE_AGENT = { id: 42, name: 'Brian', email: 'brian@savvydealer.com' };
const FAKE_TICKETS = [
  { id: 100, subject: 'Pause campaign', requesterName: 'John', priority: 3, priorityLabel: 'High', status: 2, statusLabel: 'Open', createdAt: '2026-03-24T10:00:00Z', updatedAt: '2026-03-24T11:00:00Z' },
];
const FAKE_TICKET_DETAIL = {
  id: 100, subject: 'Pause campaign', description: 'Please pause Honda.', requesterName: 'John',
  requesterEmail: 'john@dealer.com', priority: 3, priorityLabel: 'High', status: 2, statusLabel: 'Open',
  createdAt: '2026-03-24T10:00:00Z', updatedAt: '2026-03-24T11:00:00Z',
};

// Stable mock fns — the app captures these once at creation, so they must
// stay the same object. Use mockImplementation to change behavior per-test.
const mockCheckConnection = jest.fn().mockResolvedValue(FAKE_AGENT);
const mockListTickets = jest.fn().mockResolvedValue(FAKE_TICKETS);
const mockGetTicket = jest.fn().mockResolvedValue(FAKE_TICKET_DETAIL);

createClient.mockReturnValue({
  checkConnection: mockCheckConnection,
  listTickets: mockListTickets,
  getTicket: mockGetTicket,
});

beforeEach(() => {
  mockCheckConnection.mockReset().mockResolvedValue(FAKE_AGENT);
  mockListTickets.mockReset().mockResolvedValue(FAKE_TICKETS);
  mockGetTicket.mockReset().mockResolvedValue(FAKE_TICKET_DETAIL);
});

describe('Freshdesk routes (not configured)', () => {
  let app;
  beforeAll(() => {
    // Config without API key
    app = createTestApp();
  });

  test('GET /api/freshdesk/status returns configured: false', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/freshdesk/status').expect(200);
    expect(res.body.configured).toBe(false);
  });

  test('GET /api/freshdesk/tickets returns empty when not configured', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/freshdesk/tickets').expect(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.tickets).toEqual([]);
  });

  test('GET /api/freshdesk/tickets/:id returns 404 when not configured', async () => {
    const agent = await authenticatedAgent(app);
    await agent.get('/api/freshdesk/tickets/100').expect(404);
  });
});

describe('Freshdesk routes (configured)', () => {
  let app;
  beforeAll(() => {
    // Create app with Freshdesk API key
    const configWithFreshdesk = {
      ...TEST_CONFIG,
      freshdesk: { apiKey: 'test-api-key', domain: 'testdealer' },
    };
    const { createApp } = require('../../src/server');
    app = createApp(configWithFreshdesk);
    app.get('/__test__/set-session', (req, res) => {
      req.session.tokens = { access_token: 'fake', refresh_token: 'fake' };
      res.json({ ok: true });
    });
  });

  test('GET /api/freshdesk/status returns configured: true with agent', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/freshdesk/status').expect(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.agent).toEqual(FAKE_AGENT);
  });

  test('GET /api/freshdesk/tickets returns ticket list', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/freshdesk/tickets').expect(200);
    expect(res.body.tickets).toHaveLength(1);
    expect(res.body.tickets[0].subject).toBe('Pause campaign');
  });

  test('GET /api/freshdesk/tickets/:id returns ticket detail', async () => {
    const agent = await authenticatedAgent(app);
    const res = await agent.get('/api/freshdesk/tickets/100').expect(200);
    expect(res.body.ticket.description).toBe('Please pause Honda.');
  });

  test('GET /api/freshdesk/tickets returns 401 when not authenticated', async () => {
    const supertest = require('supertest');
    await supertest(app).get('/api/freshdesk/tickets').expect(401);
  });

  test('GET /api/freshdesk/tickets/:id returns 404 for unknown ticket', async () => {
    mockGetTicket.mockRejectedValueOnce(new Error('Ticket 999 not found'));
    const agent = await authenticatedAgent(app);
    await agent.get('/api/freshdesk/tickets/999').expect(404);
  });
});
