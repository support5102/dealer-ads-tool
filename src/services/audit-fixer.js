/**
 * Audit Fixer — diagnoses audit findings and generates smart fix recommendations.
 *
 * Called by: routes/audit.js (POST /api/audit/fix)
 * Calls: services/change-executor.js for applying fixes
 *        services/strategy-rules.js for CPC target ranges
 *
 * Instead of blindly pausing things, each finding is diagnosed to determine
 * WHY the issue exists and what the best remediation is.
 */

const { CPC_RANGES } = require('./strategy-rules');
const { classifyCampaign, CAMPAIGN_TYPES } = require('./campaign-classifier');

/**
 * Maps a campaign type to its CPC range from strategy-rules.
 */
function getCpcRange(campaignName) {
  const type = classifyCampaign(campaignName);
  switch (type) {
    case CAMPAIGN_TYPES.BRAND: return CPC_RANGES.brand;
    case CAMPAIGN_TYPES.COMP: return CPC_RANGES.competitor;
    case CAMPAIGN_TYPES.REGIONAL: return CPC_RANGES.regional;
    case CAMPAIGN_TYPES.GENERAL: return CPC_RANGES.general;
    case CAMPAIGN_TYPES.SERVICE: return CPC_RANGES.general;
    case CAMPAIGN_TYPES.VLA: return { min: 0.50, max: 2.50 }; // VLA max CPC from settings
    default: return CPC_RANGES.new_low; // safe default for model keywords
  }
}

/**
 * Diagnoses a finding and returns fix recommendations.
 *
 * @param {Object} finding - The audit finding from audit-engine
 * @param {Object} diagnostics - Additional diagnostic data (keywords, campaigns, etc.)
 * @returns {Object} { fixable, fixes[], manualNotes[] }
 *   fixes[]: { action, description, changeType, details }
 *   manualNotes[]: string descriptions of issues requiring human intervention
 */
function diagnose(finding, diagnostics = {}) {
  switch (finding.checkId) {
    case 'broad_match_keywords':
      return diagnoseBroadMatch(finding);
    case 'zero_impression_keywords':
      return diagnoseZeroImpressions(finding, diagnostics.keywords || []);
    case 'zero_spend_campaigns':
      return diagnoseZeroSpend(finding, diagnostics.campaignDiagnostics || []);
    case 'high_cpc_keywords':
      return diagnoseHighCpc(finding, diagnostics.keywords || []);
    case 'low_ctr_campaigns':
      return diagnoseLowCtr(finding, diagnostics.adCopy || [], diagnostics.keywords || []);
    case 'pending_recommendations':
      return diagnosePendingRecommendations(finding);
    case 'IRRELEVANT_SEARCH_TERMS':
      return diagnoseIrrelevantSearchTerms(finding);
    case 'NEG_CONFLICT':
      return { fixable: false, fixes: [], manualNotes: ['Negative keyword is blocking an active positive keyword. Review and remove the negative if the positive keyword should be active.'] };
    case 'BLOCKED_CONVERTING_TERMS':
      return { fixable: false, fixes: [], manualNotes: ['A negative keyword is blocking a search term that previously converted. Review and remove the negative to restore converting traffic.'] };
    case 'KW_CANNIBALIZATION':
      return { fixable: false, fixes: [], manualNotes: ['The same keyword appears in multiple ad groups within one campaign. Consolidate to one ad group to avoid internal competition.'] };
    case 'MISSING_COMPETING_NEGS':
      return { fixable: false, fixes: [], manualNotes: ['Campaign is missing competing-make negative keywords for traffic sculpting. Add negatives for competitor brands.'] };
    case 'ad_copy_allcaps_headlines':
      return diagnoseAllCapsHeadlines(finding, diagnostics.adCopy || []);
    case 'ad_copy_stale_years':
      return diagnoseStaleYears(finding, diagnostics.adCopy || []);
    case 'ad_copy_pinning_overuse':
      return diagnosePinningOveruse(finding, diagnostics.adCopy || []);
    case 'ad_copy_short_headlines':
      return diagnoseShortHeadlines(finding, diagnostics.adCopy || []);
    case 'disapproved_ads':
      return { fixable: false, fixes: [], manualNotes: ['Disapproved ads require manual policy review. Check the Google Ads policy center for specific violations.'] };
    case 'bidding_not_manual_cpc':
    case 'ecpc_enabled':
      return { fixable: false, fixes: [], manualNotes: ['Changing bidding strategy mid-flight can disrupt campaign learning. Review manually and change during a low-traffic period.'] };
    case 'low_impression_share_critical':
    case 'low_impression_share_warning':
      return { fixable: false, fixes: [], manualNotes: ['Low impression share is handled by the Budget Auto-Adjuster. Go to Pacing → Auto-Adjuster to review budget recommendations.'] };
    case 'missing_ad_schedule':
      return { fixable: false, fixes: [], manualNotes: ['Ad schedules should be set based on dealer business hours. Set Mon-Fri 8:30am-7pm, Sat 8:30am-8:30pm, Sun off per strategy guide.'] };
    default:
      return { fixable: false, fixes: [], manualNotes: ['No automated fix available for this finding.'] };
  }
}

