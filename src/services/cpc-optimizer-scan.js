/**
 * CPC Optimizer Scan — MCC-wide campaign-level CPC opportunity scan.
 *
 * Called by: routes/cpc-optimizer.js (GET /api/cpc-optimizer/scan)
 * Calls:     google-ads.js (refreshAccessToken, getCampaignPerformance)
 *
 * Strategy: Brian's playbook is "crash all CPCs to the floor, then raise only
 * the campaigns where the floor is leaving impressions on the table." The
 * signal for "raise this CPC" is metrics.search_rank_lost_impression_share —
 * the share of search impressions you missed because your bid was too low.
 *
 * If rank-lost-IS is high AND budget-lost-IS is low, the ceiling is bid, not
 * budget. That's an actionable "raise CPC" target. If budget-lost-IS is the
 * dominant signal, the bid isn't the problem — that goes to a different
 * page (budget reallocation).
 */

const googleAds = require('./google-ads');

const FLAG_THRESHOLDS = {
  // Flag campaigns where we lost ≥15% of impressions to RANK (low bid)…
  rankLostPctMin: 15,
  // …AND where budget wasn't the dominant loss reason (<5% lost to budget).
  budgetLostPctMax: 5,
  // Below this impression count the metric is statistically noisy.
  minImpressions: 100,
};

/**
 * Scans every dealer account under the MCC and returns campaign-level CPC
 * opportunities. Runs queries in bounded-concurrency parallel to keep the
 * total scan under the request timeout.
 *
 * @param {Object} params
 * @param {string} params.accessToken - OAuth access token
 * @param {string} params.developerToken - Google Ads developer token
 * @param {string} params.mccId - Login customer ID (MCC)
 * @param {Object[]} params.accounts - [{ id, name }, ...] dealer accounts
 * @param {number} [params.concurrency=6] - Max parallel customer queries
 * @returns {Promise<{ scannedAt, accountsScanned, accountsFailed, campaigns }>}
 */
async function scanCpcOptimizer({ accessToken, developerToken, mccId, accounts, concurrency = 6 }) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return { scannedAt: new Date().toISOString(), accountsScanned: 0, accountsFailed: 0, campaigns: [] };
  }

  const allCampaigns = [];
  const failures = [];
  let cursor = 0;

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= accounts.length) return;
      const acct = accounts[idx];
      try {
        const customerId = String(acct.id || '').replace(/-/g, '');
        if (!/^\d{7,10}$/.test(customerId)) continue;
        const perf = await googleAds.getCampaignPerformance({
          accessToken, developerToken, customerId, loginCustomerId: mccId,
        });
        for (const p of perf) {
          if (p.status !== 'ENABLED') continue;
          allCampaigns.push(annotateCampaign(p, acct));
        }
      } catch (err) {
        failures.push({ account: acct.name || acct.id, error: err.message });
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, accounts.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Default sort: largest "raise CPC" opportunity first.
  // Use rank-lost-IS × impressions as the opportunity-size proxy.
  allCampaigns.sort((a, b) => (b.opportunityScore - a.opportunityScore));

  return {
    scannedAt: new Date().toISOString(),
    accountsScanned: accounts.length - failures.length,
    accountsFailed: failures.length,
    failures,
    campaigns: allCampaigns,
    flagThresholds: FLAG_THRESHOLDS,
  };
}

/**
 * Annotates a raw campaign-performance row with dealer info, computed
 * percentages, and the flag/opportunity-score fields the UI consumes.
 */
function annotateCampaign(perf, acct) {
  const rankLostPct = perf.searchRankLostImpressionShare != null
    ? perf.searchRankLostImpressionShare * 100 : null;
  const budgetLostPct = perf.searchBudgetLostImpressionShare != null
    ? perf.searchBudgetLostImpressionShare * 100 : null;
  const searchISPct = perf.searchImpressionShare != null
    ? perf.searchImpressionShare * 100 : null;

  const flagged =
    rankLostPct != null &&
    budgetLostPct != null &&
    perf.impressions >= FLAG_THRESHOLDS.minImpressions &&
    rankLostPct >= FLAG_THRESHOLDS.rankLostPctMin &&
    budgetLostPct <= FLAG_THRESHOLDS.budgetLostPctMax;

  // Opportunity score = impressions you could have captured if rank-lost went
  // to zero. Approximates how many extra impressions a CPC raise would unlock.
  // Used only for sort order; the user-facing flag is binary (above).
  const opportunityScore = (rankLostPct != null && perf.impressions > 0)
    ? (rankLostPct / 100) * perf.impressions
    : 0;

  return {
    customerId: String(acct.id || ''),
    dealerName: acct.name || '',
    campaignId: perf.campaignId,
    campaignName: perf.campaignName,
    channelType: perf.channelType,
    biddingStrategy: perf.biddingStrategy,
    impressions: perf.impressions,
    clicks: perf.clicks,
    averageCpc: Math.round(perf.averageCpc * 100) / 100,
    cost: Math.round(perf.cost * 100) / 100,
    searchISPct: roundPct(searchISPct),
    rankLostPct: roundPct(rankLostPct),
    budgetLostPct: roundPct(budgetLostPct),
    opportunityScore: Math.round(opportunityScore),
    flagged,
    flagReason: flagged ? 'raise_cpc' : null,
  };
}

function roundPct(v) {
  return v == null ? null : Math.round(v * 10) / 10;
}

module.exports = {
  scanCpcOptimizer,
  FLAG_THRESHOLDS,
};
