/**
 * Negative Keyword Analyzer — analyzes negative keyword health for a single account.
 *
 * Called by: audit-engine.js (as part of the full audit pipeline)
 * Calls: strategy-rules.js (for competing makes detection)
 *
 * Three analysis functions that detect conflicts, cannibalization, and missing
 * traffic-sculpting negatives. Each returns an array of findings in the standard
 * audit-engine format: { checkId, severity, category, title, message, details }.
 */

const {
  detectDealerMake,
  getCompetingMakes,
  classifyCampaignType,
} = require('./strategy-rules');

// ── Finding builder (matches audit-engine.js format) ──

function finding(checkId, severity, category, title, message, details = {}) {
  return { checkId, severity, category, title, message, details };
}

// ─────────────────────────────────────────────────────────────
// Conflict detection helpers
// ─────────────────────────────────────────────────────────────

/**
 * Checks whether a negative keyword blocks a positive keyword.
 * Exact negatives block only exact matches. Phrase negatives block
 * any keyword containing the phrase as a substring sequence.
 *
 * @param {string} negativeText - The negative keyword text (lowercase)
 * @param {string} negativeMatchType - 'EXACT' or 'PHRASE'
 * @param {string} positiveText - The positive keyword text (lowercase)
 * @returns {boolean} True if the negative blocks the positive
 */
function doesNegativeBlock(negativeText, negativeMatchType, positiveText) {
  const neg = negativeText.toLowerCase().trim();
  const pos = positiveText.toLowerCase().trim();

  if (negativeMatchType === 'EXACT') {
    return neg === pos;
  }

  if (negativeMatchType === 'PHRASE') {
    // Phrase match: the negative phrase must appear as a contiguous sequence
    // of words within the positive keyword
    const negWords = neg.split(/\s+/);
    const posWords = pos.split(/\s+/);

    if (negWords.length > posWords.length) return false;

    for (let i = 0; i <= posWords.length - negWords.length; i++) {
      let match = true;
      for (let j = 0; j < negWords.length; j++) {
        if (posWords[i + j] !== negWords[j]) {
          match = false;
          break;
        }
      }
      if (match) return true;
    }
    return false;
  }

  // BROAD match: all words in the negative appear anywhere in the positive (any order)
  if (negativeMatchType === 'BROAD') {
    const negWordSet = neg.split(/\s+/);
    const posWordSet = new Set(pos.split(/\s+/));
    return negWordSet.every(w => posWordSet.has(w));
  }

  return false;
}

// ─────────────────────────────────────────────────────────────
// Analysis functions
// ─────────────────────────────────────────────────────────────

/**
 * Finds cases where a campaign-level negative blocks an active positive keyword
 * in the same campaign.
 *
 * @param {Object[]} keywords - Array from getKeywordPerformance
 * @param {string} keywords[].keyword - Keyword text
 * @param {string} keywords[].matchType - EXACT, PHRASE, BROAD
 * @param {string} keywords[].campaignName - Campaign containing this keyword
 * @param {string} keywords[].adGroupName - Ad group containing this keyword
 * @param {string} keywords[].status - ENABLED, PAUSED, REMOVED
 * @param {boolean} keywords[].negative - Whether this is a negative keyword
 * @param {Object[]} campaignNegatives - Array of campaign-level negatives
 * @param {string} campaignNegatives[].keyword - Negative keyword text
 * @param {string} campaignNegatives[].matchType - EXACT or PHRASE
 * @param {string} campaignNegatives[].campaignName - Campaign this negative belongs to
 * @returns {Object[]} Array of findings with severity CRITICAL
 */
function analyzeNegativeConflicts(keywords, campaignNegatives) {
  const findings = [];

  // Only check active positive keywords
  const activePositives = (keywords || []).filter(
    kw => kw.status === 'ENABLED' && !kw.negative
  );

  const negatives = campaignNegatives || [];

  for (const pos of activePositives) {
    for (const neg of negatives) {
      // Only check negatives in the same campaign
      if (neg.campaignName !== pos.campaignName) continue;

      if (doesNegativeBlock(neg.keyword, neg.matchType, pos.keyword)) {
        findings.push(finding(
          'NEG_CONFLICT',
          'critical',
          'negative_keywords',
          'Negative keyword blocks active keyword',
          `Campaign "${pos.campaignName}": negative "${neg.keyword}" ` +
          `(${neg.matchType}) blocks active keyword "${pos.keyword}" ` +
          `in ad group "${pos.adGroupName}"`,
          {
            campaignName: pos.campaignName,
            adGroupName: pos.adGroupName,
            blockedKeyword: pos.keyword,
            blockedMatchType: pos.matchType,
            blockingNegative: neg.keyword,
            blockingNegativeMatchType: neg.matchType,
          }
        ));
      }
    }
  }

  return findings;
}