/**
 * Broad match keywords — always pause. Strategy requires EXACT/PHRASE only.
 */
function diagnoseBroadMatch(finding) {
  const byCampaign = finding.details?.byCampaign || {};
  const fixes = [];

  for (const [campaignName, keywords] of Object.entries(byCampaign)) {
    for (const keyword of keywords) {
      fixes.push({
        action: 'pause',
        description: `Pause BROAD keyword "${keyword}" in ${campaignName}`,
        changeType: 'pause_keyword',
        details: { keyword, matchType: 'BROAD' },
        campaignName,
      });
    }
  }

  return {
    fixable: fixes.length > 0,
    fixes,
    manualNotes: fixes.length > 0
      ? ['After pausing, consider adding these as EXACT or PHRASE match if relevant.']
      : [],
  };
}

/**
 * Zero-impression keywords — diagnose WHY before acting.
 */
function diagnoseZeroImpressions(finding, allKeywords) {
  const sample = finding.details?.sample || [];
  const fixes = [];
  const manualNotes = [];

  for (const item of sample) {
    // Find full keyword data with quality score and bid estimates
    const full = allKeywords.find(
      k => k.keyword === item.keyword && k.campaignName === item.campaign
    );

    if (!full) {
      fixes.push({
        action: 'pause',
        description: `Pause "${item.keyword}" [${item.matchType}] — no diagnostic data available`,
        changeType: 'pause_keyword',
        details: { keyword: item.keyword, matchType: item.matchType },
        campaignName: item.campaign,
      });
      continue;
    }

    if (full.approvalStatus === 'DISAPPROVED') {
      manualNotes.push(`"${item.keyword}" in ${item.campaign} is disapproved — review policy violation`);
      continue;
    }

    if (full.qualityScore != null && full.qualityScore < 4) {
      fixes.push({
        action: 'pause',
        description: `Pause "${item.keyword}" — quality score ${full.qualityScore}/10 (too low to compete)`,
        changeType: 'pause_keyword',
        details: { keyword: item.keyword, matchType: item.matchType },
        campaignName: item.campaign,
      });
      continue;
    }

    if (full.firstPageBid != null && full.cpcBid < full.firstPageBid) {
      fixes.push({
        action: 'increase_bid',
        description: `Increase bid for "${item.keyword}" from $${full.cpcBid.toFixed(2)} to $${full.firstPageBid.toFixed(2)} (first page estimate)`,
        changeType: 'update_keyword_bid',
        details: {
          keyword: item.keyword,
          matchType: item.matchType,
          newBid: full.firstPageBid.toFixed(2),
        },
        campaignName: item.campaign,
      });
      continue;
    }

    // No clear diagnosis — pause as last resort
    fixes.push({
      action: 'pause',
      description: `Pause "${item.keyword}" [${item.matchType}] — 0 impressions with no clear cause`,
      changeType: 'pause_keyword',
      details: { keyword: item.keyword, matchType: item.matchType },
      campaignName: item.campaign,
    });
  }

  return { fixable: fixes.length > 0, fixes, manualNotes };
}

/**
 * Zero-spend campaigns — diagnose structure issues.
 */
