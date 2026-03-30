/**
 * Tests for ad-copy-analyzer.js — validates RSA ad copy quality checks.
 *
 * Uses a makeAd factory to build test fixtures with sensible defaults.
 */

const {
  checkStaleYearReferences,
  checkMissingRSAs,
  checkHeadlineQuality,
  checkPinningOveruse,
} = require('../../src/services/ad-copy-analyzer');

function makeAd(overrides = {}) {
  return {
    adId: '1001',
    headlines: [
      { text: 'New F-150 For Sale', pinnedField: null },
      { text: '2026 Ford F-150', pinnedField: null },
      { text: 'Test Dealer', pinnedField: 'HEADLINE_1' },
    ],
    descriptions: [
      { text: 'Great deals on new Ford F-150 trucks. Visit us today!' },
    ],
    finalUrls: ['https://dealer.com/new-f150'],
    approvalStatus: 'APPROVED',
    policyTopics: [],
    status: 'ENABLED',
    adGroupName: 'SD: F-150',
    campaignName: 'Test Dealer - New - F-150',
    ...overrides,
  };
}

function makeAdGroup(overrides = {}) {
  return {
    name: 'SD: F-150',
    campaignName: 'Test Dealer - New - F-150',
    status: 'ENABLED',
    ...overrides,
  };
}

// ──────────────────────────────────────────────
// checkStaleYearReferences
// ──────────────────────────────────────────────
describe('checkStaleYearReferences', () => {
  test('flags ad with "2024 F-150" headline as stale', () => {
    const ads = [makeAd({
      headlines: [
        { text: '2024 F-150 Deals', pinnedField: null },
        { text: 'Shop Now', pinnedField: null },
      ],
    })];
    const findings = checkStaleYearReferences(ads);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].checkId).toBe('ad_copy_stale_years');
    expect(findings[0].details.staleAds).toHaveLength(1);
    expect(findings[0].details.staleAds[0].staleYears).toContain(2024);
  });

  test('flags ad with "2025 Civic Deals" description as stale', () => {
    const ads = [makeAd({
      headlines: [{ text: 'Buy a Civic', pinnedField: null }],
      descriptions: [{ text: '2025 Civic Deals happening now!' }],
    })];
    const findings = checkStaleYearReferences(ads);
    expect(findings).toHaveLength(1);
    expect(findings[0].details.staleAds[0].staleYears).toContain(2025);
  });

  test('passes ad with "2026 F-150" headline (current year)', () => {
    const ads = [makeAd({
      headlines: [
        { text: '2026 F-150 For Sale', pinnedField: null },
      ],
    })];
    const findings = checkStaleYearReferences(ads);
    expect(findings).toHaveLength(0);
  });

  test('passes ad with "2027 F-150" headline (future year)', () => {
    const ads = [makeAd({
      headlines: [
        { text: '2027 F-150 Preview', pinnedField: null },
      ],
    })];
    const findings = checkStaleYearReferences(ads);
    expect(findings).toHaveLength(0);
  });

  test('does not flag phone number containing "2025"', () => {
    const ads = [makeAd({
      headlines: [{ text: 'Call Now', pinnedField: null }],
      descriptions: [{ text: 'Call us at 2025551234 today!' }],
    })];
    const findings = checkStaleYearReferences(ads);
    // Should have no stale year findings (phone number "2025551234" is not a year)
    const staleFindings = findings.filter(f => f.checkId === 'ad_copy_stale_years');
    expect(staleFindings).toHaveLength(0);
  });

  test('returns empty array when no ads provided', () => {
    const findings = checkStaleYearReferences([]);
    expect(findings).toHaveLength(0);
  });

  test('counts each stale ad only once even with multiple stale years', () => {
    const ads = [makeAd({
      headlines: [
        { text: '2024 and 2023 Models', pinnedField: null },
      ],
    })];
    const findings = checkStaleYearReferences(ads);
    expect(findings).toHaveLength(1);
    expect(findings[0].details.staleAds).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────
// checkMissingRSAs
// ──────────────────────────────────────────────
describe('checkMissingRSAs', () => {
  test('flags enabled ad group with 0 RSAs as warning', () => {
    const ads = [];
    const adGroups = [makeAdGroup()];
    const findings = checkMissingRSAs(ads, adGroups);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].checkId).toBe('ad_copy_missing_rsa');
    expect(findings[0].details.adGroups).toHaveLength(1);
  });

  test('flags enabled ad group with 1 RSA as info', () => {
    const ads = [makeAd()];
    const adGroups = [makeAdGroup()];
    const findings = checkMissingRSAs(ads, adGroups);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('info');
    expect(findings[0].checkId).toBe('ad_copy_single_rsa');
  });

  test('passes ad group with 2+ active RSAs', () => {
    const ads = [
      makeAd({ adId: '1001' }),
      makeAd({ adId: '1002' }),
    ];
    const adGroups = [makeAdGroup()];
    const findings = checkMissingRSAs(ads, adGroups);
    expect(findings).toHaveLength(0);
  });

  test('ignores paused ad groups', () => {
    const ads = [];
    const adGroups = [makeAdGroup({ status: 'PAUSED' })];
    const findings = checkMissingRSAs(ads, adGroups);
    expect(findings).toHaveLength(0);
  });

  test('does not count paused ads as active RSAs', () => {
    const ads = [makeAd({ status: 'PAUSED' })];
    const adGroups = [makeAdGroup()];
    const findings = checkMissingRSAs(ads, adGroups);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
  });

  test('does not count disapproved ads as active RSAs', () => {
    const ads = [makeAd({ approvalStatus: 'DISAPPROVED' })];
    const adGroups = [makeAdGroup()];
    const findings = checkMissingRSAs(ads, adGroups);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
  });

  test('returns findings for multiple ad groups with mixed states', () => {
    const ads = [makeAd({ adGroupName: 'AG2', campaignName: 'Camp B' })];
    const adGroups = [
      makeAdGroup(), // 0 RSAs
      makeAdGroup({ name: 'AG2', campaignName: 'Camp B' }), // 1 RSA
    ];
    const findings = checkMissingRSAs(ads, adGroups);
    expect(findings).toHaveLength(2);
    const severities = findings.map(f => f.severity).sort();
    expect(severities).toEqual(['info', 'warning']);
  });
});

