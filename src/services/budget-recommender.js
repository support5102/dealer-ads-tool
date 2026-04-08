/**
 * Budget Recommender — generates budget adjustment recommendations
 * for dealer accounts based on account-level pacing.
 *
 * Called by: routes/pacing.js
 * Calls: services/pacing-calculator.js
 *
 * Core principle: the ENTIRE ACCOUNT must pace at 100%. Individual budget
 * pacing doesn't matter — what matters is that VLA daily budgets + shared
 * daily budgets = the required daily rate to finish the month on target.
 *
 * VLAs are priority campaigns. Their budgets are set by impression share
 * targets (75-90%). Shared budgets get whatever's left to hit the account target.
 */

const { calculatePacing, calculateProjection } = require('./pacing-calculator');
const { BUDGET_SPLITS } = require('./strategy-rules');

// Post-edit cooldown: suppress recommendations when a recent budget change
// is already trending the account toward correct pacing.
const COOLDOWN_MIN_DAYS = 3;   // Minimum post-change observation period
const COOLDOWN_MAX_DAYS = 7;   // Force re-evaluation after this many days
const COOLDOWN_TOLERANCE = 10; // Projected miss % within which edit is "working"

// VLA impression share targets — below 75% we're leaving money on the table,
// above 90% CPC inflates with diminishing returns.
const VLA_IS_TARGET = { min: 0.75, max: 0.90 };

// Max increase/cut caps per adjustment cycle
const MAX_INCREASE_MULTIPLIER = 5.0;  // Cap at 5x per cycle to prevent distorted proportional distribution
const MAX_CUT_RATIO = 0.70;          // Allow up to 70% cut per cycle to hit target pace

/**
 * Maps pacing status to dashboard color.
 * Red for extreme variance (>15% off pace), yellow for moderate.
 */
function statusToColor(status, pacePercent) {
  if (status === 'on_pace') return 'green';
  if (status === 'over' || status === 'under') {
    const paceRatio = 100 + (pacePercent || 0);
    if (paceRatio > 115 || paceRatio < 85) return 'red';
    return 'yellow';
  }
  return 'gray';
}

/**
 * Campaign priority tiers — higher number = higher priority.
 * VLAs are handled separately; these tiers apply to keyword campaigns.
 *
 * Tier 1 (lowest): General terms, regional — can be paused first
 * Tier 2: Model-specific, used, other campaigns
 * Tier 3 (highest): Brand campaigns — last to be cut
 */
const CAMPAIGN_TIERS = {
  GENERAL_REGIONAL: 1,
  OTHER: 2,
  BRAND: 3,
};

/**
 * Classifies a campaign name into a priority tier.
 * @param {string} name - Campaign name
 * @returns {number} Tier number (1=lowest, 3=highest)
 */
function getCampaignTier(name) {
  const lower = (name || '').toLowerCase();
  if (lower.includes('brand')) return CAMPAIGN_TIERS.BRAND;
  if (lower.includes('general') || lower.includes('regional') || lower.includes('conquest')) {
    return CAMPAIGN_TIERS.GENERAL_REGIONAL;
  }
  return CAMPAIGN_TIERS.OTHER;
}

/**
 * Checks if a campaign is a VLA (Vehicle Listing Ad) campaign.
 * Matches by name pattern or Google Ads channel type.
 */
function isVlaCampaign(campaign) {
  const name = (campaign.campaignName || '').toLowerCase();
  const type = (campaign.channelType || '').toUpperCase();
  return name.includes('vla') || type === 'SHOPPING' || type === 'LOCAL';
}

/**
 * Returns the highest campaign tier among campaigns in a shared budget.
 * Used to classify the whole budget for prioritized over-pacing cuts.
 * Brand budgets (tier 3) are cut less; general/regional (tier 1) are cut more.
 */
function getSharedBudgetTier(budget) {
  const campaigns = budget.campaigns || [];
  if (campaigns.length === 0) {
    // Check the budget name itself for tier hints
    return getCampaignTier(budget.name || '');
  }
  return Math.max(...campaigns.map(c => getCampaignTier(c.campaignName)));
}

/**
 * Identifies low-priority campaigns within shared budgets that could be paused
 * to free up budget when over-pacing. Returns campaign names by tier.
 */
function findPausableCampaigns(sharedBudgets, spendMap) {
  const pausable = [];
  for (const budget of (sharedBudgets || [])) {
    for (const camp of (budget.campaigns || [])) {
      const tier = getCampaignTier(camp.campaignName);
      if (tier <= CAMPAIGN_TIERS.GENERAL_REGIONAL) {
        const dailySpend = spendMap.get(String(camp.campaignId)) || 0;
        pausable.push({
          campaignName: camp.campaignName,
          budgetName: budget.name,
          tier,
          dailySpend: Math.round(dailySpend * 100) / 100,
        });
      }
    }
  }
  // Sort lowest tier first, then by highest spend (biggest savings first)
  pausable.sort((a, b) => a.tier - b.tier || b.dailySpend - a.dailySpend);
  return pausable;
}

/**
 * Summarizes impression share data across campaigns.
 */
