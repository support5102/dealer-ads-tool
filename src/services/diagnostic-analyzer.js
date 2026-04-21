/**
 * Diagnostic Analyzer — R6 sub-routine for the Pacing Recommender v2.
 *
 * Runs when a campaign has unused shared budget AND IS below target band.
 * Executes 7 checks in priority order; first positive match wins.
 * Returns an array with 0 or 1 Diagnostic objects.
 *
 * Called by: recommender-v2.js (Phase 4 wiring).
 * Calls: google-ads.js query functions, strategy-rules.js CPC_RANGES.
 *
 * Pure async — no DB access, no side effects. All data fetched via Google Ads API.
 */

const { CPC_RANGES } = require('./strategy-rules');

// ─────────────────────────────────────────────────────────────────────────────
// Check 1 — Quality Score
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fires if ≥ 50% of eligible keywords have QS ≤ 4.
 *
 * @param {Object} googleAds - google-ads module (real or injected stub)
 * @param {Object} restCtx - REST context
 * @param {string} campaignId
 * @param {string} campaignName
 * @returns {Promise<Object|null>} Diagnostic or null
 */
async function checkQualityScore(googleAds, restCtx, campaignId, campaignName) {
  try {
    const keywords = await googleAds.getKeywordDiagnostics(restCtx);
    // Filter to this campaign, only keywords that have a quality score reported
    const campaignKws = keywords.filter(
      kw => String(kw.campaignName) === String(campaignName) ||
            String(kw.campaignId || '') === String(campaignId)
    );
    // Quality score can be null (e.g. newly created keywords). Only count eligible ones.
    const eligible = campaignKws.filter(kw => kw.qualityScore !== null && kw.qualityScore !== undefined);
    if (eligible.length === 0) return null;

    const lowQs = eligible.filter(kw => kw.qualityScore <= 4);
    const pct = lowQs.length / eligible.length;
    if (pct < 0.5) return null;

    return {
      check: 'quality_score',
      severity: 'high',
      message: `Quality Score issue: ${lowQs.length}/${eligible.length} keywords have QS ≤ 4 on campaign '${campaignName}'. Consider improving ad relevance, expected CTR, or landing page experience.`,
      details: {
        campaignId,
        campaignName,
        lowQsCount: lowQs.length,
        totalEligible: eligible.length,
        pctLowQs: Math.round(pct * 100),
      },
    };
  } catch (err) {
    console.warn(`[diagnostic-analyzer] checkQualityScore failed for campaign ${campaignId}:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 2 — Ad Disapproval
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fires if any enabled ad in the campaign is DISAPPROVED.
 *
 * @param {Object} googleAds
 * @param {Object} restCtx
 * @param {string} campaignId
 * @param {string} campaignName
 * @returns {Promise<Object|null>}
 */
async function checkAdDisapproval(googleAds, restCtx, campaignId, campaignName) {
  try {
    const ads = await googleAds.getAdCopy(restCtx);
    const campaignAds = ads.filter(
      ad => String(ad.campaignName) === String(campaignName) ||
            String(ad.campaignId || '') === String(campaignId)
    );
    const disapproved = campaignAds.filter(
      ad => ad.status === 'ENABLED' && ad.approvalStatus === 'DISAPPROVED'
    );
    if (disapproved.length === 0) return null;

    return {
      check: 'ad_disapproval',
      severity: 'high',
      message: `Ad disapproval on '${campaignName}': ${disapproved.length} enabled ads are DISAPPROVED. Review and fix.`,
      details: {
        campaignId,
        campaignName,
        disapprovedCount: disapproved.length,
      },
    };
  } catch (err) {
    console.warn(`[diagnostic-analyzer] checkAdDisapproval failed for campaign ${campaignId}:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 3 — Narrow Geo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fires if < 3 location criteria AND campaignType !== 'regional'.
 *
 * @param {Object} googleAds
 * @param {Object} restCtx
 * @param {string} campaignId
 * @param {string} campaignName
 * @param {string} campaignType
 * @returns {Promise<Object|null>}
 */
async function checkNarrowGeo(googleAds, restCtx, campaignId, campaignName, campaignType) {
  // Regional campaigns may intentionally have few locations
  if (campaignType === 'regional') return null;

  try {
    const locationCount = await googleAds.getCampaignLocations(restCtx, campaignId);
    // null means the query failed — skip
    if (locationCount === null) return null;
    if (locationCount >= 3) return null;

    return {
      check: 'narrow_geo',
      severity: 'medium',
      message: `Narrow geo targeting: '${campaignName}' targets only ${locationCount} location(s). Consider expanding coverage.`,
      details: {
        campaignId,
        campaignName,
        locationCount,
      },
    };
  } catch (err) {
    console.warn(`[diagnostic-analyzer] checkNarrowGeo failed for campaign ${campaignId}:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 4 — Ad Schedule Too Restrictive
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts ad_schedule start/end hour+minute to a total hours duration.
 * Handles the special case where minute values are encoded as enum strings
 * (ZERO=0, FIFTEEN=15, THIRTY=30, FORTY_FIVE=45) OR plain numbers.
 */
function minuteEnumToNumber(val) {
  if (typeof val === 'number') return val;
  const map = { ZERO: 0, FIFTEEN: 15, THIRTY: 30, FORTY_FIVE: 45 };
  return map[String(val).toUpperCase()] ?? 0;
}

/**
 * Fires if total scheduled hours per week < 40.
 * If no ad schedule exists at all (campaign runs 24/7), does NOT fire.
 *
 * @param {Object} googleAds
 * @param {Object} restCtx
 * @param {string} campaignId
 * @param {string} campaignName
 * @returns {Promise<Object|null>}
 */
async function checkAdSchedule(googleAds, restCtx, campaignId, campaignName) {
  try {
    const schedules = await googleAds.getAdSchedules(restCtx);
    const campaignSchedules = schedules.filter(
      s => String(s.campaignId) === String(campaignId) ||
           String(s.campaignName) === String(campaignName)
    );

    // No schedule = runs 24/7 = not a restriction, skip check
    if (campaignSchedules.length === 0) return null;

    // Sum hours across all schedule entries
    let totalHours = 0;
    for (const sched of campaignSchedules) {
      const startMinutes = minuteEnumToNumber(sched.startMinute);
      const endMinutes = minuteEnumToNumber(sched.endMinute);
      const startTotalMinutes = (sched.startHour * 60) + startMinutes;
      const endTotalMinutes = (sched.endHour * 60) + endMinutes;
      const duration = Math.max(endTotalMinutes - startTotalMinutes, 0) / 60;
      totalHours += duration;
    }

    totalHours = Math.round(totalHours * 10) / 10;
    if (totalHours >= 40) return null;

    return {
      check: 'ad_schedule',
      severity: 'medium',
      message: `Ad schedule on '${campaignName}' covers only ${totalHours} hours/week (out of 168 possible). Consider expanding.`,
      details: {
        campaignId,
        campaignName,
        weeklyHours: totalHours,
        scheduleEntries: campaignSchedules.length,
      },
    };
  } catch (err) {
    console.warn(`[diagnostic-analyzer] checkAdSchedule failed for campaign ${campaignId}:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 5 — Low Bids vs CPC Range
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fires if ≥ 50% of keywords bid below the CPC_RANGES minimum for the campaign type.
 * Skips if no CPC_RANGES entry exists for the type.
 *
 * @param {Object} googleAds
 * @param {Object} restCtx
 * @param {string} campaignId
 * @param {string} campaignName
 * @param {string} campaignType
 * @returns {Promise<Object|null>}
 */
async function checkLowBids(googleAds, restCtx, campaignId, campaignName, campaignType) {
  const range = CPC_RANGES[campaignType];
  if (!range) return null;  // No range for this type — skip

  try {
    const keywords = await googleAds.getKeywordPerformance(restCtx);
    const campaignKws = keywords.filter(
      kw => String(kw.campaignId) === String(campaignId) ||
            String(kw.campaignName) === String(campaignName)
    );
    // Only enabled, non-negative keywords with an explicit cpc bid
    const eligible = campaignKws.filter(
      kw => kw.status === 'ENABLED' && !kw.negative && kw.cpcBid > 0
    );
    if (eligible.length === 0) return null;

    const belowMin = eligible.filter(kw => kw.cpcBid < range.min);
    const pct = belowMin.length / eligible.length;
    if (pct < 0.5) return null;

    return {
      check: 'low_bids',
      severity: 'medium',
      message: `Low bids on '${campaignName}': ${belowMin.length}/${eligible.length} keywords bid below ${campaignType} CPC range ($${range.min}-$${range.max}). Consider raising bids.`,
      details: {
        campaignId,
        campaignName,
        belowMinCount: belowMin.length,
        totalEligible: eligible.length,
        rangeMin: range.min,
        rangeMax: range.max,
        campaignType,
      },
    };
  } catch (err) {
    console.warn(`[diagnostic-analyzer] checkLowBids failed for campaign ${campaignId}:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 6 — Negative Keyword Over-Block
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks whether a negative keyword overlaps with high-impression search terms.
 * A negative "blocks" a search term if the search term contains the negative
 * keyword text (simple substring/word match heuristic).
 *
 * Fires if a single negative blocks ≥ 10% of total search-term impressions.
 * Skips if no negatives or no search terms found.
 *
 * @param {Object} googleAds
 * @param {Object} restCtx
 * @param {string} campaignId
 * @param {string} campaignName
 * @returns {Promise<Object|null>}
 */
async function checkNegativeKeywordBlock(googleAds, restCtx, campaignId, campaignName) {
  try {
    const [negatives, searchTerms] = await Promise.all([
      googleAds.getCampaignNegatives(restCtx),
      googleAds.getSearchTermReport(restCtx),
    ]);

    const campaignNegatives = negatives.filter(
      n => String(n.campaignId) === String(campaignId) ||
           String(n.campaignName) === String(campaignName)
    );
    const campaignSearchTerms = searchTerms.filter(
      st => String(st.campaignId) === String(campaignId) ||
            String(st.campaignName) === String(campaignName)
    );

    if (campaignNegatives.length === 0 || campaignSearchTerms.length === 0) return null;

    const totalImpressions = campaignSearchTerms.reduce((sum, st) => sum + (st.impressions || 0), 0);
    if (totalImpressions === 0) return null;

    // For each negative keyword, estimate blocked impressions by checking which
    // search terms contain the negative keyword text (case-insensitive word/substring match).
    for (const neg of campaignNegatives) {
      const negText = (neg.keyword || '').toLowerCase().trim();
      if (!negText) continue;

      const blockedImpressions = campaignSearchTerms
        .filter(st => {
          const term = (st.searchTerm || '').toLowerCase();
          return term.includes(negText);
        })
        .reduce((sum, st) => sum + (st.impressions || 0), 0);

      const blockPct = Math.round((blockedImpressions / totalImpressions) * 100);
      if (blockPct >= 10) {
        return {
          check: 'negative_block',
          severity: 'medium',
          message: `Negative keyword '${neg.keyword}' on '${campaignName}' may be blocking significant traffic (${blockPct}% of search-term impressions).`,
          details: {
            campaignId,
            campaignName,
            negativeKeyword: neg.keyword,
            matchType: neg.matchType,
            blockedImpressions,
            totalImpressions,
            blockPct,
          },
        };
      }
    }

    return null;
  } catch (err) {
    console.warn(`[diagnostic-analyzer] checkNegativeKeywordBlock failed for campaign ${campaignId}:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 7 — Fall-through
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Always fires as the last check when no earlier check identified a cause.
 *
 * @param {string} campaignId
 * @param {string} campaignName
 * @returns {Object}
 */
function checkFallthrough(campaignId, campaignName) {
  return {
    check: 'fallthrough',
    severity: 'low',
    message: `No single cause identified for unused budget + low IS on '${campaignName}'. Manual investigation needed. Suggested next steps: (1) review Search Terms report for new opportunities, (2) check auction insights for competitor pressure, (3) verify ad group relevance.`,
    details: {
      campaignId,
      campaignName,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs diagnostic checks to narrow down the cause when a campaign has
 * unused budget + low impression share. First positive match wins — the
 * analyzer stops at the first check that identifies an issue.
 *
 * @param {Object} params
 * @param {Object} params.restCtx - { accessToken, developerToken, customerId, loginCustomerId }
 * @param {string} params.campaignId - The specific campaign to diagnose
 * @param {string} params.campaignName - For human-readable output
 * @param {string} params.campaignType - Classified type (brand/vla/model_keyword/etc.)
 * @param {Object} [params._googleAds] - Optional injected google-ads module for testing
 * @returns {Promise<Array>} Empty or single-element array of Diagnostic objects
 */
async function analyze(params) {
  const { restCtx, campaignId, campaignName, campaignType, _googleAds } = params;
  // Use injected module if provided (for testing), otherwise load real module
  const googleAds = _googleAds || require('./google-ads');

  // Run 7 checks in priority order. First positive match wins.
  // Each check returns null if it doesn't fire; returns Diagnostic if it fires.
  // A failed check (exception) logs a warning and returns null — treated as "skip".

  // Check 1: Quality Score
  const qs = await checkQualityScore(googleAds, restCtx, campaignId, campaignName);
  if (qs) return [qs];

  // Check 2: Ad Disapproval
  const dis = await checkAdDisapproval(googleAds, restCtx, campaignId, campaignName);
  if (dis) return [dis];

  // Check 3: Narrow Geo
  const geo = await checkNarrowGeo(googleAds, restCtx, campaignId, campaignName, campaignType);
  if (geo) return [geo];

  // Check 4: Ad Schedule Too Restrictive
  const sched = await checkAdSchedule(googleAds, restCtx, campaignId, campaignName);
  if (sched) return [sched];

  // Check 5: Low Bids vs CPC Range
  const bids = await checkLowBids(googleAds, restCtx, campaignId, campaignName, campaignType);
  if (bids) return [bids];

  // Check 6: Negative Keyword Over-Block
  const negBlock = await checkNegativeKeywordBlock(googleAds, restCtx, campaignId, campaignName);
  if (negBlock) return [negBlock];

  // Check 7: Fall-through (always fires if none of the above matched)
  return [checkFallthrough(campaignId, campaignName)];
}

module.exports = {
  analyze,
  // Export helpers for standalone testing
  checkQualityScore,
  checkAdDisapproval,
  checkNarrowGeo,
  checkAdSchedule,
  checkLowBids,
  checkNegativeKeywordBlock,
  checkFallthrough,
};
