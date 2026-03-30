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
  UNIVERSAL_NEGATIVES,
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

// ─────────────────────────────────────────────────────────────
// Search term analysis
// ─────────────────────────────────────────────────────────────

// Patterns that indicate irrelevant search terms on dealer campaigns
const IRRELEVANT_PATTERNS = [
  // Price-hunting (not selling cheap/used beaters)
  { pattern: /under \$?\d/i, reason: 'price-hunting' },
  { pattern: /less than \$?\d/i, reason: 'price-hunting' },
  { pattern: /cheap(est)?/i, reason: 'price-hunting' },
  { pattern: /\$\d{2,4}\s*(down|\/mo)/i, reason: 'price-hunting' },
  { pattern: /no (credit|money down)/i, reason: 'price-hunting' },
  { pattern: /bad credit/i, reason: 'price-hunting' },
  { pattern: /buy here pay here/i, reason: 'price-hunting' },
  // Service/parts intent (not sales)
  { pattern: /\b(oil change|tire rotation|brake (pad|job)|repair|mechanic|service center)\b/i, reason: 'service intent' },
  { pattern: /\b(parts|wiring diagram|fuse box|owners? manual)\b/i, reason: 'parts/manual intent' },
  // Off-topic
  { pattern: /\b(rental|rent a|insurance|recall|lawsuit|lemon law)\b/i, reason: 'off-topic' },
  { pattern: /\b(toy|hot wheels|matchbox|model car|die cast|rc car|remote control)\b/i, reason: 'toy/model intent' },
  { pattern: /\b(coloring page|wallpaper|screensaver|game|simulator)\b/i, reason: 'off-topic' },
  { pattern: /\b(junkyard|salvage|rebuilt title|accident|crash test)\b/i, reason: 'salvage/accident' },
  { pattern: /\b(how to|diy|tutorial|youtube)\b/i, reason: 'DIY/research' },
  // Job-seekers
  { pattern: /\b(jobs?|hiring|career|salary|employment|work at)\b/i, reason: 'job search' },
];

/**
 * Analyzes search terms for irrelevant traffic that should be negatived out.
 *
 * Checks search terms against irrelevance patterns (price-hunting, service intent,
 * off-topic, etc.) and flags terms getting clicks that waste budget.
 * Also flags "used" terms appearing on "New" campaigns.
 *
 * @param {Object[]} searchTerms - Array from getSearchTermReport
 * @returns {Object[]} Array of findings
 */
function analyzeIrrelevantSearchTerms(searchTerms) {
  const findings = [];
  const irrelevant = [];

  for (const st of (searchTerms || [])) {
    if (st.clicks < 1) continue; // only flag terms costing money

    const termLower = st.searchTerm.toLowerCase();
    let flagReason = null;

    // Check against irrelevant patterns
    for (const { pattern, reason } of IRRELEVANT_PATTERNS) {
      if (pattern.test(st.searchTerm)) {
        flagReason = reason;
        break;
      }
    }

    // Check against universal negatives from strategy-rules
    if (!flagReason) {
      for (const neg of UNIVERSAL_NEGATIVES) {
        if (termLower.includes(neg.toLowerCase())) {
          flagReason = `matches universal negative "${neg}"`;
          break;
        }
      }
    }

    // Check "used" terms on "New" campaigns
    if (!flagReason) {
      const parts = (st.campaignName || '').split(' - ').map(p => p.trim().toLowerCase());
      const isNewCampaign = parts.length >= 2 && parts[1] === 'new';
      if (isNewCampaign && /\bused\b/i.test(st.searchTerm)) {
        flagReason = 'used intent on new vehicle campaign';
      }
    }

    if (flagReason) {
      irrelevant.push({
        searchTerm: st.searchTerm,
        campaignName: st.campaignName,
        adGroupName: st.adGroupName,
        clicks: st.clicks,
        cost: Math.round(st.cost * 100) / 100,
        conversions: st.conversions,
        reason: flagReason,
      });
    }
  }

  if (irrelevant.length > 0) {
    // Sort by cost descending (biggest waste first)
    irrelevant.sort((a, b) => b.cost - a.cost);
    const totalWaste = irrelevant.reduce((sum, t) => sum + t.cost, 0);

    findings.push(finding(
      'IRRELEVANT_SEARCH_TERMS',
      'warning',
      'search_terms',
      `${irrelevant.length} irrelevant search term(s) wasting $${totalWaste.toFixed(2)}`,
      `Search terms matching irrelevant patterns are getting clicks. Add as negative keywords to stop waste.`,
      { terms: irrelevant.slice(0, 20), totalWaste, totalCount: irrelevant.length }
    ));
  }

  return findings;
}

/**
 * Detects when campaign-level negatives are blocking search terms that
 * have historically converted. The search_term_view shows terms that
 * DID trigger ads — if a negative now exists that would block a converting
 * term, it's likely a mistake.
 *
 * @param {Object[]} searchTerms - Array from getSearchTermReport
 * @param {Object[]} campaignNegatives - Array from getCampaignNegatives
 * @returns {Object[]} Array of findings
 */
function analyzeBlockedConvertingTerms(searchTerms, campaignNegatives) {
  const findings = [];
  const blocked = [];

  // Only check search terms that actually converted
  const convertingTerms = (searchTerms || []).filter(st => st.conversions > 0);
  const negatives = campaignNegatives || [];

  for (const st of convertingTerms) {
    for (const neg of negatives) {
      // Check if the negative in the SAME campaign would block this converting term
      if (neg.campaignName !== st.campaignName) continue;

      if (doesNegativeBlock(neg.keyword, neg.matchType, st.searchTerm)) {
        blocked.push({
          searchTerm: st.searchTerm,
          campaignName: st.campaignName,
          conversions: st.conversions,
          conversionValue: Math.round(st.conversionValue * 100) / 100,
          clicks: st.clicks,
          blockingNegative: neg.keyword,
          blockingMatchType: neg.matchType,
        });
        break; // one blocking negative per term is enough
      }
    }
  }

  if (blocked.length > 0) {
    const totalConversions = blocked.reduce((sum, t) => sum + t.conversions, 0);
    findings.push(finding(
      'BLOCKED_CONVERTING_TERMS',
      'critical',
      'search_terms',
      `${blocked.length} converting search term(s) blocked by negatives`,
      `Negative keywords are blocking search terms that generated ${totalConversions} conversion(s). Review and remove these negatives.`,
      { terms: blocked }
    ));
  }

  return findings;
}

module.exports = {
  analyzeNegativeConflicts,
  analyzeCannibalization,
  analyzeTrafficSculpting,
  analyzeIrrelevantSearchTerms,
  analyzeBlockedConvertingTerms,
  // Exported for testing
  doesNegativeBlock,
};