function summarizeImpressionShare(impressionShareData) {
  if (!impressionShareData || impressionShareData.length === 0) {
    return { avgImpressionShare: null, avgBudgetLostShare: null, limitedCampaigns: [] };
  }

  const validIS = impressionShareData.filter(d => d.impressionShare != null);
  const validBLS = impressionShareData.filter(d => d.budgetLostShare != null);

  const avgImpressionShare = validIS.length > 0
    ? validIS.reduce((sum, d) => sum + d.impressionShare, 0) / validIS.length
    : null;

  const avgBudgetLostShare = validBLS.length > 0
    ? validBLS.reduce((sum, d) => sum + d.budgetLostShare, 0) / validBLS.length
    : null;

  const limitedCampaigns = impressionShareData
    .filter(d => d.budgetLostShare != null && d.budgetLostShare > 0.10)
    .map(d => d.campaignName);

  return { avgImpressionShare, avgBudgetLostShare, limitedCampaigns };
}

/**
 * Builds a lookup map of campaign spend per day (spend / daysElapsed).
 * @param {Object[]} campaignSpend - From getMonthSpend
 * @param {number} daysElapsed - Days elapsed in the month
 * @returns {Map<string, number>} campaignId → daily spend rate
 */
function buildSpendMap(campaignSpend, daysElapsed) {
  const map = new Map();
  if (!campaignSpend || daysElapsed <= 0) return map;
  for (const c of campaignSpend) {
    map.set(String(c.campaignId), (c.spend || 0) / daysElapsed);
  }
  return map;
}

/**
 * Builds a spend map from daily breakdown data, only counting days on or after
 * the last budget change. This gives the actual daily spend rate since the
 * change was made, not the full-month average.
 *
 * @param {Object[]} dailyBreakdown - From getDailySpendBreakdown (date, campaignId, campaignName, spend)
 * @param {string} changeDate - YYYY-MM-DD of the last budget change
 * @param {string[]} [excludeCampaigns] - Campaign names to exclude (lowercase)
 * @returns {Map<string, number>} campaignId → post-change daily spend rate
 */
function buildSpendMapFromDaily(dailyBreakdown, changeDate, excludeCampaigns) {
  const map = new Map();
  if (!dailyBreakdown || !changeDate) return map;

  const excludeSet = new Set((excludeCampaigns || []).map(n => n.toLowerCase()));

  // Filter to post-change rows and exclude overridden campaigns
  const postChangeRows = dailyBreakdown.filter(
    r => r.date >= changeDate && !excludeSet.has((r.campaignName || '').toLowerCase())
  );

  // Count distinct days to compute average
  const allDates = new Set(postChangeRows.map(r => r.date));
  const daysTracked = allDates.size;
  if (daysTracked === 0) return map;

  // Sum spend per campaign across post-change days
  const campaignTotals = new Map();
  for (const row of postChangeRows) {
    const id = String(row.campaignId);
    campaignTotals.set(id, (campaignTotals.get(id) || 0) + (row.spend || 0));
  }

  // Convert to daily average
  for (const [id, total] of campaignTotals) {
    map.set(id, total / daysTracked);
  }

  return map;
}

/**
 * Calculates actual daily spend for a budget by summing linked campaign spend.
 * Falls back to dailyBudget setting if no spend data is available — UNLESS
 * useActualOnly is true (post-change mode), where $0 means the campaign
 * genuinely spent nothing since the change, not that data is missing.
 *
 * @param {Object} budget - Budget with campaigns array and dailyBudget
 * @param {Map<string, number>} spendMap - campaignId → daily spend rate
 * @param {boolean} [useActualOnly] - When true, never fall back to budget setting
 * @returns {number} Actual daily spend rate (or budget setting as fallback)
 */
function actualDailySpend(budget, spendMap, useActualOnly) {
  if (spendMap.size === 0) {
    return useActualOnly ? 0 : (budget.dailyBudget || 0);
  }
  const campaigns = budget.campaigns || [];
  if (campaigns.length === 0 && budget.campaignId) {
    const spend = spendMap.get(String(budget.campaignId));
    return spend != null ? spend : (useActualOnly ? 0 : (budget.dailyBudget || 0));
  }
  if (campaigns.length === 0) {
    return useActualOnly ? 0 : (budget.dailyBudget || 0);
  }
  const totalSpend = campaigns.reduce((sum, c) => sum + (spendMap.get(String(c.campaignId)) || 0), 0);
  return totalSpend > 0 ? totalSpend : (useActualOnly ? 0 : (budget.dailyBudget || 0));
}

/**
 * Distributes the account's required daily rate across VLA and shared budgets.
 *
 * Uses ACTUAL SPEND RATES (not budget settings) as the baseline. A campaign
 * with a $200/day budget that only spends $50/day shows $50/day as current.
 *
 * Algorithm:
 * 1. Calculate account-level required daily rate (remainingBudget / daysRemaining)
 * 2. Compute actual daily spend per budget from campaign spend data
 * 3. Subtract non-VLA dedicated campaign spend (not being adjusted)
 * 4. Set VLA budgets based on impression share targets (priority)
 * 5. Distribute remainder to shared budgets proportionally
 *
 * @param {Object} params
 * @param {Object} params.pacing - Output from calculatePacing
 * @param {Object[]} [params.dedicatedBudgets] - From getDedicatedBudgets
 * @param {Object[]} [params.sharedBudgets] - From getSharedBudgets
 * @param {Object[]} [params.impressionShareData] - From getImpressionShare
 * @param {Object[]} [params.campaignSpend] - From getMonthSpend
 * @returns {Object} { recommendations, budgetSummary }
 */
