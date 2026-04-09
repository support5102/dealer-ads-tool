/**
 * Tier 2 Deep Scanner Tests — validates deep scan orchestration logic.
 *
 * Tests: src/services/deep-scanner.js
 * Mocks: google-ads, audit-engine, negative-keyword-analyzer, ad-copy-analyzer
 */

const googleAds = require('../../src/services/google-ads');
const auditEngine = require('../../src/services/audit-engine');
const negAnalyzer = require('../../src/services/negative-keyword-analyzer');
const adCopyAnalyzer = require('../../src/services/ad-copy-analyzer');

jest.mock('../../src/services/google-ads');
jest.mock('../../src/services/audit-engine');
jest.mock('../../src/services/negative-keyword-analyzer');
jest.mock('../../src/services/ad-copy-analyzer');

const { runDeepScan } = require('../../src/services/deep-scanner');

const FAKE_REST_CTX = {
  accessToken: 'tok',
  developerToken: 'dev',
  customerId: '1234567890',
  loginCustomerId: '999',
};

const AUDIT_FINDING = {
  checkId: 'bidding_not_manual_cpc',
  severity: 'critical',
  category: 'bidding',
  title: 'Not using Manual CPC',
  message: 'Campaign using wrong strategy',
};

const NEG_FINDING = {
  checkId: 'negative_conflicts',
  severity: 'warning',
  category: 'negative_keywords',
  title: 'Negative blocks active keyword',
  message: 'Negative "honda" blocks keyword "honda civic"',
};

const AD_FINDING = {
  checkId: 'stale_year_references',
  severity: 'warning',
  category: 'ad_copy',
  title: 'Stale year in ad',
  message: 'Ad references 2024',
};

const AUDIT_RESULT = {
  findings: [AUDIT_FINDING],
  summary: { total: 1, critical: 1, warning: 0, info: 0 },
  ranAt: '2026-03-19T12:00:00.000Z',
  accountId: '1234567890',
  checksRun: ['bidding_strategy', 'broad_match'],
};

function setupMocks() {
  auditEngine.runAudit.mockResolvedValue(AUDIT_RESULT);
  googleAds.getCampaignNegatives.mockResolvedValue([{ keyword: 'honda', matchType: 'BROAD' }]);
  googleAds.getAdGroupAdCounts.mockResolvedValue([{ adGroupName: 'AG1', campaignName: 'C1', activeRsaCount: 1, totalRsaCount: 1 }]);
  googleAds.getKeywordPerformance.mockResolvedValue([{ keyword: 'honda civic', campaignName: 'C1' }]);
  googleAds.getAdCopy.mockResolvedValue([{ headline1: 'Buy Now 2024' }]);
  negAnalyzer.analyzeNegativeConflicts.mockReturnValue([NEG_FINDING]);
  negAnalyzer.analyzeCannibalization.mockReturnValue([]);
  negAnalyzer.analyzeTrafficSculpting.mockReturnValue([]);
  adCopyAnalyzer.checkStaleYearReferences.mockReturnValue([AD_FINDING]);
  adCopyAnalyzer.checkMissingRSAs.mockReturnValue([]);
  adCopyAnalyzer.checkHeadlineQuality.mockReturnValue([]);
  adCopyAnalyzer.checkPinningOveruse.mockReturnValue([]);
}

