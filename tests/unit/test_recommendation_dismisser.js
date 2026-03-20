/**
 * Tier 2 Recommendation Dismisser Tests — validates auto-dismissal of strategy-conflicting recs.
 *
 * Tests: src/services/recommendation-dismisser.js
 * Uses: direct function calls with sample recommendation data (no fakes needed)
 */

const {
  classifyRecommendations,
  ALWAYS_DISMISS_TYPES,
  ALWAYS_KEEP_TYPES,
} = require('../../src/services/recommendation-dismisser');

// ── Sample data factories ──

function makeRecommendation(overrides = {}) {
  return {
    resourceName: 'customers/123/recommendations/456',
    type: 'KEYWORD',
    campaignResourceName: 'customers/123/campaigns/100',
    adGroupResourceName: null,
    ...overrides,
  };
}

// ── classifyRecommendations ──

describe('classifyRecommendations', () => {
  test('marks broad match recommendations for dismissal', () => {
    const recs = [makeRecommendation({ type: 'USE_BROAD_MATCH_KEYWORD' })];
    const { toDismiss, toReview } = classifyRecommendations(recs);
    expect(toDismiss.length).toBe(1);
    expect(toDismiss[0].dismissReason).toMatch(/broad match/i);
    expect(toReview.length).toBe(0);
  });

  test('marks ECPC upgrade recommendations for dismissal', () => {
    const recs = [makeRecommendation({ type: 'ENHANCED_CPC_OPT_IN' })];
    const { toDismiss } = classifyRecommendations(recs);
    expect(toDismiss.length).toBe(1);
    expect(toDismiss[0].dismissReason).toMatch(/ECPC|enhanced/i);
  });

  test('marks maximize conversions switch for dismissal', () => {
    const recs = [makeRecommendation({ type: 'MAXIMIZE_CONVERSIONS_OPT_IN' })];
    const { toDismiss } = classifyRecommendations(recs);
    expect(toDismiss.length).toBe(1);
  });

  test('marks target CPA switch for dismissal', () => {
    const recs = [makeRecommendation({ type: 'TARGET_CPA_OPT_IN' })];
    const { toDismiss } = classifyRecommendations(recs);
    expect(toDismiss.length).toBe(1);
  });

  test('marks target ROAS switch for dismissal', () => {
    const recs = [makeRecommendation({ type: 'TARGET_ROAS_OPT_IN' })];
    const { toDismiss } = classifyRecommendations(recs);
    expect(toDismiss.length).toBe(1);
  });

  test('marks maximize clicks switch for dismissal', () => {
    const recs = [makeRecommendation({ type: 'MAXIMIZE_CLICKS_OPT_IN' })];
    const { toDismiss } = classifyRecommendations(recs);
    expect(toDismiss.length).toBe(1);
  });

  test('puts unknown recommendation types in review queue', () => {
    const recs = [makeRecommendation({ type: 'SOME_NEW_TYPE' })];
    const { toDismiss, toReview } = classifyRecommendations(recs);
    expect(toDismiss.length).toBe(0);
    expect(toReview.length).toBe(1);
  });

  test('keeps ad-related recommendations for review', () => {
    const recs = [makeRecommendation({ type: 'TEXT_AD' })];
    const { toDismiss, toReview } = classifyRecommendations(recs);
    expect(toDismiss.length).toBe(0);
    expect(toReview.length).toBe(1);
  });

  test('handles empty recommendations list', () => {
    const { toDismiss, toReview } = classifyRecommendations([]);
    expect(toDismiss).toEqual([]);
    expect(toReview).toEqual([]);
  });

  test('preserves resource names for API dismissal', () => {
    const recs = [makeRecommendation({
      type: 'USE_BROAD_MATCH_KEYWORD',
      resourceName: 'customers/123/recommendations/789',
    })];
    const { toDismiss } = classifyRecommendations(recs);
    expect(toDismiss[0].resourceName).toBe('customers/123/recommendations/789');
  });

  test('handles mixed recommendations correctly', () => {
    const recs = [
      makeRecommendation({ type: 'USE_BROAD_MATCH_KEYWORD', resourceName: 'rec1' }),
      makeRecommendation({ type: 'TEXT_AD', resourceName: 'rec2' }),
      makeRecommendation({ type: 'ENHANCED_CPC_OPT_IN', resourceName: 'rec3' }),
      makeRecommendation({ type: 'KEYWORD', resourceName: 'rec4' }),
    ];
    const { toDismiss, toReview } = classifyRecommendations(recs);
    expect(toDismiss.length).toBe(2); // broad match + ECPC
    expect(toReview.length).toBe(2);  // text_ad + keyword
  });
});

// ── ALWAYS_DISMISS_TYPES ──

describe('ALWAYS_DISMISS_TYPES', () => {
  test('includes all strategy-conflicting recommendation types', () => {
    expect(ALWAYS_DISMISS_TYPES).toContain('USE_BROAD_MATCH_KEYWORD');
    expect(ALWAYS_DISMISS_TYPES).toContain('ENHANCED_CPC_OPT_IN');
    expect(ALWAYS_DISMISS_TYPES).toContain('MAXIMIZE_CONVERSIONS_OPT_IN');
    expect(ALWAYS_DISMISS_TYPES).toContain('TARGET_CPA_OPT_IN');
    expect(ALWAYS_DISMISS_TYPES).toContain('TARGET_ROAS_OPT_IN');
    expect(ALWAYS_DISMISS_TYPES).toContain('MAXIMIZE_CLICKS_OPT_IN');
  });

  test('does not include keyword or ad recommendations', () => {
    expect(ALWAYS_DISMISS_TYPES).not.toContain('KEYWORD');
    expect(ALWAYS_DISMISS_TYPES).not.toContain('TEXT_AD');
    expect(ALWAYS_DISMISS_TYPES).not.toContain('RESPONSIVE_SEARCH_AD');
  });
});
