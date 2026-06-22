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

  // Debug — runs the snapshot fetch + detection for ONE dealer and returns
  // the raw data so we can verify the filter is catching real VLA campaigns
  // (and that detection thresholds aren't too strict). Doesn't persist or
  // ticket. Useful when /run-now returns 0 tickets and you can't tell whether
  // that's "clean state" or "filter is broken."
  // Usage: GET /api/vla-health/debug?customerId=1234567890
  router.get('/api/vla-health/debug', requireAuth, async (req, res, next) => {
    try {
      const customerId = String(req.query.customerId || '').replace(/-/g, '');
      if (!/^\d{7,10}$/.test(customerId)) {
        return res.status(400).json({ error: 'customerId query param required (10-digit Google Ads customer ID)' });
      }
      const googleAds = require('../services/google-ads');
      const vlaMonitor = require('../services/vla-monitor');
      const vlaRunner = require('../services/vla-monitor-runner');

      const refreshToken = config.googleAdsBgRefreshToken || (req.session.tokens && req.session.tokens.refresh_token);
      if (!refreshToken) return res.status(401).json({ error: 'No refresh token (set GOOGLE_ADS_BG_REFRESH_TOKEN or log in)' });

      const accessToken = await googleAds.refreshAccessToken(config.googleAds, refreshToken);
      const restCtx = vlaRunner.buildRestCtxForAccount(config, accessToken, {
        customerId, managingMccId: req.session.mccId || config.googleAds.mccId,
      });

      const snapshot = await vlaRunner.fetchSnapshot(restCtx);
      const alerts = vlaMonitor.detectAlerts(snapshot);

      res.json({
        customerId,
        snapshot: {
          vlaCampaignCount: snapshot.vlaCampaigns.length,
          vlaCampaigns: snapshot.vlaCampaigns,
          productTotal: snapshot.productTotal,
          productIssuesCount: snapshot.productIssues.length,
          productIssuesSample: snapshot.productIssues.slice(0, 5),
          dailyMetricsCount: snapshot.dailyMetrics.length,
          dailyMetrics: snapshot.dailyMetrics,
          assetGroupPolicyCount: (snapshot.assetGroupPolicy || []).length,
          assetGroupPolicy: snapshot.assetGroupPolicy || [],
        },
        detectedAlerts: alerts,
        thresholds: vlaMonitor.THRESHOLDS,
      });
    } catch (err) {
      next(err);
    }
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
