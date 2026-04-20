/**
 * Tests for negative-keyword-analyzer.js — conflict detection, cannibalization,
 * and traffic sculpting analysis.
 */

const {
  analyzeNegativeConflicts,
  analyzeCannibalization,
  analyzeTrafficSculpting,
  doesNegativeBlock,
} = require('../../src/services/negative-keyword-analyzer');

// ─────────────────────────────────────────────────────────────
// doesNegativeBlock (internal helper)
// ─────────────────────────────────────────────────────────────

describe('doesNegativeBlock', () => {
  test('exact match blocks identical keyword', () => {
    expect(doesNegativeBlock('ford f-150', 'EXACT', 'ford f-150')).toBe(true);
  });

  test('exact match does not block different keyword', () => {
    expect(doesNegativeBlock('ford f-150', 'EXACT', 'new ford f-150')).toBe(false);
  });

  test('phrase match blocks keyword containing phrase', () => {
    expect(doesNegativeBlock('ford f-150', 'PHRASE', 'new ford f-150 for sale')).toBe(true);
  });

  test('phrase match blocks exact same text', () => {
    expect(doesNegativeBlock('ford f-150', 'PHRASE', 'ford f-150')).toBe(true);
  });

  test('phrase match does not block partial word overlap', () => {
    expect(doesNegativeBlock('ford f-150', 'PHRASE', 'ford f-250')).toBe(false);
  });

  test('matching is case insensitive', () => {
    expect(doesNegativeBlock('Ford F-150', 'EXACT', 'ford f-150')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// analyzeNegativeConflicts
// ─────────────────────────────────────────────────────────────

describe('analyzeNegativeConflicts', () => {
  const makeKeyword = (overrides) => ({
    keyword: 'ford f-150',
    matchType: 'EXACT',
    campaignName: 'Ford - New - F-150',
    adGroupName: 'SD: F-150 Exact',
    status: 'ENABLED',
    negative: false,
    ...overrides,
  });

  const makeNegative = (overrides) => ({
    keyword: 'ford f-150',
    matchType: 'EXACT',
    campaignName: 'Ford - New - F-150',
    ...overrides,
  });

  test('detects exact match conflict in same campaign', () => {
    const keywords = [makeKeyword()];
    const negatives = [makeNegative()];

    const results = analyzeNegativeConflicts(keywords, negatives);
    expect(results).toHaveLength(1);
    expect(results[0].checkId).toBe('NEG_CONFLICT');
    expect(results[0].severity).toBe('critical');
    expect(results[0].details.blockedKeyword).toBe('ford f-150');
    expect(results[0].details.blockingNegative).toBe('ford f-150');
  });

  test('detects phrase match conflict in same campaign', () => {
    const keywords = [makeKeyword({ keyword: 'new ford f-150 for sale' })];
    const negatives = [makeNegative({ matchType: 'PHRASE' })];

    const results = analyzeNegativeConflicts(keywords, negatives);
    expect(results).toHaveLength(1);
    expect(results[0].details.blockedKeyword).toBe('new ford f-150 for sale');
  });

  test('no conflict when negative is in different campaign', () => {
    const keywords = [makeKeyword()];
    const negatives = [makeNegative({ campaignName: 'Ford - Used - F-150' })];

    const results = analyzeNegativeConflicts(keywords, negatives);
    expect(results).toHaveLength(0);
  });

  test('paused keyword is not flagged', () => {
    const keywords = [makeKeyword({ status: 'PAUSED' })];
    const negatives = [makeNegative()];

    const results = analyzeNegativeConflicts(keywords, negatives);
    expect(results).toHaveLength(0);
  });

  test('negative keywords in keyword list are ignored as positives', () => {
    const keywords = [makeKeyword({ negative: true })];
    const negatives = [makeNegative()];

    const results = analyzeNegativeConflicts(keywords, negatives);
    expect(results).toHaveLength(0);
  });

  test('no conflict when negative does not match', () => {
    const keywords = [makeKeyword({ keyword: 'honda civic' })];
    const negatives = [makeNegative()];

    const results = analyzeNegativeConflicts(keywords, negatives);
    expect(results).toHaveLength(0);
  });

  test('handles empty inputs gracefully', () => {
    expect(analyzeNegativeConflicts([], [])).toHaveLength(0);
    expect(analyzeNegativeConflicts(null, null)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// analyzeCannibalization
// ─────────────────────────────────────────────────────────────

describe('analyzeCannibalization', () => {
  const makeKeyword = (overrides) => ({
    keyword: 'ford f-150',
    matchType: 'EXACT',
    campaignName: 'Ford - New - F-150',
    adGroupName: 'SD: F-150 Exact',
    status: 'ENABLED',
    negative: false,
    ...overrides,
  });

  test('detects same keyword in multiple ad groups within same campaign', () => {
    const keywords = [
      makeKeyword({ adGroupName: 'SD: F-150 Exact' }),
      makeKeyword({ adGroupName: 'SD: F-150 Phrase' }),
    ];

    const results = analyzeCannibalization(keywords);
    expect(results).toHaveLength(1);
    expect(results[0].checkId).toBe('KW_CANNIBALIZATION');
    expect(results[0].severity).toBe('warning');
    expect(results[0].details.adGroups).toEqual(['SD: F-150 Exact', 'SD: F-150 Phrase']);
  });

  test('same keyword in 3 ad groups reports all three', () => {
    const keywords = [
      makeKeyword({ adGroupName: 'AG1' }),
      makeKeyword({ adGroupName: 'AG2' }),
      makeKeyword({ adGroupName: 'AG3' }),
    ];

    const results = analyzeCannibalization(keywords);
    expect(results).toHaveLength(1);
    expect(results[0].details.count).toBe(3);
  });

  test('different keywords are not flagged', () => {
    const keywords = [
      makeKeyword({ keyword: 'ford f-150', adGroupName: 'AG1' }),
      makeKeyword({ keyword: 'ford f-250', adGroupName: 'AG2' }),
    ];

    const results = analyzeCannibalization(keywords);
    expect(results).toHaveLength(0);
  });

  test('same keyword in different campaigns is not flagged', () => {
    const keywords = [
      makeKeyword({ campaignName: 'Campaign A', adGroupName: 'AG1' }),
      makeKeyword({ campaignName: 'Campaign B', adGroupName: 'AG2' }),
    ];

    const results = analyzeCannibalization(keywords);
    expect(results).toHaveLength(0);
  });

  test('paused keywords are not checked', () => {
    const keywords = [
      makeKeyword({ adGroupName: 'AG1', status: 'PAUSED' }),
      makeKeyword({ adGroupName: 'AG2', status: 'PAUSED' }),
    ];

    const results = analyzeCannibalization(keywords);
    expect(results).toHaveLength(0);
  });

  test('keyword comparison is case insensitive', () => {
    const keywords = [
      makeKeyword({ keyword: 'Ford F-150', adGroupName: 'AG1' }),
      makeKeyword({ keyword: 'ford f-150', adGroupName: 'AG2' }),
    ];

    const results = analyzeCannibalization(keywords);
    expect(results).toHaveLength(1);
  });

  test('handles empty input', () => {
    expect(analyzeCannibalization([])).toHaveLength(0);
    expect(analyzeCannibalization(null)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// analyzeTrafficSculpting
// ─────────────────────────────────────────────────────────────

describe('analyzeTrafficSculpting', () => {
  test('flags campaign missing competing-make negatives', () => {
    const campaignNames = ['Ford of Springfield - New - F-150'];
    const campaignNegatives = []; // no negatives at all

    const results = analyzeTrafficSculpting([], campaignNegatives, campaignNames);
    expect(results).toHaveLength(1);
    expect(results[0].checkId).toBe('MISSING_COMPETING_NEGS');
    expect(results[0].severity).toBe('warning');
    expect(results[0].details.dealerMake).toBe('ford');
    expect(results[0].details.missingMakes).toContain('toyota');
    expect(results[0].details.missingMakes).not.toContain('ford');
  });

  test('no finding when all competing negatives are present', () => {
    const campaignNames = ['Ford of Springfield - New - F-150'];
    const { getCompetingMakes } = require('../../src/services/strategy-rules');
    const competingMakes = getCompetingMakes('ford');

    const campaignNegatives = competingMakes.map(make => ({
      keyword: make,
      matchType: 'PHRASE',
      campaignName: 'Ford of Springfield - New - F-150',
    }));

    const results = analyzeTrafficSculpting([], campaignNegatives, campaignNames);
    expect(results).toHaveLength(0);
  });

  test('PMax campaigns are skipped', () => {
    const campaignNames = ['PMax: VLA Ads - Ford'];
    const results = analyzeTrafficSculpting([], [], campaignNames);
    expect(results).toHaveLength(0);
  });

  test('campaigns with undetectable make are skipped', () => {
    const campaignNames = ['Springfield Auto - General'];
    const results = analyzeTrafficSculpting([], [], campaignNames);
    expect(results).toHaveLength(0);
  });

  test('reports partial missing negatives', () => {
    const campaignNames = ['Honda of Springfield - New - Civic'];
    const campaignNegatives = [
      { keyword: 'ford', matchType: 'PHRASE', campaignName: 'Honda of Springfield - New - Civic' },
      { keyword: 'toyota', matchType: 'PHRASE', campaignName: 'Honda of Springfield - New - Civic' },
    ];

    const results = analyzeTrafficSculpting([], campaignNegatives, campaignNames);
    expect(results).toHaveLength(1);
    // ford and toyota are present, so they should NOT be in missingMakes
    expect(results[0].details.missingMakes).not.toContain('ford');
    expect(results[0].details.missingMakes).not.toContain('toyota');
    // chevrolet should still be missing
    expect(results[0].details.missingMakes).toContain('chevrolet');
  });

  test('handles empty inputs', () => {
    expect(analyzeTrafficSculpting([], [], [])).toHaveLength(0);
    expect(analyzeTrafficSculpting(null, null, null)).toHaveLength(0);
  });

  test('checks multiple campaigns independently', () => {
    const campaignNames = [
      'Ford of Springfield - New - F-150',
      'Ford of Springfield - Used - Escape',
    ];

    const results = analyzeTrafficSculpting([], [], campaignNames);
    expect(results).toHaveLength(2);
    expect(results[0].details.campaignName).toBe('Ford of Springfield - New - F-150');
    expect(results[1].details.campaignName).toBe('Ford of Springfield - Used - Escape');
  });
});
