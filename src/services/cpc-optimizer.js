/**
 * CPC Optimizer — analyzes keyword impression share vs CPC to find savings.
 *
 * Called by: routes/optimization.js (POST /api/optimize/cpc/:customerId)
 * Calls: strategy-rules.js (CPC ranges, IS targets, campaign classification)
 *
 * Core idea: if a keyword has IS > 90%, we're overbidding — lower CPC to save money
 * while staying in the 75-90% IS sweet spot. If IS < 75%, raise CPC to capture
 * more traffic. Max 20% adjustment per cycle to avoid sudden ranking drops.
 */

const { classifyCampaignType, getCpcRange, IMPRESSION_SHARE } = require('./strategy-rules');

/** Maximum bid adjustment per optimization cycle (percentage) */
const MAX_ADJUSTMENT_PERCENT = 20;

/**
 * Analyzes keyword performance data and identifies CPC optimization opportunities.
 *
 * @param {Object[]} keywords - Keyword performance data from getKeywordPerformance()
 * @returns {Object[]} Array of opportunities with action (increase/decrease), keyword info, and reason
 */
function analyzeCpcOpportunities(keywords) {
  if (!keywords || !keywords.length) return [];

  const opportunities = [];

  for (const kw of keywords) {
    // Skip non-actionable keywords
    if (kw.negative) continue;
    if (kw.status !== 'ENABLED') continue;
    if (kw.impressions === 0) continue;
    if (kw.searchImpressionShare === null || kw.searchImpressionShare === undefined) continue;

    const is = kw.searchImpressionShare;
    const { min: isMin, max: isMax } = IMPRESSION_SHARE.target;

    if (is > isMax) {
      // Overbidding — IS above 90%, can lower CPC to save money
      opportunities.push({
        keyword: kw.keyword,
        matchType: kw.matchType,
        campaignName: kw.campaignName,
        campaignId: kw.campaignId,
        adGroupName: kw.adGroupName,
        adGroupId: kw.adGroupId,
        currentBid: kw.cpcBid,
        averageCpc: kw.averageCpc,
        impressionShare: is,
        action: 'decrease',
        reason: `Impression share (${(is * 100).toFixed(1)}%) above 90% target — can lower CPC to save budget`,
      });
    } else if (is < isMin) {
      // Underbidding — IS below 75%, need to raise CPC to capture more traffic
      opportunities.push({
        keyword: kw.keyword,
        matchType: kw.matchType,
        campaignName: kw.campaignName,
        campaignId: kw.campaignId,
        adGroupName: kw.adGroupName,
        adGroupId: kw.adGroupId,
        currentBid: kw.cpcBid,
        averageCpc: kw.averageCpc,
        impressionShare: is,
        action: 'increase',
        reason: `Impression share (${(is * 100).toFixed(1)}%) below 75% target — raising CPC to capture more traffic`,
      });
    }
    // If IS is 75-90%, keyword is in the sweet spot — no action needed
  }

  return opportunities;
}

/**
 * Generates specific bid adjustment amounts for each opportunity.
 * Adjustments are proportional to how far IS deviates from target range,
 * capped at MAX_ADJUSTMENT_PERCENT, and bounded by strategy-rules CPC ranges.
 *
 * @param {Object[]} opportunities - Output from analyzeCpcOpportunities()
 * @returns {Object[]} Array of bid adjustments with newBid and change metadata
 */
function generateBidAdjustments(opportunities) {
  if (!opportunities || !opportunities.length) return [];

  const adjustments = [];

  for (const opp of opportunities) {
    const { min: isMin, max: isMax } = IMPRESSION_SHARE.target;
    let adjustPercent;

    if (opp.action === 'decrease') {
      // Scale: IS at 91% → small decrease, IS at 99% → max decrease
      const overBy = opp.impressionShare - isMax; // 0.01 to ~0.10
      adjustPercent = Math.min(overBy * (MAX_ADJUSTMENT_PERCENT / 0.10), MAX_ADJUSTMENT_PERCENT);
    } else {
      // Scale: IS at 74% → small increase, IS at 0% → max increase
      const underBy = isMin - opp.impressionShare; // 0.01 to 0.75
      adjustPercent = Math.min(underBy * (MAX_ADJUSTMENT_PERCENT / 0.75), MAX_ADJUSTMENT_PERCENT);
    }

    // Calculate new bid
    let newBid;
    if (opp.action === 'decrease') {
      newBid = opp.currentBid * (1 - adjustPercent / 100);
    } else {
      newBid = opp.currentBid * (1 + adjustPercent / 100);
    }

    // Enforce strategy-rules CPC floor/ceiling
    const campaignType = classifyCampaignType(opp.campaignName);
    const cpcRange = getCpcRange(campaignType);
    if (cpcRange) {
      newBid = Math.max(newBid, cpcRange.min);
      newBid = Math.min(newBid, cpcRange.max);
    }

    // Round to 2 decimal places
    newBid = Math.round(newBid * 100) / 100;

    // Only include if bid actually changes
    if (newBid !== opp.currentBid) {
      adjustments.push({
        keyword: opp.keyword,
        matchType: opp.matchType,
        campaignName: opp.campaignName,
        campaignId: opp.campaignId,
        adGroupName: opp.adGroupName,
        adGroupId: opp.adGroupId,
        currentBid: opp.currentBid,
        newBid,
        change: Math.round((newBid - opp.currentBid) * 100) / 100,
        impressionShare: opp.impressionShare,
        action: opp.action,
        reason: opp.reason,
      });
    }
  }

  return adjustments;
}

module.exports = {
  analyzeCpcOpportunities,
  generateBidAdjustments,
  MAX_ADJUSTMENT_PERCENT,
};
