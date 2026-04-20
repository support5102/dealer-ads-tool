/**
 * Audit Engine — runs health checks against a Google Ads account.
 *
 * Called by: routes/audit.js (POST /api/audit/run)
 * Calls: services/google-ads.js (GAQL queries via restCtx)
 *
 * Each check function inspects one aspect of the account and returns
 * an array of findings. The engine aggregates all findings into a
 * single audit result with severity counts and metadata.
 *
 * Check categories:
 *   - bidding:    Manual CPC enforcement, no Broad match
 *   - budget:     Overspend / underspend detection
 *   - keywords:   Zero-impression keywords, missing negatives
 *   - ads:        Disapproved ads, stale copy
 *   - campaigns:  Paused campaigns still consuming budget, naming issues
 *   - pmax:       VLA-specific checks (no creative assets leaking)
 */

const googleAds = require('./google-ads');
const {
  checkStaleYearReferences,
  checkMissingRSAs,
  checkHeadlineQuality,
  checkPinningOveruse,
} = require('./ad-copy-analyzer');
const dealerContextStore = require('./dealer-context-store');
const { classifyCampaign } = require('./campaign-classifier');
const {
  analyzeNegativeConflicts,
  analyzeCannibalization,
  analyzeTrafficSculpting,
  analyzeIrrelevantSearchTerms,
  analyzeBlockedConvertingTerms,
} = require('./negative-keyword-analyzer');

// ── Severity levels ──
const SEVERITY = {
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info',
};

// ── Finding builder ──
function finding(checkId, severity, category, title, message, details = {}) {
  return { checkId, severity, category, title, message, details };
}

// ─────────────────────────────────────────────────────────────
// Individual audit checks
// Each returns an array of findings (empty = passed)
// ─────────────────────────────────────────────────────────────

/**
 * Check 1: Campaigns using non-Manual-CPC bidding on Search.
 * Strategy rule: all Search campaigns must use Manual CPC, ECPC disabled.
 */
function checkBiddingStrategy(campaigns) {
  const findings = [];
  for (const c of campaigns) {
    if (c.status !== 'ENABLED') continue;
    if (c.channelType !== 'SEARCH') continue;

    // Google Ads returns bidding strategy as e.g. "MANUAL_CPC", "TARGET_CPA", etc.
    const strategy = (c.biddingStrategy || '').toUpperCase();
    if (strategy && strategy !== 'MANUAL_CPC') {
      findings.push(finding(
        'bidding_not_manual_cpc',
        SEVERITY.CRITICAL,
        'bidding',
        'Search campaign not using Manual CPC',
        `"${c.campaignName}" is using ${c.biddingStrategy} instead of Manual CPC.`,
        { campaignId: c.campaignId, campaignName: c.campaignName, currentStrategy: c.biddingStrategy }
      ));
    } else if (strategy === 'MANUAL_CPC' && c.ecpcEnabled) {
      findings.push(finding(
        'ecpc_enabled',
        SEVERITY.WARNING,
        'bidding',
        'Enhanced CPC is enabled',
        `"${c.campaignName}" has Enhanced CPC enabled. Strategy requires ECPC disabled for full bid control.`,
        { campaignId: c.campaignId, campaignName: c.campaignName }
      ));
    }
  }
  return findings;
}

/**
 * Check 2: Keywords using Broad match.
 * Strategy rule: Exact + Phrase only, never Broad.
 */
function checkBroadMatchKeywords(keywords) {
  const findings = [];
  const broadKeywords = keywords.filter(
    k => k.matchType === 'BROAD' && !k.negative && k.status === 'ENABLED'
  );

  if (broadKeywords.length > 0) {
    // Group by campaign for readability
    const byCampaign = {};
    for (const k of broadKeywords) {
      const name = k.campaignName || 'Unknown';
      if (!byCampaign[name]) byCampaign[name] = [];
      byCampaign[name].push(k.keyword);
    }

    findings.push(finding(
      'broad_match_keywords',
      SEVERITY.CRITICAL,
      'keywords',
      `${broadKeywords.length} Broad match keyword(s) found`,
      'Strategy requires Exact + Phrase match only. Broad match wastes budget on irrelevant searches.',
      { count: broadKeywords.length, byCampaign }
    ));
  }
  return findings;
}

/**
 * Check 3: Zero-impression keywords (last 7 days).
 * Keywords getting 0 impressions may be restricted, paused at ad group level, or irrelevant.
 */
