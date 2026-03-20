/**
 * Optimization Routes — CPC optimization, IS-based budgets, budget management, rec dismissal.
 *
 * Called by: src/server.js (mounted at /api/*)
 * Calls: services/cpc-optimizer.js, services/impression-share-optimizer.js,
 *        services/budget-manager.js, services/recommendation-dismisser.js,
 *        services/google-ads.js
 *
 * Routes:
 *   POST /api/optimize/cpc/:customerId           → Analyze CPC optimization opportunities
 *   POST /api/optimize/impression-share/:customerId → IS-based budget recommendations
 *   POST /api/optimize/budgets/:customerId        → Budget split analysis + rebalance
 *   POST /api/recommendations/classify/:customerId → Classify recs for dismiss vs review
 *   POST /api/recommendations/dismiss/:customerId  → Execute dismissals
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const googleAds = require('../services/google-ads');
const { analyzeCpcOpportunities, generateBidAdjustments } = require('../services/cpc-optimizer');
const { analyzeImpressionShare, generateBudgetChanges } = require('../services/impression-share-optimizer');
const { checkBudgetSplits, detectSharedBudgetContention, generateBudgetRebalance } = require('../services/budget-manager');
const { classifyRecommendations } = require('../services/recommendation-dismisser');

/**
 * Validates customerId from route params. Returns cleaned ID or sends 400 error.
 * @param {string} raw - Raw customerId from params
 * @param {Object} res - Express response
 * @returns {string|null} Cleaned ID or null if invalid (response already sent)
 */
function validateCustomerId(raw, res) {
  if (!raw) {
    res.status(400).json({ error: 'Missing customerId parameter.' });
    return null;
  }
  const cleanId = raw.replace(/-/g, '');
  if (!/^\d{7,10}$/.test(cleanId)) {
    res.status(400).json({ error: 'Invalid customerId format. Expected 7-10 digit Google Ads ID.' });
    return null;
  }
  return cleanId;
}

/**
 * Builds a REST context from the request session.
 * @param {Object} req - Express request
 * @param {Object} config - App config
 * @param {string} cleanId - Validated customer ID
 * @returns {Promise<Object>} restCtx for GAQL queries
 */
async function buildRestCtx(req, config, cleanId) {
  const mccId = req.session.mccId || config.googleAds.mccId;
  const accessToken = await googleAds.refreshAccessToken(
    config.googleAds,
    req.session.tokens.refresh_token
  );
  req.session.tokens.access_token = accessToken;
  return {
    accessToken,
    developerToken: config.googleAds.developerToken,
    customerId: cleanId,
    loginCustomerId: mccId,
  };
}

/**
 * Creates optimization routes.
 *
 * @param {Object} config - App configuration from config.js
 * @returns {express.Router} Configured optimization router
 */
function createOptimizationRouter(config) {
  const router = express.Router();

  /**
   * POST /api/optimize/cpc/:customerId
   * Analyzes keyword CPC vs IS to find bid optimization opportunities.
   */
  router.post('/api/optimize/cpc/:customerId', requireAuth, async (req, res, next) => {
    const cleanId = validateCustomerId(req.params.customerId, res);
    if (!cleanId) return;

    try {
      const restCtx = await buildRestCtx(req, config, cleanId);
      const keywords = await googleAds.getKeywordPerformance(restCtx);
      const opportunities = analyzeCpcOpportunities(keywords);
      const adjustments = generateBidAdjustments(opportunities);

      res.json({
        accountId: cleanId,
        totalKeywordsAnalyzed: keywords.length,
        opportunities: opportunities.length,
        adjustments,
        summary: {
          decreases: adjustments.filter(a => a.action === 'decrease').length,
          increases: adjustments.filter(a => a.action === 'increase').length,
          totalSavings: adjustments
            .filter(a => a.change < 0)
            .reduce((sum, a) => sum + Math.abs(a.change), 0),
        },
      });
    } catch (err) {
      console.error('CPC optimization error:', err.message);
      next(err);
    }
  });

  /**
   * POST /api/optimize/impression-share/:customerId
   * Recommends budget changes based on impression share performance.
   */
  router.post('/api/optimize/impression-share/:customerId', requireAuth, async (req, res, next) => {
    const cleanId = validateCustomerId(req.params.customerId, res);
    if (!cleanId) return;

    try {
      const restCtx = await buildRestCtx(req, config, cleanId);
      const [isData, budgets] = await Promise.all([
        googleAds.getImpressionShare(restCtx),
        googleAds.getDedicatedBudgets(restCtx),
      ]);

      const findings = analyzeImpressionShare(isData);
      const changes = generateBudgetChanges(findings, budgets);

      res.json({
        accountId: cleanId,
        campaignsAnalyzed: isData.length,
        findings: findings.length,
        budgetChanges: changes,
        summary: {
          increases: changes.filter(c => c.action === 'increase_budget').length,
          decreases: changes.filter(c => c.action === 'decrease_budget').length,
        },
      });
    } catch (err) {
      console.error('IS optimization error:', err.message);
      next(err);
    }
  });

  /**
   * POST /api/optimize/budgets/:customerId
   * Analyzes budget splits and shared budget health.
   */
  router.post('/api/optimize/budgets/:customerId', requireAuth, async (req, res, next) => {
    const cleanId = validateCustomerId(req.params.customerId, res);
    if (!cleanId) return;

    try {
      const restCtx = await buildRestCtx(req, config, cleanId);
      const [dedicated, shared] = await Promise.all([
        googleAds.getDedicatedBudgets(restCtx),
        googleAds.getSharedBudgets(restCtx),
      ]);

      const splitFindings = checkBudgetSplits(dedicated);
      const contentionFindings = detectSharedBudgetContention(shared);
      const rebalance = generateBudgetRebalance(dedicated);

      res.json({
        accountId: cleanId,
        dedicatedBudgets: dedicated.length,
        sharedBudgets: shared.length,
        splitFindings,
        contentionFindings,
        rebalanceSuggestions: rebalance,
      });
    } catch (err) {
      console.error('Budget analysis error:', err.message);
      next(err);
    }
  });

  /**
   * POST /api/recommendations/classify/:customerId
   * Fetches and classifies recommendations into dismiss vs review queues.
   */
  router.post('/api/recommendations/classify/:customerId', requireAuth, async (req, res, next) => {
    const cleanId = validateCustomerId(req.params.customerId, res);
    if (!cleanId) return;

    try {
      const restCtx = await buildRestCtx(req, config, cleanId);
      const recommendations = await googleAds.getRecommendations(restCtx);
      const { toDismiss, toReview } = classifyRecommendations(recommendations);

      res.json({
        accountId: cleanId,
        totalRecommendations: recommendations.length,
        toDismiss,
        toReview,
        summary: {
          autoDismiss: toDismiss.length,
          needsReview: toReview.length,
        },
      });
    } catch (err) {
      console.error('Recommendation classification error:', err.message);
      next(err);
    }
  });

  return router;
}

module.exports = { createOptimizationRouter };