describe('runDeepScan', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupMocks();
  });

  test('calls runAudit with the provided restCtx', async () => {
    await runDeepScan(FAKE_REST_CTX);
    expect(auditEngine.runAudit).toHaveBeenCalledWith(FAKE_REST_CTX);
  });

  test('fetches all 4 additional data sources', async () => {
    await runDeepScan(FAKE_REST_CTX);
    expect(googleAds.getCampaignNegatives).toHaveBeenCalledWith(FAKE_REST_CTX);
    expect(googleAds.getAdGroupAdCounts).toHaveBeenCalledWith(FAKE_REST_CTX);
    expect(googleAds.getKeywordPerformance).toHaveBeenCalledWith(FAKE_REST_CTX);
    expect(googleAds.getAdCopy).toHaveBeenCalledWith(FAKE_REST_CTX);
  });

  test('merges findings from audit + negative + ad copy analysis', async () => {
    const result = await runDeepScan(FAKE_REST_CTX);
    expect(result.findings).toHaveLength(3);
    expect(result.findings[0]).toEqual(AUDIT_FINDING);
    expect(result.findings[1]).toEqual(NEG_FINDING);
    expect(result.findings[2]).toEqual(AD_FINDING);
  });

  test('summary counts are correct across all sources', async () => {
    const result = await runDeepScan(FAKE_REST_CTX);
    expect(result.summary.total).toBe(3);
    expect(result.summary.critical).toBe(1);
    expect(result.summary.warning).toBe(2);
    expect(result.summary.info).toBe(0);
  });

  test('handles getCampaignNegatives failure gracefully', async () => {
    googleAds.getCampaignNegatives.mockRejectedValue(new Error('API error'));
    negAnalyzer.analyzeNegativeConflicts.mockReturnValue([]);
    negAnalyzer.analyzeTrafficSculpting.mockReturnValue([]);

    const result = await runDeepScan(FAKE_REST_CTX);
    // Should still succeed with audit + ad findings
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
  });

  test('handles getAdGroupAdCounts failure gracefully', async () => {
    googleAds.getAdGroupAdCounts.mockRejectedValue(new Error('API error'));

    const result = await runDeepScan(FAKE_REST_CTX);
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
  });

  test('handles getKeywordPerformance failure gracefully', async () => {
    googleAds.getKeywordPerformance.mockRejectedValue(new Error('API error'));
    negAnalyzer.analyzeNegativeConflicts.mockReturnValue([]);
    negAnalyzer.analyzeCannibalization.mockReturnValue([]);
    negAnalyzer.analyzeTrafficSculpting.mockReturnValue([]);

    const result = await runDeepScan(FAKE_REST_CTX);
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
  });

  test('handles getAdCopy failure gracefully', async () => {
    googleAds.getAdCopy.mockRejectedValue(new Error('API error'));
    adCopyAnalyzer.checkStaleYearReferences.mockReturnValue([]);
    adCopyAnalyzer.checkMissingRSAs.mockReturnValue([]);
    adCopyAnalyzer.checkHeadlineQuality.mockReturnValue([]);
    adCopyAnalyzer.checkPinningOveruse.mockReturnValue([]);

    const result = await runDeepScan(FAKE_REST_CTX);
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
  });

  test('returns correct scanType', async () => {
    const result = await runDeepScan(FAKE_REST_CTX);
    expect(result.scanType).toBe('deep');
  });

  test('returns checksRun combining audit engine + deep scan checks', async () => {
    const result = await runDeepScan(FAKE_REST_CTX);
    expect(result.checksRun).toEqual([
      'bidding_strategy', 'broad_match',
      'negative_conflicts', 'cannibalization', 'traffic_sculpting',
      'stale_year_references', 'missing_rsas', 'headline_quality', 'pinning_overuse',
    ]);
  });

  test('returns accountId from restCtx', async () => {
    const result = await runDeepScan(FAKE_REST_CTX);
    expect(result.accountId).toBe('1234567890');
  });

  test('returns ranAt as ISO timestamp', async () => {
    const result = await runDeepScan(FAKE_REST_CTX);
    expect(result.ranAt).toBeDefined();
    expect(new Date(result.ranAt).toISOString()).toBe(result.ranAt);
  });

  test('passes ad group data built from adGroupAdCounts to checkMissingRSAs', async () => {
    googleAds.getAdGroupAdCounts.mockResolvedValue([
      { adGroupName: 'AG1', campaignName: 'C1', activeRsaCount: 1, totalRsaCount: 1, adGroupId: '10' },
      { adGroupName: 'AG2', campaignName: 'C2', activeRsaCount: 0, totalRsaCount: 0, adGroupId: '20' },
    ]);

    await runDeepScan(FAKE_REST_CTX);

    expect(adCopyAnalyzer.checkMissingRSAs).toHaveBeenCalledWith(
      expect.any(Array),
      expect.arrayContaining([
        expect.objectContaining({ name: 'AG1', campaignName: 'C1', status: 'ENABLED' }),
        expect.objectContaining({ name: 'AG2', campaignName: 'C2', status: 'ENABLED' }),
      ])
    );
  });
});
