/**
 * VLA Health routes — dashboard read + one-shot scan trigger + admin helpers.
 *
 * Mounted at /api/vla-health/* by server.js.
 *
 * Routes:
 *   GET  /api/vla-health/state           — currently-open alerts across all dealers
 *   POST /api/vla-health/run-now         — fires the scanner immediately (auth-gated)
 *   GET  /api/vla-health/bg-token        — returns the current session's refresh
 *                                          token so an admin can paste it into
 *                                          Cloud Run env (one-time setup for
 *                                          GOOGLE_ADS_BG_REFRESH_TOKEN). The token
 *                                          is shown to the LOGGED-IN USER only.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const vlaAlertStore = require('../services/vla-alert-store');
const vlaRunner = require('../services/vla-monitor-runner');

function createVlaHealthRouter(config) {
  const router = express.Router();

  // Read-only — dashboard widget calls this. No mutation, but auth-gated so
  // we don't leak per-dealer state publicly.
  router.get('/api/vla-health/state', requireAuth, async (req, res, next) => {
    try {
      const open = await vlaAlertStore.listAllOpen();
      // Group by dealer for the UI's convenience.
      const byDealer = {};
      for (const row of open) {
        if (!byDealer[row.dealer_name]) byDealer[row.dealer_name] = [];
        byDealer[row.dealer_name].push({
          alertKind: row.alert_kind,
          severity: row.severity,
          consecutiveDays: row.consecutive_days,
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
          freshdeskTicketId: row.freshdesk_ticket_id,
          payload: row.payload,
        });
      }
      res.json({
        totalOpen: open.length,
        dealerCount: Object.keys(byDealer).length,
        byDealer,
      });
    } catch (err) { next(err); }
  });

  // Manual trigger — for testing and for one-off "I want to know NOW" use.
  // Returns the run summary inline. Long-running; expect 30-60s for a full MCC.
  router.post('/api/vla-health/run-now', requireAuth, async (req, res, next) => {
    try {
      const summary = await vlaRunner.run({ config });
      res.json(summary);
    } catch (err) { next(err); }
  });

  // One-shot admin route — returns the LOGGED-IN USER's refresh token so they
  // can paste it as the GOOGLE_ADS_BG_REFRESH_TOKEN env var on Cloud Run.
  // We require auth so this only works for someone with an active session,
  // and we don't log the value server-side.
  router.get('/api/vla-health/bg-token', requireAuth, (req, res) => {
    const token = req.session.tokens && req.session.tokens.refresh_token;
    if (!token) {
      return res.status(401).json({ error: 'No refresh token in current session. Reconnect Google Ads first.' });
    }
    res.json({
      refresh_token: token,
      instructions: [
        '1. Copy the refresh_token value above.',
        '2. Go to Cloud Run console → dealer-ads-tool service → Edit & Deploy New Revision → Variables.',
        '3. Add a variable named GOOGLE_ADS_BG_REFRESH_TOKEN with the value above.',
        '4. (Optional) Set VLA_MONITOR_ENABLED=true to turn the daily scan on.',
        '5. Deploy. The scanner will run at 9 AM ET going forward.',
      ],
    });
  });

  return router;
}

module.exports = { createVlaHealthRouter };
