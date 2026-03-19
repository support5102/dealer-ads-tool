/**
 * Scheduler Routes — exposes scheduler status for the dashboard.
 *
 * Called by: server.js (mounted as app.use(createSchedulerRouter()))
 * Calls: services/scheduler.js
 */

const express = require('express');
const scheduler = require('../services/scheduler');
const { requireAuth } = require('../middleware/auth');

/**
 * Creates scheduler status routes.
 *
 * @returns {express.Router} Configured router
 */
function createSchedulerRouter() {
  const router = express.Router();

  /**
   * GET /api/scheduler/status — returns all registered jobs and their status.
   * Requires authentication to prevent leaking internal error messages.
   */
  router.get('/api/scheduler/status', requireAuth, (req, res) => {
    res.json({
      jobs: scheduler.listJobs(),
    });
  });

  return router;
}

module.exports = { createSchedulerRouter };