// ──────────────────────────────────────────────
// checkHeadlineQuality
// ──────────────────────────────────────────────
describe('checkHeadlineQuality', () => {
  test('flags short headline under 15 characters', () => {
    const ads = [makeAd({
      headlines: [
        { text: 'Buy Now', pinnedField: null },
        { text: '2026 Ford F-150 Deals', pinnedField: null },
        { text: 'Test Dealer', pinnedField: null },
      ],
    })];
    const findings = checkHeadlineQuality(ads);
    const shortFinding = findings.find(f => f.checkId === 'ad_copy_short_headlines');
    expect(shortFinding).toBeDefined();
    expect(shortFinding.severity).toBe('info');
    expect(shortFinding.details.headlines).toHaveLength(2); // "Buy Now" (7) and "Test Dealer" (11)
  });

  test('flags all-caps headline', () => {
    const ads = [makeAd({
      headlines: [
        { text: 'BUY A NEW F-150 TODAY', pinnedField: null },
        { text: 'Normal Headline Here', pinnedField: null },
        { text: 'Test Dealer', pinnedField: null },
      ],
    })];
    const findings = checkHeadlineQuality(ads);
    const capsFinding = findings.find(f => f.checkId === 'ad_copy_allcaps_headlines');
    expect(capsFinding).toBeDefined();
    expect(capsFinding.details.headlines).toHaveLength(1);
    expect(capsFinding.details.headlines[0].headline).toBe('BUY A NEW F-150 TODAY');
  });

  test('normal headline passes all quality checks', () => {
    const ads = [makeAd({
      headlines: [
        { text: 'New Ford F-150 For Sale', pinnedField: null },
        { text: 'Great Deals At Test Dealer', pinnedField: null },
        { text: 'Shop Test Dealer Today', pinnedField: null },
      ],
    })];
    const findings = checkHeadlineQuality(ads);
    expect(findings).toHaveLength(0);
  });

  test('flags ad missing dealer name in headlines', () => {
    const ads = [makeAd({
      campaignName: 'Sunrise Ford - New - F-150',
      headlines: [
        { text: 'New F-150 For Sale', pinnedField: null },
        { text: 'Great Deals On Trucks', pinnedField: null },
        { text: 'Shop Today For Savings', pinnedField: null },
      ],
    })];
    const findings = checkHeadlineQuality(ads);
    const dealerFinding = findings.find(f => f.checkId === 'ad_copy_wrong_dealer_name');
    expect(dealerFinding).toBeDefined();
    expect(dealerFinding.details.ads[0].dealerPortion).toBe('Sunrise Ford');
  });

  test('dealer name check is case-insensitive', () => {
    const ads = [makeAd({
      campaignName: 'Sunrise Ford - New - F-150',
      headlines: [
        { text: 'sunrise ford has deals', pinnedField: null },
      ],
    })];
    const findings = checkHeadlineQuality(ads);
    const dealerFinding = findings.find(f => f.checkId === 'ad_copy_wrong_dealer_name');
    expect(dealerFinding).toBeUndefined();
  });

  test('does not flag all-caps when headline has no letters', () => {
    const ads = [makeAd({
      headlines: [
        { text: '(555) 123-4567', pinnedField: null },
        { text: 'Test Dealer Is Great', pinnedField: null },
        { text: 'Another Good Headline', pinnedField: null },
      ],
    })];
    const findings = checkHeadlineQuality(ads);
    const capsFinding = findings.find(f => f.checkId === 'ad_copy_allcaps_headlines');
    expect(capsFinding).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// checkPinningOveruse
// ──────────────────────────────────────────────
describe('checkPinningOveruse', () => {
  test('flags ad with pinned headlines beyond position 1', () => {
    const ads = [makeAd({
      headlines: [
        { text: 'Test Dealer', pinnedField: 'HEADLINE_1' },
        { text: 'New F-150', pinnedField: 'HEADLINE_2' },
        { text: 'Call Today', pinnedField: 'HEADLINE_3' },
      ],
    })];
    const findings = checkPinningOveruse(ads);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].checkId).toBe('ad_copy_pinning_overuse');
    expect(findings[0].details.ads[0].pinnedCount).toBe(3);
  });

  test('passes ad with 1 pinned headline', () => {
    const ads = [makeAd({
      headlines: [
        { text: 'Test Dealer', pinnedField: 'HEADLINE_1' },
        { text: 'New F-150', pinnedField: null },
        { text: 'Call Today', pinnedField: null },
      ],
    })];
    const findings = checkPinningOveruse(ads);
    expect(findings).toHaveLength(0);
  });

  test('passes ad with 0 pinned headlines', () => {
    const ads = [makeAd({
      headlines: [
        { text: 'Test Dealer', pinnedField: null },
        { text: 'New F-150', pinnedField: null },
        { text: 'Call Today', pinnedField: null },
      ],
    })];
    const findings = checkPinningOveruse(ads);
    expect(findings).toHaveLength(0);
  });

  test('passes ad with only dealer name pinned at HEADLINE_1', () => {
    const ads = [makeAd({
      headlines: [
        { text: 'Test Dealer', pinnedField: 'HEADLINE_1' },
        { text: 'New F-150', pinnedField: null },
        { text: 'Call Today', pinnedField: null },
      ],
    })];
    const findings = checkPinningOveruse(ads);
    expect(findings).toHaveLength(0);
  });

  test('counts multiple over-pinned ads separately', () => {
    const ads = [
      makeAd({
        adId: '1001',
        headlines: [
          { text: 'A', pinnedField: 'HEADLINE_1' },
          { text: 'B', pinnedField: 'HEADLINE_2' },
          { text: 'C', pinnedField: 'HEADLINE_3' },
        ],
      }),
      makeAd({
        adId: '1002',
        headlines: [
          { text: 'D', pinnedField: 'HEADLINE_1' },
          { text: 'E', pinnedField: 'HEADLINE_2' },
          { text: 'F', pinnedField: 'HEADLINE_3' },
          { text: 'G', pinnedField: 'HEADLINE_1' },
        ],
      }),
    ];
    const findings = checkPinningOveruse(ads);
    expect(findings).toHaveLength(1);
    expect(findings[0].details.ads).toHaveLength(2);
  });
});
