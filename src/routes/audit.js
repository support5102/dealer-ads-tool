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
const changeHistory = require('../services/change-history');
const dealerContextStore = require('../services/dealer-context-store');
const { syncDealerContext, syncAllDealers } = require('../services/freshdesk-context-sync');
const { createClient: createFreshdeskClient } = require('../services/freshdesk');

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
      const results = await Promise.all(auditResult.findings.map(async (finding) => {
        try {
          return {
            checkId: finding.checkId,
            title: finding.title,
            ...(await diagnose(finding, diagnostics, config.claude)),
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
      }));

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
          const axios = require('axios');
          const dismissHeaders = {
            'Authorization': `Bearer ${accessToken}`,
            'developer-token': config.googleAds.developerToken,
            ...(mccId ? { 'login-customer-id': String(mccId).replace(/-/g, '') } : {}),
          };

          // Run dismiss up to 2 passes — some recommendations regenerate after first dismiss
          let totalDismissed = 0;
          let totalFailed = 0;
          const failedTypes = new Set();

          for (let pass = 0; pass < 2; pass++) {
            const recommendations = await googleAds.getRecommendations(restCtx);
            console.log(`[Dismiss pass ${pass + 1}] Found ${recommendations.length} recommendations: ${recommendations.map(r => r.type).join(', ')}`);

            if (recommendations.length === 0) break;

            // Dismiss one at a time for reliability (batch can silently skip some)
            for (const rec of recommendations) {
              try {
                await axios.post(
                  `https://googleads.googleapis.com/v20/customers/${cleanId}/recommendations:dismiss`,
                  { operations: [{ resourceName: rec.resourceName }] },
                  { headers: dismissHeaders, timeout: 15000 }
                );
                totalDismissed++;
              } catch (err) {
                const msg = err.response?.data?.error?.message || err.message;
                console.warn(`[Dismiss] Failed to dismiss ${rec.type} (${rec.resourceName}): ${msg}`);
                totalFailed++;
                failedTypes.add(rec.type || 'unknown');
              }
            }

            // Brief pause before second pass to let API settle
            if (pass === 0) await new Promise(r => setTimeout(r, 2000));
          }

          results.applied += totalDismissed;
          results.failed += totalFailed;
          if (totalDismissed > 0) {
            results.details.push({ description: `Dismissed ${totalDismissed} recommendations`, success: true });
          }
          if (totalFailed > 0) {
            const typeNote = failedTypes.size > 0 ? ` (types: ${[...failedTypes].join(', ')})` : '';
            results.details.push({
              description: `${totalFailed} recommendation(s) could not be dismissed${typeNote}`,
              success: false,
            });
          }
        } catch (err) {
          results.failed++;
          results.details.push({ description: 'Failed to fetch recommendations', error: err.message, success: false });
        }
      }

      // Apply normal fixes
      const email = req.session.userEmail || 'unknown';
      for (const fix of normalFixes) {
        try {
          const message = await applyChange(client, {
            type: fix.changeType,
            campaignName: fix.campaignName,
            adGroupName: fix.adGroupName,
            details: fix.details,
          });
          results.applied++;
          results.details.push({ description: fix.description || message, success: true });
          changeHistory.addEntry({
            action: fix.changeType,
            userEmail: email,
            accountId: cleanId,
            details: { campaignName: fix.campaignName, target: fix.description, ...fix.details },
            source: 'audit_fixer',
            success: true,
          });
        } catch (err) {
          results.failed++;
          results.details.push({ description: fix.description || fix.changeType, error: err.message, success: false });
          changeHistory.addEntry({
            action: fix.changeType,
            userEmail: email,
            accountId: cleanId,
            details: { campaignName: fix.campaignName, target: fix.description },
            source: 'audit_fixer',
            success: false,
            error: err.message,
          });
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

  /**
   * GET /api/change-history?limit=100&accountId=X
   * Returns change history log of all API changes made by the tool.
   */
  router.get('/api/change-history', requireAuth, async (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const accountId = req.query.accountId || null;
    const history = await changeHistory.getHistory(limit, accountId);
    const total = await changeHistory.size();
    res.json({ entries: history, total });
  });

  /**
   * GET /api/dealer-context — list all cached dealer contexts
   */
  router.get('/api/dealer-context', requireAuth, (req, res) => {
    res.json({ contexts: dealerContextStore.getAll() });
  });

  /**
   * GET /api/dealer-context/:accountId — get context for a specific dealer
   */
  router.get('/api/dealer-context/:accountId', requireAuth, (req, res) => {
    const ctx = dealerContextStore.getContext(req.params.accountId);
    if (!ctx) return res.status(404).json({ error: 'No context found for this account.' });
    res.json({ context: ctx });
  });

  /**
   * POST /api/dealer-context/sync — sync context from Freshdesk for one dealer
   * Body: { accountId, dealerName, freshdeskTag }
   */
  router.post('/api/dealer-context/sync', requireAuth, async (req, res) => {
    const { accountId, dealerName, freshdeskTag } = req.body || {};
    if (!accountId || !freshdeskTag) {
      return res.status(400).json({ error: 'Missing accountId or freshdeskTag.' });
    }
    if (!config.freshdesk?.apiKey || !config.freshdesk?.domain) {
      return res.status(400).json({ error: 'Freshdesk not configured.' });
    }
    if (!config.claude?.apiKey) {
      return res.status(400).json({ error: 'Claude API not configured.' });
    }

    try {
      const fdClient = createFreshdeskClient(config.freshdesk);
      const result = await syncDealerContext(fdClient, config.claude, { accountId, dealerName, freshdeskTag });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/dealer-context/sync-all — sync context from Freshdesk for all dealers with tags
   * Body: { dealers: [{ accountId, dealerName, freshdeskTag }] }
   */
  router.post('/api/dealer-context/sync-all', requireAuth, async (req, res) => {
    const { dealers } = req.body || {};
    if (!dealers || !Array.isArray(dealers)) {
      return res.status(400).json({ error: 'Missing dealers array.' });
    }
    if (!config.freshdesk?.apiKey || !config.freshdesk?.domain) {
      return res.status(400).json({ error: 'Freshdesk not configured.' });
    }
    if (!config.claude?.apiKey) {
      return res.status(400).json({ error: 'Claude API not configured.' });
    }

    try {
      const fdClient = createFreshdeskClient(config.freshdesk);
      const result = await syncAllDealers(fdClient, config.claude, dealers);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Ad copy endpoints ──

  /**
   * GET /api/ads?customerId=X — Fetch all RSA ads for an account
   * Optional: campaignName, adGroupName to filter
   */
  router.get('/api/ads', requireAuth, async (req, res, next) => {
    const customerId = (req.query.customerId || '').replace(/-/g, '');
    if (!customerId) return res.status(400).json({ error: 'customerId is required' });

    try {
      const restCtx = {
        accessToken: req.session.tokens.access_token,
        developerToken: config.googleAds.developerToken,
        customerId,
        loginCustomerId: req.session.mccId,
      };
      const ads = await googleAds.getAdCopy(restCtx);

      // Optional filters
      const campFilter = req.query.campaignName;
      const agFilter = req.query.adGroupName;
      let filtered = ads;
      if (campFilter) filtered = filtered.filter(a => a.campaignName === campFilter);
      if (agFilter) filtered = filtered.filter(a => a.adGroupName === agFilter);

      res.json({ ads: filtered, total: filtered.length });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/ads/update — Update (replace) an RSA ad
   * Body: { customerId, campaignName, adGroupName, adId, headlines, descriptions, finalUrls }
   */
  router.post('/api/ads/update', requireAuth, async (req, res, next) => {
    const { customerId, campaignName, adGroupName, adId, headlines, descriptions, finalUrls } = req.body;
    if (!customerId || !campaignName || !adGroupName || !adId) {
      return res.status(400).json({ error: 'customerId, campaignName, adGroupName, and adId are required' });
    }
    if (!headlines || !Array.isArray(headlines) || headlines.length < 3) {
      return res.status(400).json({ error: 'At least 3 headlines are required' });
    }
    if (!descriptions || !Array.isArray(descriptions) || descriptions.length < 2) {
      return res.status(400).json({ error: 'At least 2 descriptions are required' });
    }

    // Validate headline/description lengths
    for (const h of headlines) {
      if (!h.text || h.text.length > 30) return res.status(400).json({ error: `Headline "${h.text}" exceeds 30 characters` });
    }
    for (const d of descriptions) {
      if (!d.text || d.text.length > 90) return res.status(400).json({ error: `Description "${d.text}" exceeds 90 characters` });
    }

    try {
      const cleanId = customerId.replace(/-/g, '');
      const mccId = req.session.mccId || config.googleAds.mccId;
      const customer = googleAds.createClient(config.googleAds, req.session.tokens.refresh_token, cleanId, mccId);

      const result = await applyChange(customer, {
        type: 'update_rsa',
        campaignName,
        adGroupName,
        details: { adId, headlines, descriptions, finalUrls: finalUrls || [] },
      });

      changeHistory.addEntry({
        action: 'update_rsa',
        accountId: customerId,
        dealerName: campaignName,
        details: `Updated RSA ${adId} in ${adGroupName}: ${headlines.length} headlines, ${descriptions.length} descriptions`,
        source: 'ad_editor',
        success: true,
      });

      res.json({ success: true, message: result });
    } catch (err) {
      changeHistory.addEntry({
        action: 'update_rsa',
        accountId: customerId,
        dealerName: campaignName,
        details: `Failed to update RSA ${adId}: ${err.message}`,
        source: 'ad_editor',
        success: false,
        error: err.message,
      });
      next(err);
    }
  });

  return router;
}

module.exports = { createAuditRouter };