function checkZeroImpressionKeywords(keywords) {
  const findings = [];
  const zeroImp = keywords.filter(
    k => k.status === 'ENABLED' && !k.negative && k.impressions === 0
  );

  if (zeroImp.length > 5) {
    findings.push(finding(
      'zero_impression_keywords',
      SEVERITY.WARNING,
      'keywords',
      `${zeroImp.length} enabled keywords with 0 impressions (7 days)`,
      'These keywords may have quality issues, be restricted, or their ad groups may be paused.',
      { count: zeroImp.length, sample: zeroImp.slice(0, 10).map(k => ({
        keyword: k.keyword, matchType: k.matchType, campaign: k.campaignName, adGroup: k.adGroupName
      }))}
    ));
  }
  return findings;
}

/**
 * Check 4: Disapproved or policy-limited ads.
 */
function checkDisapprovedAds(ads) {
  const findings = [];
  const disapproved = ads.filter(a =>
    a.approvalStatus === 'DISAPPROVED' || a.approvalStatus === 'AREA_OF_INTEREST_ONLY'
  );
  const limited = ads.filter(a =>
    a.approvalStatus === 'APPROVED_LIMITED'
  );

  if (disapproved.length > 0) {
    findings.push(finding(
      'disapproved_ads',
      SEVERITY.CRITICAL,
      'ads',
      `${disapproved.length} disapproved ad(s)`,
      'These ads are not running. Review policy violations and fix or replace.',
      { count: disapproved.length, ads: disapproved.slice(0, 5).map(a => ({
        adId: a.adId, campaign: a.campaignName, adGroup: a.adGroupName,
        status: a.approvalStatus, policies: a.policyTopics
      }))}
    ));
  }

  if (limited.length > 0) {
    findings.push(finding(
      'limited_ads',
      SEVERITY.WARNING,
      'ads',
      `${limited.length} ad(s) with limited approval`,
      'These ads run but with restrictions. Check policy topics.',
      { count: limited.length, ads: limited.slice(0, 5).map(a => ({
        adId: a.adId, campaign: a.campaignName, adGroup: a.adGroupName,
        policies: a.policyTopics
      }))}
    ));
  }
  return findings;
}

/**
 * Check 5: High CPC keywords (above strategy thresholds).
 * Flags keywords with average CPC above the expected range for their campaign type.
 */
function checkHighCpc(keywords) {
  const findings = [];
  // Use $15 as universal ceiling (competitor campaigns can go this high)
  const CPC_CEILING = 15;

  const highCpc = keywords.filter(
    k => k.status === 'ENABLED' && !k.negative && k.averageCpc > CPC_CEILING && k.clicks > 0
  );

  if (highCpc.length > 0) {
    findings.push(finding(
      'high_cpc_keywords',
      SEVERITY.WARNING,
      'bidding',
      `${highCpc.length} keyword(s) with CPC above $${CPC_CEILING}`,
      'These keywords have unusually high CPCs. Review bids and consider lowering or pausing.',
      { count: highCpc.length, keywords: highCpc.slice(0, 10).map(k => ({
        keyword: k.keyword, matchType: k.matchType, campaign: k.campaignName,
        averageCpc: k.averageCpc, clicks: k.clicks
      }))}
    ));
  }
  return findings;
}

/**
 * Check 6: Low CTR campaigns (below 2% on Search).
 * Low CTR indicates ad copy or targeting issues.
 */
function checkLowCtrCampaigns(campaigns) {
  const findings = [];
  const CTR_THRESHOLD = 0.02; // 2%

  const lowCtr = campaigns.filter(
    c => c.status === 'ENABLED' && c.channelType === 'SEARCH' &&
         c.impressions > 100 && c.ctr < CTR_THRESHOLD
  );

  if (lowCtr.length > 0) {
    findings.push(finding(
      'low_ctr_campaigns',
      SEVERITY.WARNING,
      'campaigns',
      `${lowCtr.length} Search campaign(s) with CTR below ${CTR_THRESHOLD * 100}%`,
      'Low CTR wastes impression share. Review ad copy relevance and keyword targeting.',
      { count: lowCtr.length, campaigns: lowCtr.map(c => ({
        campaignName: c.campaignName, ctr: c.ctr, impressions: c.impressions, clicks: c.clicks
      }))}
    ));
  }
  return findings;
}

/**
 * Check 7: Pending recommendations not dismissed.
 * Google Partner status requires dismissing or applying recommendations.
 */
function checkPendingRecommendations(recommendations) {
  const findings = [];

  if (recommendations.length > 10) {
    findings.push(finding(
      'pending_recommendations',
      SEVERITY.WARNING,
      'hygiene',
      `${recommendations.length} pending Google Ads recommendations`,
      'Dismiss or apply recommendations to maintain Google Partner status. High counts can lower optimization score.',
      { count: recommendations.length, types: [...new Set(recommendations.map(r => r.type))] }
    ));
  }
  return findings;
}