function diagnoseZeroSpend(finding, campaignDiagnostics) {
  const campaigns = finding.details?.campaigns || [];
  const fixes = [];
  const manualNotes = [];

  for (const camp of campaigns) {
    const diag = campaignDiagnostics.find(d => d.campaignName === camp.campaignName);

    if (!diag) {
      fixes.push({
        action: 'pause',
        description: `Pause "${camp.campaignName}" — no diagnostic data, not serving`,
        changeType: 'pause_campaign',
        details: {},
        campaignName: camp.campaignName,
      });
      continue;
    }

    if (diag.budget === 0) {
      manualNotes.push(`"${camp.campaignName}" has $0 budget — set a budget to enable spending`);
      continue;
    }

    if (diag.enabledAdGroups === 0) {
      manualNotes.push(`"${camp.campaignName}" has no enabled ad groups — enable or create ad groups`);
      continue;
    }

    if (diag.enabledKeywords === 0 && camp.channelType === 'SEARCH') {
      manualNotes.push(`"${camp.campaignName}" has no enabled keywords — add keywords to start serving`);
      continue;
    }

    if (diag.disapprovedKeywords > 0 && diag.disapprovedKeywords >= diag.enabledKeywords) {
      manualNotes.push(`"${camp.campaignName}" — most keywords are disapproved. Review policy violations.`);
      continue;
    }

    // Structure looks fine but still not spending — could be billing, policy, or auction issue
    manualNotes.push(`"${camp.campaignName}" has budget ($${diag.budget}/day), ${diag.enabledKeywords} keywords, ${diag.enabledAdGroups} ad groups but no spend. Check billing, account status, or audience targeting.`);
  }

  return { fixable: fixes.length > 0, fixes, manualNotes };
}

/**
 * High CPC keywords — recommend lowering bids to strategy-rules CPC ranges.
 */
function diagnoseHighCpc(finding, allKeywords) {
  const items = finding.details?.keywords || [];
  const fixes = [];
  const manualNotes = [];

  for (const item of items) {
    const full = allKeywords.find(
      k => k.keyword === item.keyword && k.campaignName === item.campaign
    );

    const cpcRange = getCpcRange(item.campaign);
    const currentCpc = item.averageCpc || full?.averageCpc || 0;
    let recommendedBid;

    if (full?.firstPageBid != null && full.firstPageBid < cpcRange.max) {
      // First page bid is within acceptable range — use it with small margin
      recommendedBid = Math.min(full.firstPageBid * 1.2, cpcRange.max);
    } else {
      // No bid estimate or it's above range — use the max of the range
      recommendedBid = cpcRange.max;
    }

    recommendedBid = Math.round(recommendedBid * 100) / 100;

    if (currentCpc > recommendedBid * 1.1) {
      fixes.push({
        action: 'lower_bid',
        description: `Lower bid for "${item.keyword}" to $${recommendedBid.toFixed(2)} (${classifyCampaign(item.campaign)} range: $${cpcRange.min}-$${cpcRange.max})`,
        changeType: 'update_keyword_bid',
        details: {
          keyword: item.keyword,
          matchType: item.matchType,
          newBid: recommendedBid.toFixed(2),
        },
        campaignName: item.campaign,
      });
    } else {
      manualNotes.push(`"${item.keyword}" CPC $${currentCpc.toFixed(2)} is near target range — monitor before adjusting`);
    }
  }

  return { fixable: fixes.length > 0, fixes, manualNotes };
}

/**
 * Low CTR campaigns — diagnose cause and recommend specific fixes.
 */
function diagnoseLowCtr(finding, adCopy, allKeywords) {
  const campaigns = finding.details?.campaigns || [];
  const manualNotes = [];
  const fixes = [];

  for (const camp of campaigns) {
    const reasons = [];

    // Check ad copy count for this campaign
    const campaignAds = adCopy.filter(
      a => a.campaignName === camp.campaignName && a.status === 'ENABLED'
    );
    if (campaignAds.length < 3) {
      reasons.push(`Only ${campaignAds.length} active ad(s) — Google recommends 3+ RSAs per ad group for optimal rotation`);
    }

    // Check for disapproved ads
    const disapproved = campaignAds.filter(a => a.approvalStatus === 'DISAPPROVED');
    if (disapproved.length > 0) {
      reasons.push(`${disapproved.length} disapproved ad(s) reducing available inventory`);
    }

    // Check keyword quality scores
    const campKeywords = allKeywords.filter(
      k => k.campaignName === camp.campaignName && !k.negative && k.status === 'ENABLED'
    );
    const lowQuality = campKeywords.filter(k => k.qualityScore != null && k.qualityScore < 5);
    if (lowQuality.length > 0) {
      reasons.push(`${lowQuality.length} keyword(s) with quality score below 5 — poor ad relevance`);
      // Suggest pausing the worst ones
      for (const kw of lowQuality.slice(0, 3)) {
        fixes.push({
          action: 'pause',
          description: `Pause low-quality keyword "${kw.keyword}" (QS: ${kw.qualityScore}/10) in ${camp.campaignName}`,
          changeType: 'pause_keyword',
          details: { keyword: kw.keyword, matchType: kw.matchType },
          campaignName: camp.campaignName,
        });
      }
    }

    // Check impression share — low IS + low CTR = budget issue, not ad issue
    if (camp.impressionShare != null && camp.impressionShare < 0.50) {
      reasons.push(`Impression share ${Math.round(camp.impressionShare * 100)}% — low visibility may be reducing CTR. Check budget via Auto-Adjuster.`);
    }

    if (reasons.length === 0) {
      reasons.push('No specific cause identified — review ad copy relevance and landing page experience');
    }

    manualNotes.push(`${camp.campaignName} (CTR: ${(camp.ctr * 100).toFixed(1)}%): ${reasons.join('. ')}`);
  }

  return { fixable: fixes.length > 0, fixes, manualNotes };
}

