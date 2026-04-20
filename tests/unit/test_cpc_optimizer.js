/**
 * Tier 2 CPC Optimizer Tests — validates CPC bid optimization logic.
 *
 * Tests: src/services/cpc-optimizer.js
 * Uses: direct function calls with sample keyword data (no fakes needed)
 */

const {
  analyzeCpcOpportunities,
  generateBidAdjustments,
  MAX_ADJUSTMENT_PERCENT,
} = require('../../src/services/cpc-optimizer');

// ── Sample data factories ──

function makeKeyword(overrides = {}) {
  return {
    keyword: 'ford f-150',
    matchType: 'EXACT',
    status: 'ENABLED',
    negative: false,
    cpcBid: 5.00,
    adGroupName: 'SD: F-150',
    adGroupId: '200',
    campaignName: 'Springfield Ford - New - F-150',
    campaignId: '100',
    clicks: 50,
    impressions: 1000,
    averageCpc: 4.50,
    ctr: 0.05,
    searchImpressionShare: 0.85,
    ...overrides,
  };
}

// ── analyzeCpcOpportunities ──

describe('analyzeCpcOpportunities', () => {
  test('identifies keywords with IS above target where CPC can be lowered', () => {
    const keywords = [
      makeKeyword({ searchImpressionShare: 0.92, cpcBid: 6.00, averageCpc: 4.50 }),
    ];
    const results = analyzeCpcOpportunities(keywords);
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('decrease');
    expect(results[0].reason).toMatch(/impression share.*above.*90%/i);
  });

  test('identifies keywords with IS below target where CPC should increase', () => {
    const keywords = [
      makeKeyword({ searchImpressionShare: 0.60, cpcBid: 3.00, averageCpc: 2.80 }),
    ];
    const results = analyzeCpcOpportunities(keywords);
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('increase');
    expect(results[0].reason).toMatch(/impression share.*below.*75%/i);
  });

  test('skips keywords already in the IS sweet spot (75-90%)', () => {
    const keywords = [
      makeKeyword({ searchImpressionShare: 0.82, cpcBid: 4.00, averageCpc: 3.50 }),
    ];
    const results = analyzeCpcOpportunities(keywords);
    expect(results.length).toBe(0);
  });

  test('skips keywords with null impression share', () => {
    const keywords = [
      makeKeyword({ searchImpressionShare: null }),
    ];
    const results = analyzeCpcOpportunities(keywords);
    expect(results.length).toBe(0);
  });

  test('skips negative keywords', () => {
    const keywords = [
      makeKeyword({ negative: true, searchImpressionShare: 0.95 }),
    ];
    const results = analyzeCpcOpportunities(keywords);
    expect(results.length).toBe(0);
  });

  test('skips paused keywords', () => {
    const keywords = [
      makeKeyword({ status: 'PAUSED', searchImpressionShare: 0.95 }),
    ];
    const results = analyzeCpcOpportunities(keywords);
    expect(results.length).toBe(0);
  });

  test('skips keywords with zero impressions', () => {
    const keywords = [
      makeKeyword({ impressions: 0, searchImpressionShare: 0.95 }),
    ];
    const results = analyzeCpcOpportunities(keywords);
    expect(results.length).toBe(0);
  });

  test('handles empty keyword list', () => {
    const results = analyzeCpcOpportunities([]);
    expect(results).toEqual([]);
  });

  test('processes multiple keywords with mixed actions', () => {
    const keywords = [
      makeKeyword({ keyword: 'high-is', searchImpressionShare: 0.95, cpcBid: 5.00 }),
      makeKeyword({ keyword: 'on-target', searchImpressionShare: 0.80 }),
      makeKeyword({ keyword: 'low-is', searchImpressionShare: 0.50, cpcBid: 2.00 }),
    ];
    const results = analyzeCpcOpportunities(keywords);
    expect(results.length).toBe(2);
    expect(results.find(r => r.keyword === 'high-is').action).toBe('decrease');
    expect(results.find(r => r.keyword === 'low-is').action).toBe('increase');
  });
});

// ── generateBidAdjustments ──