function distributeAccountBudget({ pacing, dedicatedBudgets, sharedBudgets, impressionShareData, campaignSpend, dailyBreakdown, changeDate, excludeCampaigns, geoTargets, budgetSplit }) {
  if (pacing.daysRemaining === 0) {
    return { recommendations: [], budgetSummary: null };
  }

  // Use the weighted required daily rate from pacing calculator (accounts for day-of-week traffic)
  const requiredDailyRate = pacing.requiredDailyRate;
  const daysElapsed = pacing.daysElapsed || 1;

  // Fixed VLA/Keyword budget splits (e.g., Alan Jay stores)
  // When set, VLA daily target = vlaBudget / daysInMonth, keyword daily = keywordBudget / daysInMonth
  const totalDays = daysElapsed + pacing.daysRemaining;
  let vlaDailyTarget = null;
  let keywordDailyTarget = null;
  if (budgetSplit && budgetSplit.vlaBudget > 0) {
    vlaDailyTarget = budgetSplit.vlaBudget / totalDays;
    keywordDailyTarget = budgetSplit.keywordBudget / totalDays;
  }

  // Use post-change daily averages when a budget change happened this month,
  // so "Current Daily Spend" reflects actual spend since the change — not the
  // full-month average which would be skewed by pre-change rates.
  const hasPostChangeData = !!(dailyBreakdown && changeDate);
  const spendMap = hasPostChangeData
    ? buildSpendMapFromDaily(dailyBreakdown, changeDate, excludeCampaigns)
    : buildSpendMap(campaignSpend, daysElapsed);

  // When using post-change data, $0 in the spendMap means the campaign genuinely
  // spent nothing since the change — don't fall back to budget settings.
  const actualOnly = hasPostChangeData;

  // Separate VLA vs non-VLA dedicated campaigns
  const allDedicated = dedicatedBudgets || [];
  const vlaCampaigns = allDedicated.filter(isVlaCampaign);
  const nonVlaDedicated = allDedicated.filter(c => !isVlaCampaign(c));
  const nonVlaDedicatedSpend = nonVlaDedicated.reduce((s, c) => s + actualDailySpend(c, spendMap, actualOnly), 0);

  // Budget available for VLA + shared (subtract non-VLA dedicated which we don't adjust)
  const targetForAdjustable = Math.max(requiredDailyRate - nonVlaDedicatedSpend, 0);

  const currentVlaSpend = vlaCampaigns.reduce((s, c) => s + actualDailySpend(c, spendMap, actualOnly), 0);
  const budgets = sharedBudgets || [];
  const currentSharedSpend = budgets.reduce((s, b) => s + actualDailySpend(b, spendMap, actualOnly), 0);
  const currentAdjustableSpend = currentVlaSpend + currentSharedSpend;

  // Over-pacing: current actual spend exceeds the target.
  // ALL budgets must decrease, but VLAs are prioritized (smaller cut).
  const accountOverPacing = targetForAdjustable < currentAdjustableSpend;

  // When over-pacing, VLAs take a smaller percentage cut than shared budgets.
  // VLA_PROTECTION = 0.5 means VLAs lose half the percentage that shared loses.
  // Example: if shared decreases by 40%, VLAs decrease by 20%.
  const VLA_PROTECTION = 0.5;

  let vlaOverPacingRatio = 1;
  let sharedOverPacingRatio = 1;
  if (accountOverPacing) {
    if (currentVlaSpend > 0 && currentSharedSpend > 0) {
      // Guard: if both are very low (<$1/day each), the denominator collapses
      // and VLA_PROTECTION breaks down. Use fixed ratios that preserve intent.
      if (currentVlaSpend < 1 && currentSharedSpend < 1) {
        vlaOverPacingRatio = 0.95;
        sharedOverPacingRatio = Math.max(targetForAdjustable / currentAdjustableSpend, 0);
      } else {
        // Solve: VlaSpend * vlaR + SharedSpend * sharedR = target
        // With:  (1 - vlaR) = VLA_PROTECTION * (1 - sharedR)
        //   → sharedR = (target - VlaSpend * (1 - VLA_PROTECTION)) / (VlaSpend * VLA_PROTECTION + SharedSpend)
        const numerator = targetForAdjustable - currentVlaSpend * (1 - VLA_PROTECTION);
        const denominator = currentVlaSpend * VLA_PROTECTION + currentSharedSpend;
        sharedOverPacingRatio = denominator > 0 ? Math.max(numerator / denominator, 0) : 0;
        vlaOverPacingRatio = 1 - VLA_PROTECTION * (1 - sharedOverPacingRatio);
        vlaOverPacingRatio = Math.max(vlaOverPacingRatio, 0);
      }
    } else if (currentAdjustableSpend > 0) {
      // Only one type exists — it absorbs everything
      const ratio = targetForAdjustable / currentAdjustableSpend;
      vlaOverPacingRatio = ratio;
      sharedOverPacingRatio = ratio;
    }
  }

  // Build impression share lookup
  const isMap = new Map();
  (impressionShareData || []).forEach(d => isMap.set(d.campaignId, d));

  // --- Step 1: VLA budgets ---
  // Over-pacing: smaller proportional decrease (protected). IS > 90% can decrease further.
  // Under-pacing: IS-driven allocation (priority), shared gets remainder.
  const vlaAllocations = vlaCampaigns.map(campaign => {
    const campIS = isMap.get(campaign.campaignId);
    const is = campIS?.impressionShare;
    const bls = campIS?.budgetLostShare;
    const currentSpend = actualDailySpend(campaign, spendMap, actualOnly);

    let recommended;
    let reason;

    // VLA minimum floor: fixed daily target if set, else 40% allocation from strategy-rules.js
    const vlaMinFloor = vlaDailyTarget != null
      ? vlaDailyTarget / Math.max(vlaCampaigns.length, 1)
      : requiredDailyRate * (BUDGET_SPLITS.vla.min || 0.40) / Math.max(vlaCampaigns.length, 1);

    if (accountOverPacing) {
      // VLAs take a smaller cut than shared budgets
      recommended = currentSpend * vlaOverPacingRatio;
      reason = `Account over-pacing — decrease to hit $${requiredDailyRate.toFixed(2)}/day target`;

      // Cap cut at 30% per cycle — never slash VLAs aggressively
      const cutBase = Math.min(currentSpend, campaign.dailyBudget || currentSpend);
      const minAfterCut = cutBase * (1 - MAX_CUT_RATIO);
      recommended = Math.max(recommended, minAfterCut);

      // If IS > 90%, the IS reduction might be even steeper — use lower value
      // But still respect the 30% max cut cap
      if (is != null && is > VLA_IS_TARGET.max) {
        const isReduced = currentSpend * (VLA_IS_TARGET.max / is);
        const isFloor = cutBase * (1 - MAX_CUT_RATIO); // 30% cap applies to IS cuts too
        const cappedIsReduced = Math.max(isReduced, isFloor);
        if (cappedIsReduced < recommended) {
          recommended = cappedIsReduced;
          reason = `IS ${(is * 100).toFixed(1)}% exceeds 90% — reduce to avoid CPC inflation`;
        }
      }
      // Note IS issue even though we can't boost
      if (is != null && is < VLA_IS_TARGET.min) {
        reason += ` (IS ${(is * 100).toFixed(1)}% below 75% target`
          + (bls != null && bls > 0.05 ? `, ${(bls * 100).toFixed(1)}% lost to budget` : '')
          + `)`;
      }

      // VLA floor: don't cut below 40% allocation floor.
      // But if VLA is already below the floor, don't force it UP while over-pacing —
      // that would worsen over-pacing. Just don't cut it further.
      const effectiveFloor = Math.min(vlaMinFloor, campaign.dailyBudget || currentSpend);
      recommended = Math.max(recommended, effectiveFloor);
    } else {
      // Under-pacing: IS-driven allocation
      recommended = currentSpend;
      if (is != null && is < VLA_IS_TARGET.min) {
        // Cap increase at 2x current budget per cycle (prevents absurd spikes).
        // Beyond 2x, changes should happen gradually over multiple cycles.
        const rawBoost = VLA_IS_TARGET.min / Math.max(is, 0.01);
        const boost = Math.min(rawBoost, MAX_INCREASE_MULTIPLIER);
        recommended = currentSpend * boost;
        reason = `IS ${(is * 100).toFixed(1)}% below 75% target`
          + (bls != null && bls > 0.05 ? ` (${(bls * 100).toFixed(1)}% lost to budget)` : '')
          + ` — increase to capture more VLA traffic`;
        if (rawBoost > MAX_INCREASE_MULTIPLIER) {
          reason += ` (capped at ${MAX_INCREASE_MULTIPLIER}x — check feed/targeting if IS remains low)`;
        }
      } else if (is != null && is > VLA_IS_TARGET.max) {
        // IS > 90% but account is under-pacing — keep spend, note the IS.
        reason = `IS ${(is * 100).toFixed(1)}% above 90% — maintaining budget (account under-pacing)`;
      } else if (is != null) {
        reason = `IS ${(is * 100).toFixed(1)}% on target (75-90%)`;
      } else {
        reason = null;
      }
      // Under-pacing: never set below avg spend or set budget — can't pace up by cutting
      recommended = Math.max(recommended, currentSpend, campaign.dailyBudget || 0);
      // Cap increase at 2x current budget per cycle
      const maxBudget = (campaign.dailyBudget || currentSpend) * MAX_INCREASE_MULTIPLIER;
      recommended = Math.min(recommended, Math.max(maxBudget, (campaign.dailyBudget || 1) + 1));
      recommended = Math.max(recommended, 3);
    }

    // Under-pacing: VLA floor at 40% allocation, but never override the 2x cap.
    // Campaigns can't absorb huge jumps — reach the 40% target over multiple cycles.
    if (!accountOverPacing) {
      const maxPerCycle = (campaign.dailyBudget || currentSpend) * MAX_INCREASE_MULTIPLIER;
      const cappedFloor = Math.min(vlaMinFloor, maxPerCycle);
      recommended = Math.max(recommended, cappedFloor);
    }
    recommended = Math.max(recommended, 3); // Minimum $3/day for any budget
    recommended = Math.round(recommended * 100) / 100;

    return { campaign, recommended, reason, currentSpend, budgetSetting: campaign.dailyBudget };
  });

  let totalVlaRecommended = vlaAllocations.reduce((s, v) => s + v.recommended, 0);

  // Guard: VLA total can't exceed the account's required daily rate.
  // If VLAs want more than the whole account needs, scale them down proportionally
  // so shared/brand budgets still get reasonable allocations.
  if (!accountOverPacing && totalVlaRecommended > requiredDailyRate && totalVlaRecommended > 0) {
    const scaleFactor = requiredDailyRate * 0.70 / totalVlaRecommended; // VLAs get max 70% of target
    for (const v of vlaAllocations) {
      v.recommended = Math.round(v.recommended * scaleFactor * 100) / 100;
      if (!v.reason) continue;
      v.reason += ' (scaled — VLA total exceeded account target)';
    }
    totalVlaRecommended = vlaAllocations.reduce((s, v) => s + v.recommended, 0);
  }

  // --- Step 2: Shared budgets ---
  // Over-pacing: larger proportional decrease (absorbs more of the cut).
  // Under-pacing: get whatever's left after VLA allocation.
  const remainingForShared = accountOverPacing
    ? null  // not used — shared uses sharedOverPacingRatio
    : Math.max(targetForAdjustable - totalVlaRecommended, 0);

  // Build final recommendations
  const recommendations = [];

  // VLA recs — include all, even if no change needed
  vlaAllocations.forEach(v => {
    const setBudget = v.budgetSetting || 0;
    const change = Math.round((v.recommended - setBudget) * 100) / 100;
    const reason = v.reason || (Math.abs(change) < 0.01 ? 'No change needed — on pace' : 'Adjust to hit monthly budget');

    recommendations.push({
      type: 'campaign_budget',
      target: v.campaign.campaignName,
      resourceName: v.campaign.resourceName,
      budgetSetting: Math.round(setBudget * 100) / 100,
      currentDailyBudget: Math.round(v.currentSpend * 100) / 100,
      recommendedDailyBudget: v.recommended,
      change,
      reason,
      isVla: true,
    });
  });

  // Shared budget recs — when over-pacing, lower-tier budgets (general/regional)
  // get cut more aggressively than higher-tier (brand) budgets.
  // Tier weights: general/regional = 1.5x the base cut, brand = 0.6x the base cut, other = 1x
  const TIER_CUT_WEIGHTS = { [CAMPAIGN_TIERS.GENERAL_REGIONAL]: 1.5, [CAMPAIGN_TIERS.OTHER]: 1.0, [CAMPAIGN_TIERS.BRAND]: 0.6 };

  let recommendedSharedTotal = 0;
  if (budgets.length > 0) {
    // Compute IS headroom cap for each budget (max spend before IS saturates)
    function getISCap(budget, currentSpend) {
      const budgetCampaigns = budget.campaigns || [];
      const budgetISValues = budgetCampaigns
        .map(c => isMap.get(String(c.campaignId))?.impressionShare)
        .filter(v => v != null);
      if (budgetISValues.length === 0 || currentSpend <= 0) return null; // no IS data — uncapped
      const maxIS = Math.max(...budgetISValues);
      if (maxIS <= 0.50) return null; // plenty of room — uncapped
      const headroom = Math.max((1 - maxIS) / maxIS, 0.10);
      return { cap: currentSpend * (1 + headroom), maxIS };
    }

    // First pass: compute baseline values
    // Brand budgets are local-radius only — cap at 2x current spend (not IS-based).
    // They should capture branded searches but never absorb massive surplus.
    const BRAND_MAX_MULTIPLIER = 2.0;
    const sharedAllocations = budgets.map(budget => {
      const currentSpend = actualDailySpend(budget, spendMap, actualOnly);
      const tier = getSharedBudgetTier(budget);
      let isCap;
      if (tier === CAMPAIGN_TIERS.BRAND) {
        // Brand gets a spend-based cap, not IS-based — no radius suggestion
        const brandCap = Math.max(currentSpend * BRAND_MAX_MULTIPLIER, budget.dailyBudget || 0);
        isCap = { cap: brandCap, maxIS: null, isBrand: true };
      } else {
        isCap = getISCap(budget, currentSpend);
      }
      return { budget, currentSpend, tier, isCap, recommended: currentSpend, isCapped: false };
    });

    if (accountOverPacing) {
      // Over-pacing: tier-weighted cuts
      sharedAllocations.forEach(a => {
        const tierWeight = TIER_CUT_WEIGHTS[a.tier] || 1.0;
        const baseCut = 1 - sharedOverPacingRatio;
        const tierCut = Math.min(baseCut * tierWeight, MAX_CUT_RATIO);
        a.recommended = a.currentSpend * (1 - tierCut);
      });

      // Normalize to hit exact target
      const rawTotal = sharedAllocations.reduce((s, a) => s + a.recommended, 0);
      const sharedTarget = currentSharedSpend * sharedOverPacingRatio;
      if (rawTotal > 0 && Math.abs(rawTotal - sharedTarget) > 0.01) {
        const normFactor = sharedTarget / rawTotal;
        sharedAllocations.forEach(a => { a.recommended = Math.max(a.recommended * normFactor, 0.01); });
      }
    } else {
      // Under-pacing: keep all budgets at LEAST at their current set budget.
      // The account needs MORE spend, not less. Start from set budgets and
      // let the reconciliation step add the deficit proportionally.
      sharedAllocations.forEach(a => {
        a.recommended = Math.max(a.budget.dailyBudget || 0, a.currentSpend);
      });
    }

    // Round and build recommendations
    sharedAllocations.forEach(({ budget, currentSpend, recommended, tier, isCapped, isCap }) => {
      // Under-pacing: NEVER set budget below avg daily spend — can't pace up by cutting spend
      if (!accountOverPacing) {
        recommended = Math.max(recommended, currentSpend, budget.dailyBudget || 0);
      }
      recommended = Math.max(recommended, 3); // Minimum $3/day for any shared budget
      recommended = Math.round(recommended * 100) / 100;
      recommendedSharedTotal += recommended;

      const setBudget = budget.dailyBudget || 0;
      const change = Math.round((recommended - setBudget) * 100) / 100;

      const tierLabel = tier === CAMPAIGN_TIERS.GENERAL_REGIONAL ? ' (low priority — general/regional)'
        : tier === CAMPAIGN_TIERS.BRAND ? ' (brand — protected)' : '';
      const direction = change >= 0 ? 'increase' : 'decrease';

      let reason;
      let geoExpansion = null;

      if (isCapped && isCap.isBrand) {
        reason = `Brand capped at ${BRAND_MAX_MULTIPLIER}x current spend — brand only needs local coverage`;
      } else if (isCapped && isCap.maxIS >= GEO_EXPANSION_IS_THRESHOLD) {
        // IS > 85%: recommend radius expansion with specific data
        const isPercent = Math.round(isCap.maxIS * 1000) / 10;
        const geo = geoTargets || {};
        const campaigns = budget.campaigns || [];
        // Find proximity data for this budget's campaigns
        const proxies = campaigns
          .map(c => geo.proximity?.get?.(String(c.campaignId)))
          .filter(Boolean);
        const proxy = proxies.length > 0
          ? proxies.reduce((best, p) => (p.radiusMiles > best.radiusMiles ? p : best), proxies[0])
          : null;

        if (proxy && proxy.radiusMiles > 0) {
          // Calculate recommended radius: area-based scaling
          const desiredSpend = requiredDailyRate * (currentSpend / (currentSharedSpend || 1));
          const gapRatio = Math.max((desiredSpend - isCap.cap) / isCap.cap, 0);
          let newRadius = proxy.radiusMiles * Math.sqrt(1 + gapRatio);
          // Clamp and round to nearest 5mi
          newRadius = Math.min(Math.max(newRadius, proxy.radiusMiles + 5), 75);
          newRadius = Math.round(newRadius / 5) * 5;

          // Get nearby locations for this campaign
          const nearby = campaigns
            .flatMap(c => geo.nearby?.get?.(String(c.campaignId)) || [])
            .sort((a, b) => b.impressions - a.impressions)
            .slice(0, 5);

          geoExpansion = {
            currentRadiusMiles: proxy.radiusMiles,
            recommendedRadiusMiles: newRadius,
            centerCity: [proxy.city, proxy.state].filter(Boolean).join(', ') || null,
            nearbyLocations: nearby,
          };
          reason = `⚠ IS already ${isPercent}% — expand radius from ${proxy.radiusMiles}mi to ${newRadius}mi to unlock more search volume`;
        } else {
          reason = `⚠ IS already ${isPercent}% — increase targeting radius to spend more, then raise budget`;
        }
      } else if (isCapped) {
        const isPercent = Math.round(isCap.maxIS * 1000) / 10;
        reason = `IS already ${isPercent}% — limited budget headroom`;
      } else {
        // Reason will be finalized AFTER reconciliation (see below).
        // Store IS data so reason can be recomputed with final change value.
        reason = ''; // placeholder — overwritten post-reconciliation
      }

      // Compute IS data for this budget's campaigns (used for post-reconciliation reasons)
      const budgetCampaigns = budget.campaigns || [];
      const budgetISData = budgetCampaigns
        .map(c => isMap.get(String(c.campaignId)))
        .filter(Boolean);
      const avgIS = budgetISData.length > 0
        ? budgetISData.reduce((s, d) => s + (d.impressionShare || 0), 0) / budgetISData.length
        : null;
      const avgBLS = budgetISData.length > 0
        ? budgetISData.reduce((s, d) => s + (d.budgetLostShare || 0), 0) / budgetISData.length
        : null;

      const rec = {
        type: 'shared_budget',
        target: budget.name,
        resourceName: budget.resourceName,
        budgetSetting: Math.round(budget.dailyBudget * 100) / 100,
        currentDailyBudget: Math.round(currentSpend * 100) / 100,
        recommendedDailyBudget: recommended,
        change,
        tier,
        reason,
        isCapped,
        _avgIS: avgIS,       // preserved for post-reconciliation reason generation
        _avgBLS: avgBLS,     // preserved for post-reconciliation reason generation
      };
      if (geoExpansion) rec.geoExpansion = geoExpansion;
      recommendations.push(rec);
    });
  }

  // Reconciliation: ensure recommendations get ACTUAL SPEND to the target daily rate.
  // The key insight: set budgets != actual spend. Google Ads typically spends less than
  // what's set. So we need to figure out the spend-to-budget ratio and set budgets
  // high enough that actual spend hits the target.
  {
    const totalCurrentSetBudget = recommendations.reduce((s, r) => s + (r.budgetSetting || 0), 0) + nonVlaDedicatedSpend;
    const totalCurrentSpend = recommendations.reduce((s, r) => s + (r.currentDailyBudget || 0), 0) + nonVlaDedicatedSpend;

    // Spend ratio: how much of the set budget actually gets spent (e.g., 0.74 means 74%)
    const spendRatio = totalCurrentSetBudget > 0 ? totalCurrentSpend / totalCurrentSetBudget : 0.80;
    const effectiveSpendRatio = Math.max(Math.min(spendRatio, 0.95), 0.50); // clamp between 50-95%

    // What set budget total do we need so that actual spend = requiredDailyRate?
    const targetSetTotal = requiredDailyRate / effectiveSpendRatio;

    const actualRecommendedTotal = recommendations.reduce((s, r) => s + r.recommendedDailyBudget, 0) + nonVlaDedicatedSpend;
    const reconciliationGap = targetSetTotal - actualRecommendedTotal;

    if (Math.abs(reconciliationGap) > 0.50) {
      // Get all adjustable recommendations (prefer non-brand shared, then all shared, then VLA)
      let adjustableRecs = recommendations.filter(r => r.type === 'shared_budget' && !r.isCapped);
      if (adjustableRecs.length === 0) adjustableRecs = recommendations.filter(r => r.type === 'shared_budget');
      if (adjustableRecs.length === 0) adjustableRecs = recommendations.filter(r => r.type === 'campaign_budget');

      const adjustableTotal = adjustableRecs.reduce((s, r) => s + r.recommendedDailyBudget, 0);
      if (adjustableTotal > 0) {
        for (const rec of adjustableRecs) {
          const proportion = rec.recommendedDailyBudget / adjustableTotal;
          const extra = Math.round(reconciliationGap * proportion * 100) / 100;
          let adjusted = Math.round((rec.recommendedDailyBudget + extra) * 100) / 100;
          // Floor: never go below $3 or current avg spend (if under-pacing)
          if (!accountOverPacing) {
            adjusted = Math.max(adjusted, rec.currentDailyBudget || 0, rec.budgetSetting || 0, 3);
          } else {
            adjusted = Math.max(adjusted, 3);
          }
          rec.recommendedDailyBudget = adjusted;
          rec.change = Math.round((rec.recommendedDailyBudget - rec.budgetSetting) * 100) / 100;
        }
      }
    }
  }

  // Post-reconciliation: generate reason text based on FINAL change values.
  // This ensures the reason accurately describes what the recommendation does,
  // including any adjustments made by the reconciliation step above.
  for (const rec of recommendations) {
    // Skip recs that already have a meaningful reason (VLA, capped, geo-expansion)
    if (rec.reason !== '') continue;

    const avgIS = rec._avgIS;
    const avgBLS = rec._avgBLS;
    const change = rec.change;
    const tierLabel = rec.tier != null ? ` [tier ${rec.tier}]` : '';
    const direction = change > 0 ? 'increasing' : 'decreasing';

    if (Math.abs(change) < 0.01 && (avgIS == null || avgIS >= VLA_IS_TARGET.min)) {
      // Truly no change needed AND IS is acceptable (≥75%) or unknown
      rec.reason = avgIS != null
        ? `No change needed — IS ${(avgIS * 100).toFixed(1)}%${tierLabel}`
        : `No change needed — on pace${tierLabel}`;
    } else if (Math.abs(change) < 0.01 && avgIS != null && avgIS < VLA_IS_TARGET.min) {
      // No budget change but IS is below target — flag it
      rec.reason = `IS ${(avgIS * 100).toFixed(1)}% (below ${(VLA_IS_TARGET.min * 100)}% target) — may need budget or targeting review${tierLabel}`;
    } else if (avgIS != null && avgBLS != null && avgBLS > 0.10) {
      rec.reason = `IS ${(avgIS * 100).toFixed(1)}% (${(avgBLS * 100).toFixed(1)}% lost to budget) — ${direction}${tierLabel} to hit monthly budget`;
    } else if (avgIS != null) {
      rec.reason = `IS ${(avgIS * 100).toFixed(1)}% — ${direction}${tierLabel} to hit monthly budget`;
    } else {
      rec.reason = `Account needs $${requiredDailyRate.toFixed(2)}/day total — ${direction}${tierLabel} to hit monthly budget`;
    }

    // Clean up internal fields
    delete rec._avgIS;
    delete rec._avgBLS;
  }

  // When over-pacing, identify low-priority campaigns that could be paused
  const pausableCampaigns = accountOverPacing
    ? findPausableCampaigns(budgets, spendMap)
    : [];

  // Sum of all set daily budgets (VLA + shared) — what Google is configured to spend
  const totalSetBudget = vlaCampaigns.reduce((s, c) => s + (c.dailyBudget || 0), 0)
    + budgets.reduce((s, b) => s + (b.dailyBudget || 0), 0);

  // Budget allocation summary — change is relative to set budgets (what you control)
  const currentTotal = currentVlaSpend + currentSharedSpend + nonVlaDedicatedSpend;
  const recommendedTotal = totalVlaRecommended + recommendedSharedTotal + nonVlaDedicatedSpend;
  const totalChange = Math.round((recommendedTotal - totalSetBudget) * 100) / 100;

  const budgetSummary = {
    requiredDailyRate: Math.round(requiredDailyRate * 100) / 100,
    currentDailyTotal: Math.round(currentTotal * 100) / 100,
    recommendedDailyTotal: Math.round(recommendedTotal * 100) / 100,
    totalSetBudget: Math.round(totalSetBudget * 100) / 100,
    totalChange,
  };

  return { recommendations, budgetSummary, pausableCampaigns };
}

