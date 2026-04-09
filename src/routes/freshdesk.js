/**
 * Freshdesk Routes — ticket list and detail API.
 *
 * Called by: src/server.js (mounted via app.use)
 * Calls: services/freshdesk.js
 *
 * Routes:
 *   GET /api/freshdesk/status       — Check if Freshdesk is configured
 *   GET /api/freshdesk/tickets      — List tickets assigned to current agent
 *   GET /api/freshdesk/tickets/:id  — Get full ticket detail
 *
 * All routes require Google OAuth auth. The Freshdesk API key is separate
 * and checked per-request. Agent ID is cached in the session.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { createClient } = require('../services/freshdesk');

function createFreshdeskRouter(config) {
  const router = express.Router();
  const configured = !!(config.freshdesk && config.freshdesk.apiKey);
  const client = configured ? createClient(config.freshdesk) : null;

  // ── Status: is Freshdesk configured? ──
  router.get('/api/freshdesk/status', requireAuth, async (req, res, next) => {
    if (!configured) return res.json({ configured: false });

    try {
      // Cache agent info in session to avoid repeated /agents/me calls
      if (!req.session.freshdeskAgent) {
        req.session.freshdeskAgent = await client.checkConnection();
      }
      res.json({ configured: true, agent: req.session.freshdeskAgent });
    } catch (err) {
      res.json({ configured: false, error: err.message });
    }
  });

  // ── List my tickets ──
  router.get('/api/freshdesk/tickets', requireAuth, async (req, res, next) => {
    if (!configured) return res.json({ configured: false, tickets: [] });

    try {
      // Ensure we have the agent ID
      if (!req.session.freshdeskAgent) {
        req.session.freshdeskAgent = await client.checkConnection();
      }
      const tickets = await client.listTickets(req.session.freshdeskAgent.id);
      res.json({ tickets });
    } catch (err) {
      next(err);
    }
  });

  // ── Get ticket detail ──
  router.get('/api/freshdesk/tickets/:id', requireAuth, async (req, res, next) => {
    if (!configured) return res.status(404).json({ error: 'Freshdesk not configured' });

    try {
      const ticket = await client.getTicket(Number(req.params.id));
      res.json({ ticket });
    } catch (err) {
      if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
      next(err);
    }
  });

  return router;
}

module.exports = { createFreshdeskRouter };
