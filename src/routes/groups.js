/**
 * Groups Routes — CRUD API for dealer groups admin UI.
 *
 * Mounted by: src/server.js
 *
 * Routes:
 *   GET    /api/groups                    → list all groups with members
 *   POST   /api/groups                    → create group
 *   PATCH  /api/groups/:id               → update group name/curveId
 *   DELETE /api/groups/:id               → delete group (cascade members)
 *   POST   /api/groups/:id/members       → add dealer to group
 *   DELETE /api/groups/:id/members/:name → remove dealer from group
 *   POST   /api/groups/seed-defaults     → seed default Alan Jay group
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const dealerGroupsStore = require('../services/dealer-groups-store');

const VALID_CURVE_IDS = ['linear', 'alanJay9505'];

function createGroupsRouter() {
  const router = express.Router();

  // ── GET /api/groups ──────────────────────────────────────────────────────
  router.get('/api/groups', requireAuth, async (req, res, next) => {
    try {
      const groups = await dealerGroupsStore.loadAll();
      res.json({ groups });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/groups/seed-defaults ───────────────────────────────────────
  // Must be registered before /:id to avoid treating "seed-defaults" as an id
  router.post('/api/groups/seed-defaults', requireAuth, async (req, res, next) => {
    try {
      const created = await dealerGroupsStore.seedDefaults();
      res.json({ seeded: created.length, groups: created });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/groups ─────────────────────────────────────────────────────
  router.post('/api/groups', requireAuth, async (req, res, next) => {
    try {
      const { name, curveId } = req.body || {};

      if (!name || String(name).trim() === '') {
        return res.status(400).json({ error: 'name is required and must not be blank' });
      }
      if (!curveId || !VALID_CURVE_IDS.includes(curveId)) {
        return res.status(400).json({ error: `curveId must be one of: ${VALID_CURVE_IDS.join(', ')}` });
      }

      const group = await dealerGroupsStore.createGroup({ name: String(name).trim(), curveId });
      res.status(201).json({ group });
    } catch (err) {
      // Unique constraint violation
      if (err.code === '23505') {
        return res.status(409).json({ error: `A group named "${req.body.name}" already exists` });
      }
      next(err);
    }
  });

  // ── PATCH /api/groups/:id ─────────────────────────────────────────────────
  router.patch('/api/groups/:id', requireAuth, async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid group id' });

      const { name, curveId } = req.body || {};

      if (name !== undefined && String(name).trim() === '') {
        return res.status(400).json({ error: 'name must not be blank' });
      }
      if (curveId !== undefined && !VALID_CURVE_IDS.includes(curveId)) {
        return res.status(400).json({ error: `curveId must be one of: ${VALID_CURVE_IDS.join(', ')}` });
      }

      const updates = {};
      if (name !== undefined) updates.name = String(name).trim();
      if (curveId !== undefined) updates.curveId = curveId;

      const group = await dealerGroupsStore.updateGroup(id, updates);
      res.json({ group });
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ error: err.message });
      if (err.code === '23505') {
        return res.status(409).json({ error: 'A group with that name already exists' });
      }
      next(err);
    }
  });

  // ── DELETE /api/groups/:id ────────────────────────────────────────────────
  router.delete('/api/groups/:id', requireAuth, async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid group id' });

      await dealerGroupsStore.deleteGroup(id);
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/groups/:id/members ──────────────────────────────────────────
  router.post('/api/groups/:id/members', requireAuth, async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid group id' });

      const { dealerName } = req.body || {};
      if (!dealerName || String(dealerName).trim() === '') {
        return res.status(400).json({ error: 'dealerName is required and must not be blank' });
      }

      await dealerGroupsStore.addMember(id, String(dealerName).trim());
      res.json({ added: true });
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ error: err.message });
      next(err);
    }
  });

  // ── DELETE /api/groups/:id/members/:dealerName ────────────────────────────
  router.delete('/api/groups/:id/members/:dealerName', requireAuth, async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid group id' });

      const dealerName = decodeURIComponent(req.params.dealerName);
      await dealerGroupsStore.removeMember(id, dealerName);
      res.json({ removed: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createGroupsRouter };
