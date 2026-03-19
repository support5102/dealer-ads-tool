/**
 * Ad Copy Analyzer — checks RSA ad copy quality for a Google Ads account.
 *
 * Called by: audit-engine.js (Phase 12 ad copy checks)
 * Calls: nothing (pure analysis functions, data passed in)
 *
 * Each function returns an array of findings in the standard audit format:
 * { checkId, severity, category, title, message, details }
 */

const SEVERITY = { CRITICAL: 'critical', WARNING: 'warning', INFO: 'info' };
const CATEGORY = 'ad_copy';

/**
 * Extracts 4-digit years from text that look like model years (2020-2099 range).
 * Filters out years embedded in longer digit sequences (phone numbers, zip codes).
 *
 * @param {string} text - Text to scan for year references
 * @returns {number[]} Array of year numbers found
 */
function extractYears(text) {
  const matches = [];
  // Match 4-digit years NOT surrounded by other digits
  const regex = /(?<!\d)(20\d{2})(?!\d)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push(parseInt(match[1], 10));
  }
  return matches;
}

/**
 * Checks ad headlines and descriptions for stale year references.
 *
 * Flags years in the 2020-2025 range as stale (current year is 2026).
 * Years 2026+ are considered current/future and pass.
 * Years embedded in phone numbers or zip codes are ignored via boundary detection.
 *
 * @param {Object[]} ads - Array of ad objects from getAdCopy
 * @param {string} ads[].adId - Ad identifier
 * @param {Object[]} ads[].headlines - Array of { text, pinnedField }
 * @param {Object[]} ads[].descriptions - Array of { text }
 * @param {string} ads[].campaignName - Parent campaign name
 * @param {string} ads[].adGroupName - Parent ad group name
 * @param {string} ads[].status - Ad status (ENABLED, PAUSED, etc.)
 * @returns {Object[]} Array of findings
 */
function checkStaleYearReferences(ads, currentYear = new Date().getFullYear()) {
  const findings = [];
  const staleMin = 2020;
  const staleMax = currentYear - 1;

  const staleAds = [];

  for (const ad of ads) {
    const allText = [
      ...ad.headlines.map(h => h.text),
      ...ad.descriptions.map(d => d.text),
    ];

    for (const text of allText) {
      const years = extractYears(text);
      const staleYears = years.filter(y => y >= staleMin && y <= staleMax);
      if (staleYears.length > 0) {
        staleAds.push({
          adId: ad.adId,
          campaignName: ad.campaignName,
          adGroupName: ad.adGroupName,
          staleYears,
          text,
        });
        break; // count each ad once
      }
    }
  }

  if (staleAds.length > 0) {
    findings.push({
      checkId: 'ad_copy_stale_years',
      severity: SEVERITY.WARNING,
      category: CATEGORY,
      title: 'Stale year references in ad copy',
      message: `${staleAds.length} ad(s) reference outdated years. Update to current model years.`,
      details: { staleAds },
    });
  }

  return findings;
}

/**
 * Checks that every enabled ad group has at least one active RSA.
 *
 * Flags ad groups with 0 active RSAs as WARNING, groups with only 1 as INFO
 * (best practice is 2 for A/B testing). Paused ad groups are skipped.
 *
 * @param {Object[]} ads - Array of ad objects from getAdCopy
 * @param {Object[]} adGroups - Array of { name, campaignName, status }
 * @returns {Object[]} Array of findings
 */
function checkMissingRSAs(ads, adGroups) {
  const findings = [];

  const enabledGroups = adGroups.filter(ag => ag.status === 'ENABLED');

  // Count active RSAs per ad group (ENABLED + APPROVED)
  const rsaCounts = new Map();
  for (const ag of enabledGroups) {
    const key = `${ag.campaignName}||${ag.name}`;
    rsaCounts.set(key, 0);
  }

  for (const ad of ads) {
    if (ad.status === 'ENABLED' && ad.approvalStatus === 'APPROVED') {
      const key = `${ad.campaignName}||${ad.adGroupName}`;
      if (rsaCounts.has(key)) {
        rsaCounts.set(key, rsaCounts.get(key) + 1);
      }
    }
  }

  const zeroRSA = [];
  const oneRSA = [];

  for (const [key, count] of rsaCounts) {
    const [campaignName, adGroupName] = key.split('||');
    if (count === 0) {
      zeroRSA.push({ campaignName, adGroupName });
    } else if (count === 1) {
      oneRSA.push({ campaignName, adGroupName });
    }
  }

  if (zeroRSA.length > 0) {
    findings.push({
      checkId: 'ad_copy_missing_rsa',
      severity: SEVERITY.WARNING,
      category: CATEGORY,
      title: 'Ad groups with no active RSAs',
      message: `${zeroRSA.length} enabled ad group(s) have no active RSA. Each ad group needs at least 1 RSA.`,
      details: { adGroups: zeroRSA },
    });
  }

  if (oneRSA.length > 0) {
    findings.push({
      checkId: 'ad_copy_single_rsa',
      severity: SEVERITY.INFO,
      category: CATEGORY,
      title: 'Ad groups with only 1 RSA',
      message: `${oneRSA.length} ad group(s) have only 1 RSA. Consider adding a second for A/B testing.`,
      details: { adGroups: oneRSA },
    });
  }

  return findings;
}

