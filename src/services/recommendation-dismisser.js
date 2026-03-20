/**
 * Recommendation Dismisser — auto-classifies Google Ads recommendations for dismissal.
 *
 * Called by: routes/optimization.js (POST /api/recommendations/dismiss/:customerId)
 * Calls: google-ads.js (getRecommendations), strategy-rules.js
 *
 * Google Partner status requires engagement with recommendations. Strategy conflicts
 * (broad match, ECPC, automated bidding) should be dismissed immediately. Other
 * recommendations go to a review queue for human decision.
 */

/**
 * Recommendation types that always conflict with our strategy and should be auto-dismissed.
 * These change bidding strategy away from Manual CPC or introduce broad match.
 */
const ALWAYS_DISMISS_TYPES = [
  'USE_BROAD_MATCH_KEYWORD',        // Strategy: EXACT + PHRASE only
  'ENHANCED_CPC_OPT_IN',            // Strategy: Manual CPC, no ECPC
  'MAXIMIZE_CONVERSIONS_OPT_IN',    // Strategy: Manual CPC on search
  'MAXIMIZE_CLICKS_OPT_IN',         // Strategy: Manual CPC on search
  'TARGET_CPA_OPT_IN',              // Strategy: Manual CPC on search
  'TARGET_ROAS_OPT_IN',             // Strategy: Manual CPC on search
  'SET_TARGET_CPA',                 // Strategy: No target CPA
  'SET_TARGET_ROAS',                // Strategy: No target ROAS
  'MOVE_UNUSED_BUDGET',             // We manage budgets ourselves
  'FORECASTING_SET_TARGET_CPA',     // No automated bidding targets
];

/**
 * Recommendation types that should always go to human review (never auto-dismiss).
 */
const ALWAYS_KEEP_TYPES = [
  'KEYWORD',                        // May be valid keyword suggestions
  'TEXT_AD',                         // Ad copy changes need review
  'RESPONSIVE_SEARCH_AD',           // RSA suggestions need review
  'RESPONSIVE_SEARCH_AD_ASSET',     // Headline/description suggestions
  'CALLOUT_ASSET',                  // Extension suggestions
  'SITELINK_ASSET',                 // Sitelink suggestions
  'CALL_ASSET',                     // Call extension suggestions
];

/** Dismiss reasons by type */
const DISMISS_REASONS = {
  USE_BROAD_MATCH_KEYWORD: 'Conflicts with strategy: broad match forbidden, EXACT + PHRASE only',
  ENHANCED_CPC_OPT_IN: 'Conflicts with strategy: ECPC must be disabled, Manual CPC required',
  MAXIMIZE_CONVERSIONS_OPT_IN: 'Conflicts with strategy: search campaigns must use Manual CPC',
  MAXIMIZE_CLICKS_OPT_IN: 'Conflicts with strategy: search campaigns must use Manual CPC',
  TARGET_CPA_OPT_IN: 'Conflicts with strategy: no automated bidding targets on search campaigns',
  TARGET_ROAS_OPT_IN: 'Conflicts with strategy: no automated bidding targets on search campaigns',
  SET_TARGET_CPA: 'Conflicts with strategy: no target CPA settings',
  SET_TARGET_ROAS: 'Conflicts with strategy: no target ROAS settings',
  MOVE_UNUSED_BUDGET: 'Budget management handled manually via pacing tool',
  FORECASTING_SET_TARGET_CPA: 'Conflicts with strategy: no automated bidding targets',
};

/**
 * Classifies recommendations into dismiss vs. review queues based on strategy alignment.
 *
 * @param {Object[]} recommendations - From getRecommendations()
 * @returns {{ toDismiss: Object[], toReview: Object[] }} Classified recommendations
 */
function classifyRecommendations(recommendations) {
  if (!recommendations || !recommendations.length) {
    return { toDismiss: [], toReview: [] };
  }

  const toDismiss = [];
  const toReview = [];

  for (const rec of recommendations) {
    if (ALWAYS_DISMISS_TYPES.includes(rec.type)) {
      toDismiss.push({
        ...rec,
        dismissReason: DISMISS_REASONS[rec.type] || `Auto-dismiss: ${rec.type} conflicts with strategy`,
      });
    } else {
      toReview.push({
        ...rec,
        reviewReason: ALWAYS_KEEP_TYPES.includes(rec.type)
          ? `Needs human review: ${rec.type} may contain useful suggestions`
          : `Unknown recommendation type: ${rec.type} — review before dismissing`,
      });
    }
  }

  return { toDismiss, toReview };
}

module.exports = {
  classifyRecommendations,
  ALWAYS_DISMISS_TYPES,
  ALWAYS_KEEP_TYPES,
  DISMISS_REASONS,
};