/**
 * Pending recommendations — dismiss all.
 */
function diagnosePendingRecommendations(finding) {
  const manualNotes = ['Dismissed recommendations to maintain optimization score. Review recommendation types periodically.'];
  // Note: we need recommendation resource names to dismiss, which aren't in the current finding details.
  // The fix route will fetch fresh recommendations and dismiss them.
  return {
    fixable: true,
    fixes: [{
      action: 'dismiss_all',
      description: `Dismiss ${finding.details?.count || 0} pending recommendations`,
      changeType: 'dismiss_recommendations_batch',
      details: { count: finding.details?.count || 0, types: finding.details?.types || [] },
      campaignName: null,
    }],
    manualNotes,
  };
}

/**
 * Irrelevant search terms — add as negative keywords.
 */
function diagnoseIrrelevantSearchTerms(finding) {
  const terms = finding.details?.terms || [];
  const fixes = [];

  for (const term of terms) {
    fixes.push({
      action: 'add_negative',
      description: `Add negative "${term.searchTerm}" to ${term.campaignName} (${term.reason}, $${term.cost} wasted)`,
      changeType: 'add_negative_keyword',
      details: { keyword: term.searchTerm, matchType: 'PHRASE' },
      campaignName: term.campaignName,
    });
  }

  return {
    fixable: fixes.length > 0,
    fixes,
    manualNotes: fixes.length > 0
      ? ['Review each term before applying — some may have indirect value. Fixes add as PHRASE match negatives.']
      : [],
  };
}

// ── Ad copy fix helpers ──