/**
 * Generates a full pacing recommendation for a dealer account.
 *
 * @param {Object} params
 * @param {Object} params.goal - DealerGoal from goal-reader
 * @param {Object[]} params.campaignSpend - From getMonthSpend
 * @param {Object[]} params.sharedBudgets - From getSharedBudgets
 * @param {Object[]} [params.dedicatedBudgets] - From getDedicatedBudgets
 * @param {Object[]} params.impressionShare - From getImpressionShare
 * @param {number|null} params.inventoryCount - Count of new vehicles
 * @param {number} params.year - Current year
 * @param {number} params.month - Current month (1-12)
 * @param {number} params.currentDay - Current day of month
 * @param {number[]} [params.dayWeights] - Custom day-of-week weights
 * @returns {Object} Full recommendation with pacing, adjustments, and status
 */
function generateRecommendation(params) {
  const {
    goal,
    campaignSpend,
    sharedBudgets,
    dedicatedBudgets,
    impressionShare,
    inventoryCount,
    year,
    month,
    currentDay,
    dayWeights,
    dailyBreakdown,
    changeDate,
    excludeCampaigns,
    geoTargets,
    budgetSplit,  // { vlaBudget, keywordBudget } — fixed dollar splits from sheet
  } = params;

  // Sum all campaign spend
  const totalSpend = (campaignSpend || []).reduce((sum, c) => sum + c.spend, 0);

  // Calculate pacing state
  const pacingParams = {
    monthlyBudget: goal.monthlyBudget,
    spendToDate: totalSpend,
    year,
    month,
    currentDay,
    currentInventory: inventoryCount,
    baselineInventory: goal.baselineInventory,
  };
  if (dayWeights) pacingParams.dayWeights = dayWeights;

  const pacing = calculatePacing(pacingParams);

  // Post-edit cooldown check: if a recent budget change is trending on-track,
  // suppress recommendations to avoid daily churn.
  if (changeDate && dailyBreakdown && dailyBreakdown.length > 0) {
    const changeDateObj = new Date(changeDate);
    const daysSinceChange = Math.floor((Date.now() - changeDateObj.getTime()) / (24 * 60 * 60 * 1000));

    if (daysSinceChange >= COOLDOWN_MIN_DAYS && daysSinceChange <= COOLDOWN_MAX_DAYS
        && pacing.daysRemaining > 5 && Math.abs(pacing.pacePercent) <= 25) {
      const projection = calculateProjection({
        monthlyBudget: goal.monthlyBudget,
        mtdSpend: totalSpend,
        dailySpend: dailyBreakdown,
        changeDate,
        year, month, currentDay,
      });

      if (projection.postChangeDailyAvg != null) {
        const projectedMiss = goal.monthlyBudget > 0
          ? Math.abs(((projection.projectedSpend - goal.monthlyBudget) / goal.monthlyBudget) * 100)
          : 0;

        if (projectedMiss <= COOLDOWN_TOLERANCE) {
          return {
            dealerName: goal.dealerName,
            totalSpend,
            pacing,
            status: pacing.paceStatus,
            statusColor: statusToColor(pacing.paceStatus, pacing.pacePercent),
            recommendations: [],
            budgetSummary: null,
            pausableCampaigns: [],
            impressionShareSummary: summarizeImpressionShare(impressionShare),
            inventory: {
              count: inventoryCount,
              modifier: pacing.inventoryModifier,
              reason: pacing.inventoryReason,
            },
            cooldown: {
              active: true,
              changeDate,
              daysSinceChange,
              postChangeDailyAvg: projection.postChangeDailyAvg,
              projectedSpend: projection.projectedSpend,
              projectedStatus: projection.projectedStatus,
              message: `Budget changed ${daysSinceChange} day(s) ago. Post-change spend ($${Math.round(projection.postChangeDailyAvg)}/day) projects to $${Math.round(projection.projectedSpend)} (${projection.projectedStatus}). No further changes needed yet.`,
            },
          };
        }
      }
    }
  }

  // Budget split info is passed through to distributeAccountBudget via the budgetSplit param
  // (no need to modify goal — the split is used directly in the VLA floor calculation)

  // Distribute account budget: VLA (priority) + shared (remainder)
  const { recommendations, budgetSummary, pausableCampaigns } = distributeAccountBudget({
    pacing,
    dedicatedBudgets,
    sharedBudgets,
    impressionShareData: impressionShare,
    campaignSpend,
    dailyBreakdown,
    changeDate,
    excludeCampaigns,
    geoTargets,
    budgetSplit,
  });

  // Impression share summary
  const impressionShareSummary = summarizeImpressionShare(impressionShare);

  return {
    dealerName: goal.dealerName,
    totalSpend,
    pacing,
    status: pacing.paceStatus,
    statusColor: statusToColor(pacing.paceStatus, pacing.pacePercent),
    recommendations,
    budgetSummary,
    pausableCampaigns,
    impressionShareSummary,
    inventory: {
      count: inventoryCount,
      modifier: pacing.inventoryModifier,
      reason: pacing.inventoryReason,
    },
    budgetSplit: budgetSplit || null,
  };
}