/**
 * Checks headline quality across RSA ads.
 *
 * Detects three issue types:
 * 1. Short headlines (< 15 characters) — wastes available 30-char space
 * 2. All-caps headlines — looks spammy to users
 * 3. Missing dealer name — no headline contains a word from the dealer portion
 *    of the campaign name (text before first " - ")
 *
 * @param {Object[]} ads - Array of ad objects from getAdCopy
 * @returns {Object[]} Array of findings
 */
function checkHeadlineQuality(ads) {
  const findings = [];

  const shortHeadlines = [];
  const allCapsHeadlines = [];
  const missingDealerName = [];

  for (const ad of ads) {
    // Check short headlines
    for (const h of ad.headlines) {
      if (h.text.length < 15) {
        shortHeadlines.push({
          adId: ad.adId,
          campaignName: ad.campaignName,
          adGroupName: ad.adGroupName,
          headline: h.text,
        });
      }
    }

    // Check all-caps headlines
    for (const h of ad.headlines) {
      // Must have at least one letter and all letters are uppercase
      if (/[A-Z]/.test(h.text) && h.text === h.text.toUpperCase() && /[A-Za-z]/.test(h.text)) {
        allCapsHeadlines.push({
          adId: ad.adId,
          campaignName: ad.campaignName,
          adGroupName: ad.adGroupName,
          headline: h.text,
        });
      }
    }

    // Check missing dealer name
    const dealerPortion = ad.campaignName.split(' - ')[0].trim();
    const dealerWords = dealerPortion.split(/\s+/).filter(w => w.length > 2);
    const headlineTexts = ad.headlines.map(h => h.text.toLowerCase()).join(' ');
    const hasDealerWord = dealerWords.some(w => headlineTexts.includes(w.toLowerCase()));

    if (!hasDealerWord && dealerWords.length > 0) {
      missingDealerName.push({
        adId: ad.adId,
        campaignName: ad.campaignName,
        adGroupName: ad.adGroupName,
        dealerPortion,
      });
    }
  }

  if (shortHeadlines.length > 0) {
    findings.push({
      checkId: 'ad_copy_short_headlines',
      severity: SEVERITY.INFO,
      category: CATEGORY,
      title: 'Short headlines detected',
      message: `${shortHeadlines.length} headline(s) are under 15 characters. Use more of the 30-character limit.`,
      details: { headlines: shortHeadlines },
    });
  }

  if (allCapsHeadlines.length > 0) {
    findings.push({
      checkId: 'ad_copy_allcaps_headlines',
      severity: SEVERITY.INFO,
      category: CATEGORY,
      title: 'All-caps headlines detected',
      message: `${allCapsHeadlines.length} headline(s) are entirely uppercase. This can appear spammy.`,
      details: { headlines: allCapsHeadlines },
    });
  }

  if (missingDealerName.length > 0) {
    findings.push({
      checkId: 'ad_copy_missing_dealer_name',
      severity: SEVERITY.INFO,
      category: CATEGORY,
      title: 'RSAs missing dealer name in headlines',
      message: `${missingDealerName.length} ad(s) have no headline containing the dealer name.`,
      details: { ads: missingDealerName },
    });
  }

  return findings;
}

/**
 * Checks for excessive headline pinning in RSA ads.
 *
 * Best practice: pin dealer name to Position 1 only, leave everything else unpinned
 * so Google's ML can optimize. Flags ads with more than 2 pinned headlines.
 *
 * @param {Object[]} ads - Array of ad objects from getAdCopy
 * @returns {Object[]} Array of findings
 */
function checkPinningOveruse(ads) {
  const findings = [];
  const overPinned = [];

  for (const ad of ads) {
    const pinnedCount = ad.headlines.filter(h => h.pinnedField !== null).length;
    if (pinnedCount > 2) {
      overPinned.push({
        adId: ad.adId,
        campaignName: ad.campaignName,
        adGroupName: ad.adGroupName,
        pinnedCount,
      });
    }
  }

  if (overPinned.length > 0) {
    findings.push({
      checkId: 'ad_copy_pinning_overuse',
      severity: SEVERITY.INFO,
      category: CATEGORY,
      title: 'Excessive headline pinning',
      message: `${overPinned.length} ad(s) have more than 2 pinned headlines. Over-pinning reduces Google's optimization ability.`,
      details: { ads: overPinned },
    });
  }

  return findings;
}

module.exports = {
  checkStaleYearReferences,
  checkMissingRSAs,
  checkHeadlineQuality,
  checkPinningOveruse,
};