/**
 * Check 8: Campaigns with no ad schedule (running 24/7).
 * Strategy guide recommends ad scheduling for Search campaigns.
 */
function checkMissingAdSchedules(campaigns, adSchedules) {
  const findings = [];

  // Build set of campaign IDs that have schedules
  const scheduledCampaigns = new Set(adSchedules.map(s => s.campaignId));

  const searchCampaigns = campaigns.filter(
    c => c.status === 'ENABLED' && c.channelType === 'SEARCH'
  );

  const unscheduled = searchCampaigns.filter(c => !scheduledCampaigns.has(c.campaignId));

  if (unscheduled.length > 0 && adSchedules.length > 0) {
    // Only flag if SOME campaigns have schedules (mixed state = likely oversight)
    findings.push(finding(
      'missing_ad_schedule',
      SEVERITY.INFO,
      'campaigns',
      `${unscheduled.length} Search campaign(s) without ad schedules`,
      'Some campaigns have ad schedules but these do not. This may be intentional or an oversight.',
      { count: unscheduled.length, campaigns: unscheduled.slice(0, 10).map(c => c.campaignName) }
    ));
  }
  return findings;
}

/**
 * Check 9: Enabled campaigns with zero spend (7 days).
 * May indicate paused ad groups, no keywords, or billing issues.
 */
function checkZeroSpendCampaigns(campaigns) {
  const findings = [];

  const zeroSpend = campaigns.filter(
    c => c.status === 'ENABLED' && c.cost === 0 && c.impressions === 0
  );

  if (zeroSpend.length > 0) {
    findings.push(finding(
      'zero_spend_campaigns',
      SEVERITY.WARNING,
      'campaigns',
      `${zeroSpend.length} enabled campaign(s) with zero spend/impressions (7 days)`,
      'These campaigns are enabled but not serving. Check keywords, ad groups, billing, or policy status.',
      { count: zeroSpend.length, campaigns: zeroSpend.map(c => ({
        campaignName: c.campaignName, channelType: c.channelType
      }))}
    ));
  }
  return findings;
}

/**
 * Check 10: Campaign naming convention violations.
 * Strategy requires: "{Dealer Name} - {Category}" or "PMax: VLA Ads - {Segment}"
 */
function checkNamingConventions(campaigns) {
  const findings = [];
  const violations = [];

  for (const c of campaigns) {
    if (c.status !== 'ENABLED') continue;
    const name = c.campaignName || '';

    // PMax campaigns should start with "PMax:"
    if (c.channelType === 'PERFORMANCE_MAX' && !name.startsWith('PMax:')) {
      violations.push({ campaignName: name, issue: 'PMax campaign not prefixed with "PMax:"' });
    }

    // Search campaigns should use " - " separator
    if (c.channelType === 'SEARCH' && !name.includes(' - ')) {
      violations.push({ campaignName: name, issue: 'Missing " - " separator in campaign name' });
    }
  }

  if (violations.length > 0) {
    findings.push(finding(
      'naming_convention_violations',
      SEVERITY.INFO,
      'hygiene',
      `${violations.length} campaign naming convention issue(s)`,
      'Consistent naming helps with reporting and automation.',
      { count: violations.length, violations: violations.slice(0, 10) }
    ));
  }
  return findings;
}

/**
 * Check 11: Low impression share on Search campaigns.
 * Strategy target is 75-90% IS. Below 75% = warning, below 50% = critical.
 */
function checkLowImpressionShare(campaigns) {
  const findings = [];
  const IS_WARNING = 0.75;
  const IS_CRITICAL = 0.50;

  const lowIS = campaigns.filter(
    c => c.status === 'ENABLED' && c.channelType === 'SEARCH' &&
         c.searchImpressionShare != null && c.impressions > 100 &&
         c.searchImpressionShare < IS_WARNING
  );

  if (lowIS.length === 0) return findings;

  const critical = lowIS.filter(c => c.searchImpressionShare < IS_CRITICAL);
  const warning = lowIS.filter(c => c.searchImpressionShare >= IS_CRITICAL);

  if (critical.length > 0) {
    findings.push(finding(
      'low_impression_share_critical',
      SEVERITY.CRITICAL,
      'budget',
      `${critical.length} campaign(s) below 50% impression share`,
      'These campaigns are missing more than half of available impressions. Increase budgets or reduce targeting.',
      { count: critical.length, campaigns: critical.map(c => ({
        campaignName: c.campaignName, impressionShare: Math.round(c.searchImpressionShare * 100) + '%'
      }))}
    ));
  }

  if (warning.length > 0) {
    findings.push(finding(
      'low_impression_share_warning',
      SEVERITY.WARNING,
      'budget',
      `${warning.length} campaign(s) below 75% impression share target`,
      'Strategy target is 75-90% IS. Consider budget increases for these campaigns.',
      { count: warning.length, campaigns: warning.map(c => ({
        campaignName: c.campaignName, impressionShare: Math.round(c.searchImpressionShare * 100) + '%'
      }))}
    ));
  }

  return findings;
}

