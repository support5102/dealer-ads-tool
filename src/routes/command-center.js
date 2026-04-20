/**
 * Command Center Routes — API endpoints for the combined Task Manager + Campaign Builder.
 *
 * Called by: public/command-center.js (frontend)
 * Calls: command-center-engine.js, change-executor.js, google-ads.js
 *
 * POST /api/cc/message      — Send user message, get assistant response
 * POST /api/cc/approve      — Approve pending plan
 * POST /api/cc/execute      — Execute approved plan via Google Ads API
 * POST /api/cc/export-csv   — Export approved plan as Google Ads Editor CSV
 * GET  /api/cc/session      — Get current conversation state
 * DELETE /api/cc/session    — Clear conversation
 */

const express = require('express');
const {
  createSession, handleMessage, detectInputType,
} = require('../services/command-center-engine');
const { applyChange } = require('../services/change-executor');
const { createClient } = require('../services/google-ads');
const { logChange } = require('../services/change-history');

function createCommandCenterRouter(config = {}) {
  const router = express.Router();

  /** Ensure the session has a CC conversation object. */
  function ensureSession(req) {
    if (!req.session.ccConversation) {
      req.session.ccConversation = createSession();
    }
    return req.session.ccConversation;
  }

  /**
   * POST /api/cc/message — Main chat endpoint.
   * Body: { message: string, customerId?: string }
   */
  router.post('/message', async (req, res) => {
    try {
      const { message, customerId } = req.body;
      if (!message || !message.trim()) {
        return res.status(400).json({ error: 'Message is required' });
      }

      const session = ensureSession(req);
      const apiKey = (config.claude && config.claude.apiKey) || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'Anthropic API key not configured' });

      // Skip account structure loading for now — it's not needed for most tasks
      // and avoids potential errors in the Google Ads API call chain
      const result = await handleMessage(
        session,
        message.trim(),
        { apiKey, model: (config.claude && config.claude.model) || 'claude-sonnet-4-20250514' },
        { customerId }
      );

      res.json(result);
    } catch (err) {
      const stack = err.stack || '';
      const msg = err.message || String(err);
      console.error('[CC] Message error:', stack || msg);
      // Send file:line info to help debug
      const fileLine = stack.split('\n').find(l => l.includes('command-center') || l.includes('engine')) || '';
      res.status(500).json({ error: msg + (fileLine ? ' | at: ' + fileLine.trim() : '') });
    }
  });

  /**
   * POST /api/cc/execute — Execute the approved plan via Google Ads API.
   * Body: { customerId: string, dryRun?: boolean }
   */
  router.post('/execute', async (req, res) => {
    try {
      const session = ensureSession(req);
      const { customerId, dryRun } = req.body;

      if (!session.pendingPlan) {
        return res.status(400).json({ error: 'No plan to execute. Send messages first.' });
      }

      if (!customerId) {
        return res.status(400).json({ error: 'customerId is required for execution' });
      }

      if (!req.session.tokens) {
        return res.status(401).json({ error: 'Not authenticated with Google Ads' });
      }

      const googleAds = require('../services/google-ads');
      const client = googleAds.createClient(
        { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN },
        req.session.tokens.refresh_token,
        customerId,
        req.session.mccId
      );

      const changes = session.pendingPlan.changes || [];
      const results = [];

      for (const change of changes) {
        try {
          const msg = await applyChange(client, change, !!dryRun);
          results.push({ success: true, message: msg, change });
          // Log successful changes
          if (!dryRun) {
            logChange({
              action: change.type,
              email: req.session.userEmail || 'unknown',
              accountId: customerId,
              dealerName: session.dealerContext?.dealerName || '',
              details: change,
              source: 'command-center',
            }).catch(() => {});
          }
        } catch (err) {
          results.push({ success: false, message: err.message, change });
        }
      }

      const successCount = results.filter(r => r.success).length;
      res.json({
        results,
        summary: `${dryRun ? '[DRY RUN] ' : ''}${successCount}/${changes.length} changes ${dryRun ? 'previewed' : 'applied'} successfully`,
      });
    } catch (err) {
      console.error('[CC] Execute error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/cc/export-csv — Export the approved plan as Google Ads Editor CSV.
   * Body: { }
   */
  router.post('/export-csv', async (req, res) => {
    try {
      const session = ensureSession(req);
      if (!session.pendingPlan) {
        return res.status(400).json({ error: 'No plan to export' });
      }

      const plan = session.pendingPlan;
      const changes = plan.changes || (Array.isArray(plan) ? plan : []);

      // Normalize changes — Claude may use inconsistent field names
      // Detect type from content if type field is missing/wrong
      function normalizeChange(c) {
        if (!c || typeof c !== 'object') return null;
        const n = { ...c };
        // Normalize field names
        n.campaignName = c.campaignName || c.campaign || c.campaign_name || '';
        n.adGroupName = c.adGroupName || c.adGroup || c.ad_group || c.ad_group_name || '';
        n.keyword = c.keyword || (c.details && c.details.keyword) || '';
        n.matchType = c.matchType || c.match_type || (c.details && c.details.matchType) || '';
        n.headlines = c.headlines || (c.details && c.details.headlines) || [];
        n.descriptions = c.descriptions || (c.details && c.details.descriptions) || [];
        n.finalUrl = c.finalUrl || c.final_url || c.url || (c.details && c.details.finalUrl) || '';
        n.budgetName = c.budgetName || c.budget_name || (c.details && c.details.budgetName) || '';
        n.budgetAmount = c.budgetAmount || c.budget || (c.details && c.details.budgetAmount) || '';
        n.defaultCpc = c.defaultCpc || c.cpc || c.max_cpc || (c.details && c.details.defaultCpc) || '';
        n.path1 = c.path1 || (c.details && c.details.path1) || '';
        n.path2 = c.path2 || (c.details && c.details.path2) || '';
        // Auto-detect type from content if missing
        const t = (c.type || c.action || '').toLowerCase().replace(/[\s_-]+/g, '_');
        if (t.includes('campaign') && !t.includes('ad_group') && !t.includes('keyword') && !t.includes('rsa') && !t.includes('ad_cop') && !t.includes('negative')) n.type = 'create_campaign';
        else if (t.includes('ad_group') || t.includes('adgroup')) n.type = 'create_ad_group';
        else if (t.includes('negative')) n.type = 'add_negative';
        else if (t.includes('keyword') && !t.includes('negative')) n.type = 'add_keyword';
        else if (t.includes('rsa') || t.includes('ad_cop') || t.includes('ad_creation') || (n.headlines.length > 0)) n.type = 'create_rsa';
        else if (t.includes('location') || c.lat || c.radius) n.type = 'set_location';
        else if (t.includes('pause')) n.type = 'pause_campaign';
        else if (t.includes('enable')) n.type = 'enable_campaign';
        else n.type = c.type || 'unknown';
        return n;
      }

      const { blankAdsRow, buildAdsCSV } = require('../../public/csv-utils');
      const rows = [];
      const seenCampaigns = new Set();
      const seenAdGroups = new Set();

      for (const raw of changes) {
        const c = normalizeChange(raw);
        if (!c) continue;

        if (c.type === 'create_campaign' && !seenCampaigns.has(c.campaignName)) {
          seenCampaigns.add(c.campaignName);
          const r = blankAdsRow();
          r['Campaign'] = c.campaignName;
          r['Campaign Type'] = 'Search';
          r['Networks'] = 'Google search;Search Partners';
          r['Budget name'] = c.budgetName || 'Main';
          r['Budget'] = String(c.budgetAmount || 20);
          r['Budget type'] = 'Daily';
          r['EU political ads'] = "Doesn't have EU political ads";
          r['Standard conversion goals'] = 'Account-level';
          r['Customer acquisition'] = 'Bid equally';
          r['Languages'] = 'en';
          r['Bid Strategy Type'] = 'Manual CPC';
          r['Enhanced CPC'] = 'Disabled';
          r['Broad match keywords'] = 'Off';
          r['Ad rotation'] = 'Optimize for clicks';
          r['Targeting method'] = 'Location of presence';
          r['Exclusion method'] = 'Location of presence';
          r['Google Merchant Center feed'] = 'Enabled';
          r['Campaign Priority'] = 'Low';
          r['Local Inventory Ads'] = 'Disabled';
          r['Shopping ads on excluded brands'] = 'Disabled';
          r['Inventory filter'] = '*';
          r['Audience targeting'] = 'Audience segments';
          r['Flexible Reach'] = 'Audience segments';
          r['AI Max'] = 'Disabled';
          r['Text customization'] = 'Disabled';
          r['Final URL expansion'] = 'Disabled';
          r['Image enhancement'] = 'Disabled';
          r['Image generation'] = 'Disabled';
          r['Landing page images'] = 'Disabled';
          r['Video enhancement'] = 'Disabled';
          r['Brand guidelines'] = 'Disabled';
          r['Campaign Status'] = c.status || 'Enabled';
          r['Start Date'] = new Date().toISOString().slice(0, 10);
          r['Ad Schedule'] = '(Monday[08:30-19:00]);(Tuesday[08:30-19:00]);(Wednesday[08:30-19:00]);(Thursday[08:30-19:00]);(Friday[08:30-19:00]);(Saturday[08:30-20:30])';
          rows.push(r);

        } else if (c.type === 'create_ad_group') {
          const agKey = c.campaignName + '|' + c.adGroupName;
          if (!seenAdGroups.has(agKey)) {
            seenAdGroups.add(agKey);
            const r = blankAdsRow();
            r['Campaign'] = c.campaignName;
            r['Ad Group'] = c.adGroupName;
            r['Max CPC'] = String(c.defaultCpc || 9);
            r['Languages'] = 'All';
            r['Audience targeting'] = 'Audience segments';
            r['Flexible Reach'] = 'Audience segments;Genders;Ages;Parental status;Household incomes';
            r['Max CPM'] = '0.01';
            r['Target CPV'] = '0.01';
            r['Target CPM'] = '0.01';
            r['Optimized targeting'] = 'Disabled';
            r['Strict age and gender targeting'] = 'Disabled';
            r['Search term matching'] = 'Enabled';
            r['Ad Group Type'] = 'Standard';
            r['Campaign Status'] = 'Enabled';
            r['Ad Group Status'] = 'Enabled';
            rows.push(r);
          }

        } else if (c.type === 'add_keyword') {
          const r = blankAdsRow();
          r['Campaign'] = c.campaignName;
          r['Ad Group'] = c.adGroupName;
          r['Keyword'] = c.keyword;
          r['Criterion Type'] = c.matchType || 'Exact';
          // NEVER set Max CPC on keyword rows
          r['Campaign Status'] = 'Enabled';
          r['Ad Group Status'] = 'Enabled';
          r['Status'] = 'Enabled';
          rows.push(r);

        } else if (c.type === 'add_negative') {
          const r = blankAdsRow();
          r['Campaign'] = c.campaignName;
          r['Ad Group'] = c.adGroupName;
          r['Keyword'] = c.keyword;
          r['Criterion Type'] = c.matchType || 'Negative Phrase';
          rows.push(r);

        } else if (c.type === 'create_rsa') {
          const r = blankAdsRow();
          r['Campaign'] = c.campaignName;
          r['Ad Group'] = c.adGroupName;
          const hl = c.headlines || [];
          const ds = c.descriptions || [];
          for (let i = 0; i < Math.min(hl.length, 15); i++) {
            const h = String(typeof hl[i] === 'object' ? (hl[i].text || '') : (hl[i] || ''));
            r['Headline ' + (i + 1)] = h.slice(0, 30);
            r['Headline ' + (i + 1) + ' position'] = '-';
          }
          // Fill remaining headline positions with unpinned
          for (let i = hl.length; i < 15; i++) { r['Headline ' + (i + 1) + ' position'] = '-'; }
          for (let i = 0; i < Math.min(ds.length, 4); i++) {
            const d = String(typeof ds[i] === 'object' ? (ds[i].text || '') : (ds[i] || ''));
            r['Description ' + (i + 1)] = d.slice(0, 90);
            r['Description ' + (i + 1) + ' position'] = '-';
          }
          for (let i = ds.length; i < 4; i++) { r['Description ' + (i + 1) + ' position'] = '-'; }
          r['Final URL'] = c.finalUrl;
          r['Path 1'] = (c.path1 || '').slice(0, 15);
          r['Path 2'] = (c.path2 || '').slice(0, 15);
          r['Ad type'] = 'Responsive search ad';
          r['Campaign Status'] = 'Enabled';
          r['Ad Group Status'] = 'Enabled';
          r['Status'] = 'Enabled';
          rows.push(r);

        } else if (c.type === 'set_location' && (c.lat || c.radius)) {
          const r = blankAdsRow();
          r['Campaign'] = c.campaignName;
          r['Location'] = '(' + (c.radius || 20) + 'mi:' + Number(c.lat || 0).toFixed(6) + ':' + Number(c.lng || 0).toFixed(6) + ')';
          r['Radius'] = String(c.radius || 20);
          r['Unit'] = 'mi';
          r['Campaign Status'] = 'Enabled';
          r['Status'] = 'Enabled';
          rows.push(r);

        } else if (c.type === 'pause_campaign' || c.type === 'enable_campaign') {
          const r = blankAdsRow();
          r['Campaign'] = c.campaignName;
          r['Campaign Status'] = c.type === 'pause_campaign' ? 'Paused' : 'Enabled';
          rows.push(r);

        } else {
          // Last resort — try to extract useful data from any fields
          const r = blankAdsRow();
          r['Campaign'] = c.campaignName;
          if (c.adGroupName) r['Ad Group'] = c.adGroupName;
          if (c.keyword) { r['Keyword'] = c.keyword; r['Criterion Type'] = c.matchType || 'Exact'; r['Status'] = 'Enabled'; }
          if (c.headlines && c.headlines.length) {
            for (let i = 0; i < Math.min(c.headlines.length, 15); i++) {
              r['Headline ' + (i + 1)] = String(c.headlines[i] || '').slice(0, 30);
              r['Headline ' + (i + 1) + ' position'] = '-';
            }
            r['Ad type'] = 'Responsive search ad';
          }
          rows.push(r);
        }
      }

      if (!rows.length) {
        return res.status(400).json({ error: 'No exportable changes in plan' });
      }

      const csv = buildAdsCSV(rows);
      const dealerName = session.dealerContext?.dealerName || 'account';
      res.json({
        csv,
        filename: dealerName.replace(/\s+/g, '_') + '_changes.csv',
        rowCount: rows.length,
      });
    } catch (err) {
      console.error('[CC] CSV export error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/cc/session — Get current conversation state.
   */
  router.get('/session', (req, res) => {
    const session = ensureSession(req);
    res.json({
      mode: session.detectedMode,
      messageCount: session.messages.length,
      hasPlan: !!session.pendingPlan,
      hasQuestions: session.pendingQuestions.length > 0,
      dealerContext: session.dealerContext,
      customerId: session.customerId,
    });
  });

  /**
   * DELETE /api/cc/session — Clear conversation and start fresh.
   */
  router.delete('/session', (req, res) => {
    req.session.ccConversation = createSession();
    res.json({ cleared: true });
  });

  return router;
}

module.exports = { createCommandCenterRouter };