/**
 * Finds the same keyword text appearing as a positive keyword in multiple
 * ad groups within the same campaign (keyword cannibalization).
 *
 * @param {Object[]} keywords - Array from getKeywordPerformance
 * @returns {Object[]} Array of findings with severity WARNING
 */
function analyzeCannibalization(keywords) {
  const findings = [];
  const activePositives = (keywords || []).filter(
    kw => kw.status === 'ENABLED' && !kw.negative
  );

  // Group by campaign + keyword text (case-insensitive)
  const groups = new Map();
  for (const kw of activePositives) {
    const key = `${kw.campaignName}|||${kw.keyword.toLowerCase().trim()}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(kw);
  }

  for (const [, kwGroup] of groups) {
    // Collect unique ad groups for this keyword+campaign combo
    const uniqueAdGroups = [...new Set(kwGroup.map(kw => kw.adGroupName))];
    if (uniqueAdGroups.length < 2) continue;

    const sample = kwGroup[0];
    findings.push(finding(
      'KW_CANNIBALIZATION',
      'warning',
      'negative_keywords',
      'Keyword cannibalization across ad groups',
      `Campaign "${sample.campaignName}": keyword "${sample.keyword}" ` +
      `appears in ${uniqueAdGroups.length} ad groups: ${uniqueAdGroups.join(', ')}`,
      {
        campaignName: sample.campaignName,
        keyword: sample.keyword,
        adGroups: uniqueAdGroups,
        count: uniqueAdGroups.length,
      }
    ));
  }

  return findings;
}

/**
 * Checks if Search campaigns have proper competing-make negatives for
 * traffic sculpting. PMax campaigns are skipped.
 *
 * @param {Object[]} keywords - Array from getKeywordPerformance (used for campaign discovery)
 * @param {Object[]} campaignNegatives - Array of campaign-level negatives
 * @param {string[]} campaignNames - List of all campaign names in the account
 * @returns {Object[]} Array of findings with severity WARNING
 */
function analyzeTrafficSculpting(keywords, campaignNegatives, campaignNames) {
  const findings = [];
  const names = campaignNames || [];
  const negatives = campaignNegatives || [];

  // Build a map of campaign → set of negative keyword texts (lowercased)
  const negsByCampaign = new Map();
  for (const neg of negatives) {
    if (!negsByCampaign.has(neg.campaignName)) {
      negsByCampaign.set(neg.campaignName, new Set());
    }
    negsByCampaign.get(neg.campaignName).add(neg.keyword.toLowerCase().trim());
  }

  for (const name of names) {
    // Skip PMax campaigns
    const campaignType = classifyCampaignType(name);
    if (campaignType === 'pmax') continue;

    // Detect what make this campaign is for
    const dealerMake = detectDealerMake(name);
    if (!dealerMake) continue; // Can't determine make, skip

    const competingMakes = getCompetingMakes(dealerMake);
    const existingNegs = negsByCampaign.get(name) || new Set();

    const missingMakes = competingMakes.filter(
      make => !existingNegs.has(make)
    );

    if (missingMakes.length > 0) {
      findings.push(finding(
        'MISSING_COMPETING_NEGS',
        'warning',
        'negative_keywords',
        'Missing competing-make negatives',
        `Campaign "${name}" (${dealerMake}) is missing ${missingMakes.length} ` +
        `competing-make negatives: ${missingMakes.slice(0, 5).join(', ')}` +
        (missingMakes.length > 5 ? ` and ${missingMakes.length - 5} more` : ''),
        {
          campaignName: name,
          dealerMake,
          missingMakes,
          missingCount: missingMakes.length,
          totalExpected: competingMakes.length,
        }
      ));
    }
  }

  return findings;
}

module.exports = {
  analyzeNegativeConflicts,
  analyzeCannibalization,
  analyzeTrafficSculpting,
  // Exported for testing
  doesNegativeBlock,
};