describe('generateBidAdjustments', () => {
  test('caps decrease at MAX_ADJUSTMENT_PERCENT (20%)', () => {
    const keywords = [
      makeKeyword({ searchImpressionShare: 0.99, cpcBid: 10.00, averageCpc: 5.00 }),
    ];
    const opportunities = analyzeCpcOpportunities(keywords);
    const adjustments = generateBidAdjustments(opportunities);
    expect(adjustments.length).toBe(1);
    const adj = adjustments[0];
    expect(adj.newBid).toBeGreaterThanOrEqual(10.00 * (1 - MAX_ADJUSTMENT_PERCENT / 100));
    expect(adj.newBid).toBeLessThan(10.00);
  });

  test('caps increase at MAX_ADJUSTMENT_PERCENT (20%)', () => {
    const keywords = [
      makeKeyword({ searchImpressionShare: 0.30, cpcBid: 3.00, averageCpc: 2.80 }),
    ];
    const opportunities = analyzeCpcOpportunities(keywords);
    const adjustments = generateBidAdjustments(opportunities);
    expect(adjustments.length).toBe(1);
    const adj = adjustments[0];
    expect(adj.newBid).toBeLessThanOrEqual(3.00 * (1 + MAX_ADJUSTMENT_PERCENT / 100));
    expect(adj.newBid).toBeGreaterThan(3.00);
  });

  test('respects strategy-rules CPC floor for campaign type', () => {
    // new_high floor is $3.00
    const keywords = [
      makeKeyword({
        campaignName: 'Springfield Ford - New - F-150',
        searchImpressionShare: 0.95,
        cpcBid: 3.20,
        averageCpc: 3.10,
      }),
    ];
    const opportunities = analyzeCpcOpportunities(keywords);
    const adjustments = generateBidAdjustments(opportunities);
    expect(adjustments.length).toBe(1);
    expect(adjustments[0].newBid).toBeGreaterThanOrEqual(3.00);
  });

  test('respects strategy-rules CPC ceiling for campaign type', () => {
    // new_high ceiling is $8.00
    const keywords = [
      makeKeyword({
        campaignName: 'Springfield Ford - New - F-150',
        searchImpressionShare: 0.40,
        cpcBid: 7.50,
        averageCpc: 7.00,
      }),
    ];
    const opportunities = analyzeCpcOpportunities(keywords);
    const adjustments = generateBidAdjustments(opportunities);
    expect(adjustments.length).toBe(1);
    expect(adjustments[0].newBid).toBeLessThanOrEqual(8.00);
  });

  test('generates change objects compatible with change-executor', () => {
    const keywords = [
      makeKeyword({ searchImpressionShare: 0.95, cpcBid: 5.00 }),
    ];
    const opportunities = analyzeCpcOpportunities(keywords);
    const adjustments = generateBidAdjustments(opportunities);
    const adj = adjustments[0];
    expect(adj).toHaveProperty('keyword');
    expect(adj).toHaveProperty('campaignName');
    expect(adj).toHaveProperty('adGroupName');
    expect(adj).toHaveProperty('currentBid');
    expect(adj).toHaveProperty('newBid');
    expect(adj).toHaveProperty('change');
    expect(adj).toHaveProperty('reason');
    expect(typeof adj.newBid).toBe('number');
    expect(adj.newBid).not.toBe(adj.currentBid);
  });

  test('rounds new bid to 2 decimal places', () => {
    const keywords = [
      makeKeyword({ searchImpressionShare: 0.93, cpcBid: 4.77 }),
    ];
    const opportunities = analyzeCpcOpportunities(keywords);
    const adjustments = generateBidAdjustments(opportunities);
    const bid = adjustments[0].newBid;
    expect(bid).toBe(Math.round(bid * 100) / 100);
  });

  test('handles empty opportunities list', () => {
    const adjustments = generateBidAdjustments([]);
    expect(adjustments).toEqual([]);
  });

  test('decrease proportional to how far IS is above 90%', () => {
    // IS at 95% (5% above target) should get smaller decrease than IS at 99%
    const kw95 = makeKeyword({ keyword: 'k95', searchImpressionShare: 0.95, cpcBid: 5.00 });
    const kw99 = makeKeyword({ keyword: 'k99', searchImpressionShare: 0.99, cpcBid: 5.00 });
    const opp95 = analyzeCpcOpportunities([kw95]);
    const opp99 = analyzeCpcOpportunities([kw99]);
    const adj95 = generateBidAdjustments(opp95)[0];
    const adj99 = generateBidAdjustments(opp99)[0];
    // k99 should have a bigger decrease (lower new bid)
    expect(adj99.newBid).toBeLessThan(adj95.newBid);
  });

  test('increase proportional to how far IS is below 75%', () => {
    const kw60 = makeKeyword({ keyword: 'k60', searchImpressionShare: 0.60, cpcBid: 3.00 });
    const kw40 = makeKeyword({ keyword: 'k40', searchImpressionShare: 0.40, cpcBid: 3.00 });
    const opp60 = analyzeCpcOpportunities([kw60]);
    const opp40 = analyzeCpcOpportunities([kw40]);
    const adj60 = generateBidAdjustments(opp60)[0];
    const adj40 = generateBidAdjustments(opp40)[0];
    // k40 should have a bigger increase (higher new bid)
    expect(adj40.newBid).toBeGreaterThan(adj60.newBid);
  });
});

// ── MAX_ADJUSTMENT_PERCENT ──

describe('MAX_ADJUSTMENT_PERCENT', () => {
  test('is 20', () => {
    expect(MAX_ADJUSTMENT_PERCENT).toBe(20);
  });
});