/**
 * Check: Dealer context constraint violations.
 * Flags campaigns whose budgets violate dealer-specified floors or ceilings.
 */
function checkDealerContextViolations(campaigns, accountId) {
  const findings = [];
  const ctx = dealerContextStore.getContext(accountId);
  if (!ctx || !ctx.budgetConstraints || ctx.budgetConstraints.length === 0) return findings;

  const violations = [];

  for (const c of campaigns) {
    if (c.status !== 'ENABLED') continue;
    const campaignType = classifyCampaign(c.campaignName);

    for (const constraint of ctx.budgetConstraints) {
      const matches = (constraint.scope === 'account') ||
        (constraint.scope === 'campaign_type' && campaignType === constraint.target) ||
        (constraint.scope === 'campaign_name' && c.campaignName.toLowerCase().includes(constraint.target.toLowerCase()));
      if (!matches) continue;

      // Note: campaign performance data has cost (7-day total), not daily budget.
      // We can approximate daily budget from cost/7 but this is imprecise.
      // For a more accurate check, we'd need getDedicatedBudgets data.
      // For now, flag based on daily spend rate vs constraint.
      const dailySpend = c.cost != null ? c.cost / 7 : null;
      if (dailySpend == null) continue;

      const amount = constraint.unit === 'daily' ? constraint.amount : constraint.amount / 30;

      if (constraint.constraint === 'floor' && dailySpend < amount * 0.8) {
        violations.push({
          campaignName: c.campaignName,
          constraint: `floor $${amount.toFixed(2)}/day`,
          currentSpend: `$${dailySpend.toFixed(2)}/day`,
          note: constraint.note,
        });
      }
      if (constraint.constraint === 'ceiling' && dailySpend > amount * 1.2) {
        violations.push({
          campaignName: c.campaignName,
          constraint: `ceiling $${amount.toFixed(2)}/day`,
          currentSpend: `$${dailySpend.toFixed(2)}/day`,
          note: constraint.note,
        });
      }
    }
  }

  if (violations.length > 0) {
    findings.push(finding(
      'dealer_context_violations',
      SEVERITY.WARNING,
      'dealer_context',
      `${violations.length} campaign(s) violating dealer-specified budget constraints`,
      'These campaigns are outside the budget range specified in dealer notes.',
      { violations }
    ));
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────
// Main audit runner
// ─────────────────────────────────────────────────────────────

/**
 * Runs all audit checks against a single Google Ads account.
 *
 * @param {Object} restCtx - REST context { accessToken, developerToken, customerId, loginCustomerId }
 * @param {Object} [options] - { checks: string[] } to run only specific checks
 * @returns {Promise<Object>} { findings, summary: { total, critical, warning, info }, ranAt, accountId }
 */
async function runAudit(restCtx, options = {}) {
  // Whitelist selected checks against known check names
  const VALID_CHECKS = [
    'bidding_strategy', 'broad_match', 'zero_impressions', 'disapproved_ads',
    'high_cpc', 'low_ctr', 'recommendations', 'ad_schedules', 'zero_spend',
    'low_impression_share',
    'stale_years', 'missing_rsas', 'headline_quality', 'pinning',
    'neg_conflicts', 'neg_cannibalization', 'traffic_sculpting',
    'irrelevant_search_terms', 'blocked_converting_terms',
    'dealer_context',
  ];
  const selectedChecks = options.checks
    ? options.checks.filter(c => VALID_CHECKS.includes(c))
    : null; // null = all

  // Fetch all data in parallel (non-fatal for optional queries)
  const [keywords, campaigns, ads, recommendations, adSchedules, adGroupAdCounts, campaignNegatives, searchTerms] = await Promise.all([
    googleAds.getKeywordPerformance(restCtx).catch(err => {
      console.error('Audit keyword query failed:', err.message);
      return [finding('query_error', SEVERITY.WARNING, 'system', 'Keyword query failed', 'Keyword data could not be loaded. Check account permissions.')];
    }),
    googleAds.getCampaignPerformance(restCtx).catch(err => {
      console.error('Audit campaign query failed:', err.message);
      return [finding('query_error_campaigns', SEVERITY.WARNING, 'system', 'Campaign query failed', 'Campaign data could not be loaded. Check account permissions.')];
    }),
    googleAds.getAdCopy(restCtx).catch(() => []),
    googleAds.getRecommendations(restCtx).catch(() => []),
    googleAds.getAdSchedules(restCtx).catch(() => []),
    googleAds.getAdGroupAdCounts(restCtx).catch(() => []),
    googleAds.getCampaignNegatives(restCtx).catch(() => []),
    googleAds.getSearchTermReport(restCtx).catch(() => []),
  ]);

  // If queries returned error findings, use empty arrays for those checks
  function extractErrorFindings(data) {
    if (Array.isArray(data) && data.length > 0 && data[0].checkId) {
      return { data: [], errors: data };
    }
    return { data, errors: [] };
  }

  const kw = extractErrorFindings(keywords);
  const keywordData = kw.data;
  const camp = extractErrorFindings(campaigns);
  const campaignData = camp.data;
  const queryErrors = [...kw.errors, ...camp.errors];

  // Run all checks
  const allChecks = {
    bidding_strategy:     () => checkBiddingStrategy(campaignData),
    broad_match:          () => checkBroadMatchKeywords(keywordData),
    zero_impressions:     () => checkZeroImpressionKeywords(keywordData),
    disapproved_ads:      () => checkDisapprovedAds(ads),
    high_cpc:             () => checkHighCpc(keywordData),
    low_ctr:              () => checkLowCtrCampaigns(campaignData),
    recommendations:      () => checkPendingRecommendations(recommendations),
    ad_schedules:         () => checkMissingAdSchedules(campaignData, adSchedules),
    zero_spend:           () => checkZeroSpendCampaigns(campaignData),
    low_impression_share: () => checkLowImpressionShare(campaignData),
    // Ad copy quality checks
    stale_years:          () => checkStaleYearReferences(ads),
    missing_rsas:         () => {
      const adGroups = (adGroupAdCounts || []).map(ag => ({
        name: ag.adGroupName, campaignName: ag.campaignName, status: 'ENABLED',
      }));
      return checkMissingRSAs(ads, adGroups);
    },
    headline_quality:     () => checkHeadlineQuality(ads),
    pinning:              () => checkPinningOveruse(ads),
    // Negative keyword & search term checks
    neg_conflicts:        () => analyzeNegativeConflicts(keywordData, campaignNegatives),
    neg_cannibalization:  () => analyzeCannibalization(keywordData),
    traffic_sculpting:    () => {
      const campaignNames = [...new Set(keywordData.map(k => k.campaignName).filter(Boolean))];
      return analyzeTrafficSculpting(keywordData, campaignNegatives, campaignNames);
    },
    irrelevant_search_terms:  () => analyzeIrrelevantSearchTerms(searchTerms),
    blocked_converting_terms: () => analyzeBlockedConvertingTerms(searchTerms, campaignNegatives),
    dealer_context:           () => checkDealerContextViolations(campaignData, restCtx.customerId),
  };

  let allFindings = [...queryErrors];

  for (const [name, check] of Object.entries(allChecks)) {
    if (selectedChecks && !selectedChecks.includes(name)) continue;
    try {
      const results = check();
      allFindings = allFindings.concat(results);
    } catch (err) {
      allFindings.push(finding(
        `check_error_${name}`,
        SEVERITY.WARNING,
        'system',
        `Check "${name}" threw an error`,
        err.message
      ));
    }
  }

  // Build summary
  const summary = {
    total: allFindings.length,
    critical: allFindings.filter(f => f.severity === SEVERITY.CRITICAL).length,
    warning: allFindings.filter(f => f.severity === SEVERITY.WARNING).length,
    info: allFindings.filter(f => f.severity === SEVERITY.INFO).length,
  };

  return {
    findings: allFindings,
    summary,
    ranAt: new Date().toISOString(),
    accountId: restCtx.customerId,
    checksRun: selectedChecks || Object.keys(allChecks),
  };
}

module.exports = {
  runAudit,
  // Export individual checks for unit testing
  checkBiddingStrategy,
  checkBroadMatchKeywords,
  checkZeroImpressionKeywords,
  checkDisapprovedAds,
  checkHighCpc,
  checkLowCtrCampaigns,
  checkPendingRecommendations,
  checkMissingAdSchedules,
  checkZeroSpendCampaigns,
  checkNamingConventions,
  checkLowImpressionShare,
  SEVERITY,
};
