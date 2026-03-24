/**
 * Freshdesk Service — fetches tickets from the Freshdesk API.
 *
 * Called by: routes/freshdesk.js
 * Calls: Freshdesk REST API v2 via axios
 *
 * Uses Basic auth with the Freshdesk API key. The "password" field is
 * ignored by Freshdesk — any non-empty string works (we use "X").
 */

const axios = require('axios');

const PRIORITY_LABELS = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };
const STATUS_LABELS = {
  2: 'Open', 3: 'Pending', 4: 'Resolved', 5: 'Closed',
  6: 'Waiting on Reply', 10: 'Task in Azure', 11: 'Reopened',
  12: 'Assigned', 13: 'In Progress', 14: 'Service Feedback',
};

/**
 * Creates a Freshdesk API client.
 *
 * @param {Object} freshdeskConfig - { apiKey, domain }
 * @returns {Object} Client with listTickets, getTicket, checkConnection methods
 */
function createClient(freshdeskConfig) {
  const { apiKey, domain } = freshdeskConfig;
  const baseURL = `https://${domain}.freshdesk.com/api/v2`;
  const auth = Buffer.from(`${apiKey}:X`).toString('base64');
  const headers = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' };

  const http = axios.create({ baseURL, headers, timeout: 15000 });

  /**
   * Verifies the API key and returns the target agent's info.
   * If agentEmail is configured, looks up that agent by email.
   * Otherwise falls back to /agents/me (the API key owner).
   *
   * @returns {Promise<{ id: number, name: string, email: string }>}
   */
  async function checkConnection() {
    try {
      // Always use /agents/me — it works with any agent role (no admin required).
      // The API key determines the agent identity.
      const res = await http.get('/agents/me');
      const data = res.data;

      return {
        id: data.id,
        name: data.contact?.name || data.name || 'Unknown',
        email: data.contact?.email || data.email || agentEmail || '',
      };
    } catch (err) {
      if (err.message && err.message.includes('No Freshdesk agent')) throw err;
      const status = err.response?.status;
      if (status === 401) throw new Error('Freshdesk API key is invalid or expired');
      if (status === 403) throw new Error('Freshdesk API key lacks permission');
      throw new Error(`Freshdesk connection failed: ${err.message}`);
    }
  }

  /**
   * Lists open/pending tickets assigned to a specific agent.
   *
   * @param {number} agentId - The Freshdesk agent ID
   * @returns {Promise<Object[]>} Array of ticket summaries
   */
  async function listTickets(agentId) {
    try {
      // Include all active statuses (exclude only Resolved=4 and Closed=5)
      const query = `"agent_id:${agentId} AND (status:2 OR status:3 OR status:6 OR status:10 OR status:11 OR status:12 OR status:13 OR status:14)"`;
      const { data } = await http.get('/search/tickets', {
        params: { query },
      });

      const results = data.results || [];
      return results.map(t => ({
        id: t.id,
        subject: t.subject || '(no subject)',
        requesterName: t.requester?.name || 'Unknown',
        priority: t.priority,
        priorityLabel: PRIORITY_LABELS[t.priority] || 'Unknown',
        status: t.status,
        statusLabel: STATUS_LABELS[t.status] || 'Unknown',
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      }));
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) throw new Error('Freshdesk rate limit exceeded — try again in a minute');
      throw new Error(`Failed to list tickets: ${err.message}`);
    }
  }

  /**
   * Gets full ticket detail including description text.
   *
   * @param {number} ticketId - Ticket ID
   * @returns {Promise<Object>} Ticket with description_text and conversations
   */
  async function getTicket(ticketId) {
    try {
      const { data } = await http.get(`/tickets/${ticketId}`, {
        params: { include: 'requester' },
      });

      return {
        id: data.id,
        subject: data.subject || '(no subject)',
        description: data.description_text || data.description || '',
        requesterName: data.requester?.name || 'Unknown',
        requesterEmail: data.requester?.email || '',
        priority: data.priority,
        priorityLabel: PRIORITY_LABELS[data.priority] || 'Unknown',
        status: data.status,
        statusLabel: STATUS_LABELS[data.status] || 'Unknown',
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      };
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) throw new Error(`Ticket ${ticketId} not found`);
      throw new Error(`Failed to get ticket: ${err.message}`);
    }
  }

  return { checkConnection, listTickets, getTicket };
}

module.exports = { createClient, PRIORITY_LABELS, STATUS_LABELS };
