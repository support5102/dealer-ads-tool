/**
 * Audit Routes — account health auditor API.
 *
 * Called by: src/server.js (mounted at /api/*)
 * Calls: services/audit-engine.js, services/audit-store.js, services/google-ads.js
 *
 * Routes:
 *   POST /api/audit/run?customerId=X     → Run audit on one account, store result
 *   GET  /api/audit/results?customerId=X → Get latest audit result for one account
 *   GET  /api/audit/results/all          → Get latest audit results for all accounts
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { runAudit } = require('../services/audit-engine');
const auditStore = require('../services/audit-store');
const googleAds = require('../services/google-ads');
const auditScheduler = require('../services/audit-scheduler');
const { diagnose } = require('../services/audit-fixer');
const { applyChange } = require('../services/change-executor');

/**
 * Creates audit routes.
 *
 * @param {Object} config - App configuration from config.js
 * @returns {express.Router} Configured audit router
 */
function createAuditRouter(config) {
  const router = express.Router();

  /**
   * POST /api/audit/run?customerId=X
   * Runs a full health audit on the specified Google Ads account.
   */
  router.post('/api/audit/run', requireAuth, async (req, res, next) => {
    const { customerId } = req.query;

    if (!customerId) {
      return res.status(400).json({ error: 'Missing customerId query parameter.' });
    }

    const cleanId = customerId.replace(/-/g, '');
    if (!/^\d{7,10}$/.test(cleanId)) {
      return res.status(400).json({ error: 'Invalid customerId format. Expected 7-10 digit Google Ads ID.' });
    }

    try {
      const mccId = req.session.mccId || config.googleAds.mccId;
      const accessToken = await googleAds.refreshAccessToken(
        config.googleAds,
        req.session.tokens.refresh_token
      );
      req.session.tokens.access_token = accessToken;

      const restCtx = {
        accessToken,
        developerToken: config.googleAds.developerToken,
        customerId: cleanId,
        loginCustomerId: mccId,
      };

      const result = await runAudit(restCtx, req.body || {});

      // Store the result
      auditStore.save(restCtx.customerId, result);

      res.json(result);
    } catch (err) {
      console.error('Audit run error:', err.message);
      next(err);
    }
  });

  /**
   * GET /api/audit/results?customerId=X
   * Returns the latest stored audit result for one account.
   */
  router.get('/api/audit/results', requireAuth, async (req, res) => {
    const { customerId } = req.query;

    if (!customerId) {
      return res.status(400).json({ error: 'Missing customerId query parameter.' });
    }

    const cleanId = customerId.replace(/-/g, '');
    const result = auditStore.getLatest(cleanId);

    if (!result) {
      return res.status(404).json({
        error: `No audit results found for account ${customerId}. Run an audit first.`,
        customerId: cleanId,
      });
    }

    res.json({ customerId: cleanId, ...result });
  });

  /**
   * GET /api/audit/results/all
   * Returns the latest audit result for all previously audited accounts.
   */
  router.get('/api/audit/results/all', requireAuth, async (req, res) => {
    const results = auditStore.getAllLatest();
    res.json({ accounts: results, total: results.length });
  });

  // ── Scheduler control routes ──

  /**
   * POST /api/audit/schedule/start
   * Starts scheduled audits across all MCC child accounts.
   * Stores the user's refresh token for future unattended runs.
   */
  router.post('/api/audit/schedule/start', requireAuth, async (req, res, next) => {
    try {
      const mccId = req.session.mccId || config.googleAds.mccId;
      const refreshToken = req.session.tokens && req.session.tokens.refresh_token;

      if (!refreshToken) {
        return res.status(400).json({ error: 'No refresh token available. Re-connect Google Ads.' });
      }

      const intervalMs = req.body.intervalMs || undefined; // use default if not provided

      const result = auditScheduler.startScheduledAudit({
        config: config.googleAds,
        refreshToken,
        mccId,
        intervalMs,
        runImmediately: req.body.runImmediately || false,
      });

      res.json(result);
    } catch (err) {
      console.error('Audit schedule start error:', err.message);
      next(err);
    }
  });

  /**
   * POST /api/audit/schedule/stop
   * Stops the scheduled audit job.
   */
  router.post('/api/audit/schedule/stop', requireAuth, async (req, res) => {
    const result = auditScheduler.stopScheduledAudit();
    res.json(result);
  });

  /**
   * GET /api/audit/schedule/status
   * Returns the current scheduler status.
   */
  router.get('/api/audit/schedule/status', requireAuth, async (req, res) => {
    const status = auditScheduler.getScheduleStatus();
    res.json(status);
  });

  /**
   * POST /api/deep-scan?customerId=X
   * Runs a comprehensive deep scan (audit + negative keyword + ad copy analysis).
   */
  router.post('/api/deep-scan', requireAuth, async (req, res, next) => {
    const { customerId } = req.query;
    if (!customerId) {
      return res.status(400).json({ error: 'Missing customerId query parameter.' });
    }
    const cleanId = customerId.replace(/-/g, '');
    if (!/^\d{7,10}$/.test(cleanId)) {
      return res.status(400).json({ error: 'Invalid customerId format.' });
    }
    try {
      const mccId = req.session.mccId || config.googleAds.mccId;
      const accessToken = await googleAds.refreshAccessToken(config.googleAds, req.session.tokens.refresh_token);
      req.session.tokens.access_token = accessToken;
      const restCtx = {
        accessToken,
        developerToken: config.googleAds.developerToken,
        customerId: cleanId,
        loginCustomerId: mccId,
      };
      const { runDeepScan } = require('../services/deep-scanner');
      const result = await runDeepScan(restCtx);
      auditStore.save(cleanId, result);
      res.json(result);
    } catch (err) {
      console.error('Deep scan error:', err.message);
      next(err);
    }
  });

  /**
   * POST /api/audit/diagnose?customerId=X
   * Diagnoses audit findings and returns fix recommendations without applying them.
   */
  router.post('/api/audit/diagnose', requireAuth, async (req, res, next) => {
    const { customerId } = req.query;
    if (!customerId) return res.status(400).json({ error: 'Missing customerId.' });
    const cleanId = customerId.replace(/-/g, '');

    try {
      const mccId = req.session.mccId || config.googleAds.mccId;
      const accessToken = await googleAds.refreshAccessToken(config.googleAds, req.session.tokens.refresh_token);
      const restCtx = { accessToken, developerToken: config.googleAds.developerToken, customerId: cleanId, loginCustomerId: mccId };

      // Fetch diagnostic data in parallel
      const [keywords, keywordDiag, adCopy, campaignDiagnostics] = await Promise.all([
        googleAds.getKeywordPerformance(restCtx).catch(() => []),
        googleAds.getKeywordDiagnostics(restCtx).catch(() => []),
        googleAds.getAdCopy(restCtx).catch(() => []),
        googleAds.getCampaignDiagnostics(restCtx).catch(() => []),
      ]);

      // Merge quality/bid data into keyword performance data
      for (const kw of keywords) {
        const diag = keywordDiag.find(d => d.keyword === kw.keyword && d.campaignName === kw.campaignName);
        if (diag) {
          kw.qualityScore = diag.qualityScore;
          kw.firstPageBid = diag.firstPageBid;
          kw.approvalStatus = diag.approvalStatus;
        }
      }

      // Get the latest audit result
      const auditResult = auditStore.getLatest(cleanId);
      if (!auditResult || !auditResult.findings) {
        return res.status(400).json({ error: 'No audit results found. Run an audit first.' });
      }

      // Diagnose each finding (catch per-finding errors so one bad finding doesn't break all)
      const diagnostics = { keywords, adCopy, campaignDiagnostics };
      const results = auditResult.findings.map(finding => {
        try {
          return {
            checkId: finding.checkId,
            title: finding.title,
            ...diagnose(finding, diagnostics),
          };
        } catch (err) {
          console.error(`Diagnose error for ${finding.checkId}:`, err.message);
          return {
            checkId: finding.checkId,
            title: finding.title,
            fixable: false,
            fixes: [],
            manualNotes: [`Diagnosis failed: ${err.message}`],
          };
        }
      });

      res.json({ diagnoses: results });
    } catch (err) {
      console.error('Diagnose error:', err.message, err.stack);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  /**
   * POST /api/audit/fix?customerId=X
   * Applies specific fixes from a diagnosis. Body: { fixes: [{ changeType, campaignName, details }] }
   */
  router.post('/api/audit/fix', requireAuth, async (req, res, next) => {
    const { customerId } = req.query;
    if (!customerId) return res.status(400).json({ error: 'Missing customerId.' });
    const cleanId = customerId.replace(/-/g, '');
    const { fixes } = req.body || {};
    if (!fixes || !Array.isArray(fixes) || fixes.length === 0) {
      return res.status(400).json({ error: 'No fixes provided.' });
    }

    try {
      const mccId = req.session.mccId || config.googleAds.mccId;
      const client = googleAds.createClient(config.googleAds, req.session.tokens.refresh_token, cleanId, mccId);

      const results = { applied: 0, failed: 0, details: [] };

      // Handle dismiss_recommendations_batch specially — needs fresh recommendation data
      const dismissBatch = fixes.find(f => f.changeType === 'dismiss_recommendations_batch');
      const normalFixes = fixes.filter(f => f.changeType !== 'dismiss_recommendations_batch');

      if (dismissBatch) {
        try {
          const accessToken = await googleAds.refreshAccessToken(config.googleAds, req.session.tokens.refresh_token);
          const restCtx = { accessToken, developerToken: config.googleAds.developerToken, customerId: cleanId, loginCustomerId: mccId };
          const recommendations = await googleAds.getRecommendations(restCtx);

          // Dismiss via REST API directly — the google-ads-api library
          // doesn't support client.recommendations.dismiss()
          // Batch all dismiss operations into a single API call
          const axios = require('axios');
          const operations = recommendations.map(rec => ({ resourceName: rec.resourceName }));
          try {
            await axios.post(
              `https://googleads.googleapis.com/v20/customers/${cleanId}/recommendations:dismiss`,
              { operations },
              {
                headers: {
                  'Authorization': `Bearer ${accessToken}`,
                  'developer-token': config.googleAds.developerToken,
                  ...(mccId ? { 'login-customer-id': String(mccId).replace(/-/g, '') } : {}),
                },
                timeout: 30000,
              }
            );
            results.applied += recommendations.length;
            results.details.push({ description: `Dismissed ${recommendations.length} recommendations`, success: true });
          } catch (err) {
            // Log full error for debugging
            const errData = err.response?.data;
            console.error('Dismiss recommendations error:', JSON.stringify(errData, null, 2));
            const msg = errData?.error?.message || err.message;
            // Try to extract more specific error details
            const details = (errData?.error?.details || [])
              .map(d => d.errors?.map(e => e.message)).flat().filter(Boolean);
            results.failed += recommendations.length;
            results.details.push({
              description: `Failed to dismiss ${recommendations.length} recommendations`,
              error: details.length > 0 ? details[0] : msg,
              success: false,
            });
          }
        } catch (err) {
          results.failed++;
          results.details.push({ description: 'Failed to fetch recommendations', error: err.message, success: false });
        }
      }

      // Apply normal fixes
      for (const fix of normalFixes) {
        try {
          const message = await applyChange(client, {
            type: fix.changeType,
            campaignName: fix.campaignName,
            details: fix.details,
          });
          results.applied++;
          results.details.push({ description: fix.description || message, success: true });
        } catch (err) {
          results.failed++;
          results.details.push({ description: fix.description || fix.changeType, error: err.message, success: false });
        }
      }

      res.json({
        message: `Applied ${results.applied} of ${results.applied + results.failed} fixes.`,
        results,
      });
    } catch (err) {
      console.error('Fix error:', err.message);
      next(err);
    }
  });

  return router;
}

module.exports = { createAuditRouter };