/**
 * Pre-check: find campaign IDs from non-brand shared budgets where IS > 85%.
 * Used to decide whether to fetch geo data (only when radius expansion is warranted).
 *
 * @param {Object[]} impressionShare - Per-campaign IS data
 * @param {Object[]} sharedBudgets - Shared budget objects with campaigns arrays
 * @returns {string[]} Campaign IDs that need geo expansion data
 */
function findISCappedCampaignIds(impressionShare, sharedBudgets) {
  if (!impressionShare || !sharedBudgets) return [];
  const GEO_EXPANSION_THRESHOLD = 0.85;

  const isMap = new Map();
  for (const item of impressionShare) {
    isMap.set(String(item.campaignId), item.impressionShare);
  }

  const campaignIds = [];
  for (const budget of sharedBudgets) {
    const tier = getSharedBudgetTier(budget);
    if (tier === CAMPAIGN_TIERS.BRAND) continue; // brand = local only, no radius expansion

    const campaigns = budget.campaigns || [];
    for (const c of campaigns) {
      const is = isMap.get(String(c.campaignId));
      if (is != null && is > GEO_EXPANSION_THRESHOLD) {
        campaignIds.push(String(c.campaignId));
      }
    }
  }
  return campaignIds;
}

// Threshold for recommending radius expansion (separate from budget IS cap at 50%)
const GEO_EXPANSION_IS_THRESHOLD = 0.85;

module.exports = {
  generateRecommendation,
  distributeAccountBudget,
  summarizeImpressionShare,
  statusToColor,
  isVlaCampaign,
  getCampaignTier,
  getSharedBudgetTier,
  buildSpendMapFromDaily,
  findISCappedCampaignIds,
  VLA_IS_TARGET,
  CAMPAIGN_TIERS,
  GEO_EXPANSION_IS_THRESHOLD,
};
