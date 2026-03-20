/**
 * Deep Scanner — comprehensive account health scan combining audit engine
 * checks with negative keyword analysis and ad copy analysis.
 *
 * Called by: routes/audit.js (POST /api/deep-scan)
 * Calls: audit-engine, negative-keyword-analyzer, ad-copy-analyzer, google-ads
 */

const googleAds = require('./google-ads');
const { runAudit } = require('./audit-engine');
const { analyzeNegativeConflicts, analyzeCannibalization, analyzeTrafficSculpting } = require('./negative-keyword-analyzer');
const { checkStaleYearReferences, checkMissingRSAs, checkHeadlineQuality, checkPinningOveruse } = require('./ad-copy-analyzer');

/**
 * Runs a comprehensive deep scan on one Google Ads account.
 * Combines the standard audit engine (11 checks) with negative keyword
 * analysis and ad copy analysis for a unified findings list.
 *
 * @param {Object} restCtx - REST context { accessToken, developerToken, customerId, loginCustomerId }
 * @returns {Promise<Object>} Deep scan result with findings, summary, checksRun
 */
async function runDeepScan(restCtx) {
  // Step 1: Run existing audit engine (11 checks)
  const auditResult = await runAudit(restCtx);

  // Step 2: Fetch additional data for deep analysis
  const [campaignNegatives, adGroupAdCounts, keywords, ads] = await Promise.all([
    googleAds.getCampaignNegatives(restCtx).catch(() => []),
    googleAds.getAdGroupAdCounts(restCtx).catch(() => []),
    googleAds.getKeywordPerformance(restCtx).catch(() => []),
    googleAds.getAdCopy(restCtx).catch(() => []),
  ]);

  // Step 3: Run negative keyword analysis
  const negFindings = [
    ...analyzeNegativeConflicts(keywords, campaignNegatives),
    ...analyzeCannibalization(keywords),
    ...analyzeTrafficSculpting(keywords, campaignNegatives,
      [...new Set(keywords.map(k => k.campaignName).filter(Boolean))]),
  ];

  // Step 4: Run ad copy analysis
  // Build ad groups list from adGroupAdCounts for RSA check
  const adGroups = adGroupAdCounts.map(ag => ({
    name: ag.adGroupName,
    campaignName: ag.campaignName,
    status: 'ENABLED', // query already filters to enabled
  }));

  const adFindings = [
    ...checkStaleYearReferences(ads),
    ...checkMissingRSAs(ads, adGroups),
    ...checkHeadlineQuality(ads),
    ...checkPinningOveruse(ads),
  ];

  // Step 5: Merge all findings
  const allFindings = [
    ...auditResult.findings,
    ...negFindings,
    ...adFindings,
  ];

  // Rebuild summary
  const summary = {
    total: allFindings.length,
    critical: allFindings.filter(f => f.severity === 'critical').length,
    warning: allFindings.filter(f => f.severity === 'warning').length,
    info: allFindings.filter(f => f.severity === 'info').length,
  };

  return {
    findings: allFindings,
    summary,
    ranAt: new Date().toISOString(),
    accountId: restCtx.customerId,
    scanType: 'deep',
    checksRun: [
      ...auditResult.checksRun,
      'negative_conflicts', 'cannibalization', 'traffic_sculpting',
      'stale_year_references', 'missing_rsas', 'headline_quality', 'pinning_overuse',
    ],
  };
}

module.exports = { runDeepScan };