/** Convert text to Title Case */
function toTitleCase(text) {
  return text.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * All-caps headlines — convert to Title Case.
 */
function diagnoseAllCapsHeadlines(finding, adCopy) {
  const flagged = finding.details?.headlines || [];
  const fixes = [];
  const manualNotes = [];

  // Group by adId to batch fixes per ad
  const adMap = new Map();
  for (const item of flagged) {
    if (!adMap.has(item.adId)) adMap.set(item.adId, { ...item, flaggedTexts: [] });
    adMap.get(item.adId).flaggedTexts.push(item.headline);
  }

  for (const [adId, info] of adMap) {
    const fullAd = adCopy.find(a => a.adId === adId);
    if (!fullAd) { manualNotes.push(`Could not find ad ${adId} — fix manually.`); continue; }

    const fixedHeadlines = fullAd.headlines.map(h => ({
      text: info.flaggedTexts.includes(h.text) ? toTitleCase(h.text) : h.text,
      ...(h.pinnedField ? { pinnedField: h.pinnedField } : {}),
    }));

    fixes.push({
      action: 'update_rsa',
      description: `Title-case ${info.flaggedTexts.length} all-caps headline(s) in "${info.adGroupName}" (${info.campaignName})`,
      changeType: 'update_rsa',
      campaignName: info.campaignName,
      adGroupName: info.adGroupName,
      details: {
        adId,
        headlines: fixedHeadlines,
        descriptions: fullAd.descriptions.map(d => ({ text: d.text, ...(d.pinnedField ? { pinnedField: d.pinnedField } : {}) })),
        finalUrls: fullAd.finalUrls || [],
      },
    });
  }

  if (manualNotes.length === 0 && fixes.length > 0) {
    manualNotes.push('Acronyms (AWD, 4WD, etc.) may need manual review after title-casing.');
  }

  return { fixable: fixes.length > 0, fixes, manualNotes };
}

/**
 * Stale year references — replace old years with current year.
 */
function diagnoseStaleYears(finding, adCopy) {
  const staleAds = finding.details?.staleAds || [];
  const fixes = [];
  const manualNotes = [];
  const currentYear = new Date().getFullYear();

  for (const item of staleAds) {
    const fullAd = adCopy.find(a => a.adId === item.adId);
    if (!fullAd) { manualNotes.push(`Could not find ad ${item.adId} — fix manually.`); continue; }

    const replaceYears = (text) => {
      return text.replace(/(?<!\d)(20\d{2})(?!\d)/g, (match) => {
        const y = parseInt(match);
        return item.staleYears.includes(y) ? String(currentYear) : match;
      });
    };

    fixes.push({
      action: 'update_rsa',
      description: `Update year ${item.staleYears.join(', ')} → ${currentYear} in "${item.adGroupName}" (${item.campaignName})`,
      changeType: 'update_rsa',
      campaignName: item.campaignName,
      adGroupName: item.adGroupName,
      details: {
        adId: item.adId,
        headlines: fullAd.headlines.map(h => ({ text: replaceYears(h.text), ...(h.pinnedField ? { pinnedField: h.pinnedField } : {}) })),
        descriptions: fullAd.descriptions.map(d => ({ text: replaceYears(d.text), ...(d.pinnedField ? { pinnedField: d.pinnedField } : {}) })),
        finalUrls: fullAd.finalUrls || [],
      },
    });
  }

  return { fixable: fixes.length > 0, fixes, manualNotes };
}

/**
 * Pinning overuse — unpin all headlines except dealer name at HEADLINE_1.
 */
function diagnosePinningOveruse(finding, adCopy) {
  const pinnedAds = finding.details?.ads || [];
  const fixes = [];
  const manualNotes = [];

  for (const item of pinnedAds) {
    const fullAd = adCopy.find(a => a.adId === item.adId);
    if (!fullAd) { manualNotes.push(`Could not find ad ${item.adId} — fix manually.`); continue; }

    // Keep only the first HEADLINE_1 pin (dealer name), unpin everything else
    let keptFirstPin = false;
    const fixedHeadlines = fullAd.headlines.map(h => {
      if (h.pinnedField === 'HEADLINE_1' && !keptFirstPin) {
        keptFirstPin = true;
        return { text: h.text, pinnedField: 'HEADLINE_1' };
      }
      return { text: h.text }; // no pinnedField = unpinned
    });

    const unpinCount = item.pinnedCount - (keptFirstPin ? 1 : 0);
    fixes.push({
      action: 'update_rsa',
      description: `Unpin ${unpinCount} headline(s) in "${item.adGroupName}" (${item.campaignName}) — keep dealer name at Position 1`,
      changeType: 'update_rsa',
      campaignName: item.campaignName,
      adGroupName: item.adGroupName,
      details: {
        adId: item.adId,
        headlines: fixedHeadlines,
        descriptions: fullAd.descriptions.map(d => ({ text: d.text, ...(d.pinnedField ? { pinnedField: d.pinnedField } : {}) })),
        finalUrls: fullAd.finalUrls || [],
      },
    });
  }

  return { fixable: fixes.length > 0, fixes, manualNotes };
}

/**
 * Short headlines — remove if ad has >3 headlines, else flag for manual review.
 */
function diagnoseShortHeadlines(finding, adCopy) {
  const flagged = finding.details?.headlines || [];
  const fixes = [];
  const manualNotes = [];

  // Group by adId
  const adMap = new Map();
  for (const item of flagged) {
    if (!adMap.has(item.adId)) adMap.set(item.adId, { ...item, shortTexts: [] });
    adMap.get(item.adId).shortTexts.push(item.headline);
  }

  for (const [adId, info] of adMap) {
    const fullAd = adCopy.find(a => a.adId === adId);
    if (!fullAd) { manualNotes.push(`Could not find ad ${adId} — fix manually.`); continue; }

    // Count how many headlines would remain after removing short ones
    const remaining = fullAd.headlines.filter(h => !info.shortTexts.includes(h.text));
    if (remaining.length >= 3) {
      fixes.push({
        action: 'update_rsa',
        description: `Remove ${info.shortTexts.length} short headline(s) from "${info.adGroupName}" (${info.campaignName}) — ${remaining.length} headlines remain`,
        changeType: 'update_rsa',
        campaignName: info.campaignName,
        adGroupName: info.adGroupName,
        details: {
          adId,
          headlines: remaining.map(h => ({ text: h.text, ...(h.pinnedField ? { pinnedField: h.pinnedField } : {}) })),
          descriptions: fullAd.descriptions.map(d => ({ text: d.text, ...(d.pinnedField ? { pinnedField: d.pinnedField } : {}) })),
          finalUrls: fullAd.finalUrls || [],
        },
      });
    } else {
      manualNotes.push(`"${info.adGroupName}" (${info.campaignName}) has ${info.shortTexts.length} short headline(s) but only ${fullAd.headlines.length} total — removing would drop below 3. Replace manually.`);
    }
  }

  return { fixable: fixes.length > 0, fixes, manualNotes };
}

module.exports = {
  diagnose,
  getCpcRange,
};
