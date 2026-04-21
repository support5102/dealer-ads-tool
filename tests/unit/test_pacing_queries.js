/**
 * Unit tests for pacing GAQL query functions in google-ads.js.
 *
 * Tier 2 (unit): uses _queryFn injection with fake data, no real API calls.
 * Data is in REST/camelCase format (what Google Ads REST API returns).
 *
 * Tests: getMonthSpend, getSharedBudgets, getImpressionShare, getInventory,
 *        getAccountLevelDailyBudget
 */

const {
  getMonthSpend,
  getSharedBudgets,
  getImpressionShare,
  getInventory,
  getAccountLevelDailyBudget,
} = require('../../src/services/google-ads');

/**
 * Creates a restCtx with a fake query function that returns the given rows.
 */
function fakeCtx(rows) {
  return {
    accessToken: 'fake-token',
    developerToken: 'fake-dev',
    customerId: '1234567890',
    loginCustomerId: '9999999999',
    _queryFn: async () => rows,
  };
}

// ===========================================================================
// getMonthSpend
// ===========================================================================

describe('getMonthSpend', () => {
  const defaultRows = [
    { campaign: { id: '100', name: 'Honda Civic - Search', status: 'ENABLED' }, metrics: { costMicros: 5000000 } },
    { campaign: { id: '200', name: 'Toyota Trucks', status: 'PAUSED' }, metrics: { costMicros: 3200000 } },
  ];

  test('returns MTD spend per campaign in dollars', async () => {
    const results = await getMonthSpend(fakeCtx(defaultRows));

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      campaignId: '100',
      campaignName: 'Honda Civic - Search',
      status: 'ENABLED',
      spend: 5.00,
    });
    expect(results[1]).toEqual({
      campaignId: '200',
      campaignName: 'Toyota Trucks',
      status: 'PAUSED',
      spend: 3.20,
    });
  });

  test('converts costMicros to dollars correctly', async () => {
    const results = await getMonthSpend(fakeCtx([
      { campaign: { id: '1', name: 'Test', status: 'ENABLED' }, metrics: { costMicros: 1 } },
      { campaign: { id: '2', name: 'Test2', status: 'ENABLED' }, metrics: { costMicros: 999999 } },
      { campaign: { id: '3', name: 'Test3', status: 'ENABLED' }, metrics: { costMicros: 1000000 } },
    ]));

    expect(results[0].spend).toBeCloseTo(0.000001, 6);
    expect(results[1].spend).toBeCloseTo(0.999999, 6);
    expect(results[2].spend).toBe(1.00);
  });

  test('returns empty array when no campaigns have spend', async () => {
    const results = await getMonthSpend(fakeCtx([]));
    expect(results).toEqual([]);
  });

  test('handles zero spend', async () => {
    const results = await getMonthSpend(fakeCtx([
      { campaign: { id: '1', name: 'Zero Spend', status: 'ENABLED' }, metrics: { costMicros: 0 } },
    ]));
    expect(results[0].spend).toBe(0);
  });

  test('handles null costMicros as zero', async () => {
    const results = await getMonthSpend(fakeCtx([
      { campaign: { id: '1', name: 'No Data', status: 'ENABLED' }, metrics: { costMicros: null } },
    ]));
    expect(results[0].spend).toBe(0);
  });

  test('coerces campaign ID to string', async () => {
    const results = await getMonthSpend(fakeCtx([
      { campaign: { id: 12345, name: 'Numeric ID', status: 'ENABLED' }, metrics: { costMicros: 1000000 } },
    ]));
    expect(results[0].campaignId).toBe('12345');
  });

  test('normalizes integer status enum to string', async () => {
    const results = await getMonthSpend(fakeCtx([
      { campaign: { id: '1', name: 'Numeric Status', status: 2 }, metrics: { costMicros: 1000000 } },
    ]));
    expect(results[0].status).toBe('ENABLED');
  });

  test('handles large spend values', async () => {
    const results = await getMonthSpend(fakeCtx([
      { campaign: { id: '1', name: 'Big Spender', status: 'ENABLED' }, metrics: { costMicros: 50000000000 } },
    ]));
    expect(results[0].spend).toBe(50000);
  });

  test('handles undefined costMicros as zero', async () => {
    const results = await getMonthSpend(fakeCtx([
      { campaign: { id: '1', name: 'Undef', status: 'ENABLED' }, metrics: { costMicros: undefined } },
    ]));
    expect(results[0].spend).toBe(0);
  });
});

// ===========================================================================
// getSharedBudgets
// ===========================================================================

describe('getSharedBudgets', () => {
  const defaultRows = [
    { campaign: { id: '100', name: 'Honda Civic - Search' }, campaignBudget: { resourceName: 'customers/1234567890/campaignBudgets/8001', name: 'Shared Budget - Honda', amountMicros: 50000000 } },
    { campaign: { id: '101', name: 'Honda Accord - Search' }, campaignBudget: { resourceName: 'customers/1234567890/campaignBudgets/8001', name: 'Shared Budget - Honda', amountMicros: 50000000 } },
    { campaign: { id: '200', name: 'Toyota Trucks' }, campaignBudget: { resourceName: 'customers/1234567890/campaignBudgets/8002', name: 'Shared Budget - Toyota', amountMicros: 75000000 } },
  ];

  test('returns shared budgets deduplicated with linked campaigns', async () => {
    const results = await getSharedBudgets(fakeCtx(defaultRows));

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      resourceName: 'customers/1234567890/campaignBudgets/8001',
      name: 'Shared Budget - Honda',
      dailyBudget: 50.00,
      campaigns: [
        { campaignId: '100', campaignName: 'Honda Civic - Search' },
        { campaignId: '101', campaignName: 'Honda Accord - Search' },
      ],
    });
    expect(results[1]).toEqual({
      resourceName: 'customers/1234567890/campaignBudgets/8002',
      name: 'Shared Budget - Toyota',
      dailyBudget: 75.00,
      campaigns: [
        { campaignId: '200', campaignName: 'Toyota Trucks' },
      ],
    });
  });

  test('returns empty array when no shared budgets exist', async () => {
    const results = await getSharedBudgets(fakeCtx([]));
    expect(results).toEqual([]);
  });

  test('converts amountMicros to dollars correctly', async () => {
    const results = await getSharedBudgets(fakeCtx([
      { campaign: { id: '1', name: 'Test Camp' }, campaignBudget: { resourceName: 'r/1', name: 'Test', amountMicros: 1500000 } },
    ]));
    expect(results[0].dailyBudget).toBe(1.50);
  });

  test('handles null amountMicros as zero', async () => {
    const results = await getSharedBudgets(fakeCtx([
      { campaign: { id: '1', name: 'Test Camp' }, campaignBudget: { resourceName: 'r/1', name: 'Zero', amountMicros: null } },
    ]));
    expect(results[0].dailyBudget).toBe(0);
  });

  test('coerces campaign ID to string', async () => {
    const results = await getSharedBudgets(fakeCtx([
      { campaign: { id: 42, name: 'Numeric' }, campaignBudget: { resourceName: 'r/1', name: 'Budget', amountMicros: 1000000 } },
    ]));
    expect(results[0].campaigns[0].campaignId).toBe('42');
  });
});

// ===========================================================================
// getImpressionShare
// ===========================================================================

describe('getImpressionShare', () => {
  const defaultRows = [
    { campaign: { id: '100', name: 'Honda Civic - Search' }, metrics: { searchImpressionShare: 0.85, searchBudgetLostImpressionShare: 0.10 } },
    { campaign: { id: '200', name: 'Toyota Trucks' }, metrics: { searchImpressionShare: 0.62, searchBudgetLostImpressionShare: 0.25 } },
  ];

  test('returns impression share metrics per campaign', async () => {
    const results = await getImpressionShare(fakeCtx(defaultRows));

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      campaignId: '100',
      campaignName: 'Honda Civic - Search',
      impressionShare: 0.85,
      budgetLostShare: 0.10,
    });
    expect(results[1]).toEqual({
      campaignId: '200',
      campaignName: 'Toyota Trucks',
      impressionShare: 0.62,
      budgetLostShare: 0.25,
    });
  });

  test('returns empty array when no impression share data', async () => {
    const results = await getImpressionShare(fakeCtx([]));
    expect(results).toEqual([]);
  });

  test('handles null impression share as null', async () => {
    const results = await getImpressionShare(fakeCtx([
      { campaign: { id: '1', name: 'New Campaign' }, metrics: { searchImpressionShare: null, searchBudgetLostImpressionShare: null } },
    ]));
    expect(results[0].impressionShare).toBeNull();
    expect(results[0].budgetLostShare).toBeNull();
  });

  test('handles zero impression share', async () => {
    const results = await getImpressionShare(fakeCtx([
      { campaign: { id: '1', name: 'No Impressions' }, metrics: { searchImpressionShare: 0, searchBudgetLostImpressionShare: 0 } },
    ]));
    expect(results[0].impressionShare).toBe(0);
    expect(results[0].budgetLostShare).toBe(0);
  });

  test('coerces campaign ID to string', async () => {
    const results = await getImpressionShare(fakeCtx([
      { campaign: { id: 999, name: 'Test' }, metrics: { searchImpressionShare: 0.5, searchBudgetLostImpressionShare: 0.1 } },
    ]));
    expect(results[0].campaignId).toBe('999');
  });

  test('uses LAST_30_DAYS when no sinceDate provided', async () => {
    let capturedQuery = '';
    const ctx = {
      accessToken: 'a', developerToken: 'b', customerId: '123', loginCustomerId: '999',
      _queryFn: async (_t, _d, _c, query) => { capturedQuery = query; return []; },
    };
    await getImpressionShare(ctx);
    expect(capturedQuery).toContain('LAST_30_DAYS');
    expect(capturedQuery).not.toContain('THIS_MONTH');
  });

  test('uses BETWEEN with sinceDate when provided', async () => {
    let capturedQuery = '';
    const ctx = {
      accessToken: 'a', developerToken: 'b', customerId: '123', loginCustomerId: '999',
      _queryFn: async (_t, _d, _c, query) => { capturedQuery = query; return []; },
    };
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await getImpressionShare(ctx, yesterday);
    expect(capturedQuery).toContain('BETWEEN');
    expect(capturedQuery).toContain(yesterday);
  });

  test('caps sinceDate at 30 days ago', async () => {
    let capturedQuery = '';
    const ctx = {
      accessToken: 'a', developerToken: 'b', customerId: '123', loginCustomerId: '999',
      _queryFn: async (_t, _d, _c, query) => { capturedQuery = query; return []; },
    };
    // sinceDate is 60 days ago — should be capped at 30 days ago
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await getImpressionShare(ctx, sixtyDaysAgo);
    expect(capturedQuery).toContain('BETWEEN');
    // Should NOT contain the 60-day-ago date
    expect(capturedQuery).not.toContain(sixtyDaysAgo);
    // Should contain the 30-day-ago date (capped)
    expect(capturedQuery).toContain(thirtyDaysAgo);
  });
});

// ===========================================================================
// getInventory
// ===========================================================================

describe('getInventory', () => {
  // Primary source is shopping_performance_view (works for all account types including PMax)
  const defaultRows = [
    { segments: { productItemId: 'VIN001', productCondition: 'NEW', productTitle: '2024 Honda Civic LX', productBrand: 'Honda' } },
    { segments: { productItemId: 'VIN002', productCondition: 'NEW', productTitle: '2024 Honda Accord Sport', productBrand: 'Honda' } },
    { segments: { productItemId: 'VIN003', productCondition: 'USED', productTitle: '2022 Toyota Camry SE', productBrand: 'Toyota' } },
  ];

  test('returns new and used counts from shopping_performance_view (primary)', async () => {
    const result = await getInventory(fakeCtx(defaultRows));

    expect(result.newCount).toBe(2);
    expect(result.usedCount).toBe(1);
    expect(result.totalCount).toBe(3);
    expect(result.source).toBe('shopping_performance');
    expect(result.newInventoryByModel).toBeDefined();
  });

  test('builds newInventoryByModel from product titles', async () => {
    const rows = [
      { segments: { productItemId: 'V1', productCondition: 'NEW', productTitle: '2024 Honda Civic LX', productBrand: 'Honda' } },
      { segments: { productItemId: 'V2', productCondition: 'NEW', productTitle: '2024 Honda Civic EX', productBrand: 'Honda' } },
      { segments: { productItemId: 'V3', productCondition: 'NEW', productTitle: '2024 Honda Accord Sport', productBrand: 'Honda' } },
      { segments: { productItemId: 'V4', productCondition: 'USED', productTitle: '2022 Toyota Camry SE', productBrand: 'Toyota' } },
    ];
    const result = await getInventory(fakeCtx(rows));
    expect(result.newInventoryByModel.civic).toBe(2);
    expect(result.newInventoryByModel.accord).toBe(1);
    expect(result.newInventoryByModel.camry).toBeUndefined();
  });

  test('extracts model from item_id when it contains year/make/model', async () => {
    const rows = [
      { segments: { productItemId: '2024 Honda Civic', productCondition: 'NEW', productBrand: 'Honda' } },
      { segments: { productItemId: '2024 Ford F-150', productCondition: 'NEW', productBrand: 'Ford' } },
    ];
    const result = await getInventory(fakeCtx(rows));
    expect(result.newInventoryByModel.civic).toBe(1);
    expect(result.newInventoryByModel['f-150']).toBe(1);
  });

  test('returns empty newInventoryByModel when no models extractable', async () => {
    const rows = [
      { segments: { productItemId: '1HGCV1F34PA123456', productCondition: 'NEW' } },
      { segments: { productItemId: '2T1BU4EE5DC123456', productCondition: 'NEW' } },
    ];
    const result = await getInventory(fakeCtx(rows));
    expect(result.newCount).toBe(2);
    expect(result.newInventoryByModel).toEqual({});
  });

  test('returns zeros when no inventory', async () => {
    const result = await getInventory(fakeCtx([]));
    expect(result.newCount).toBe(0);
    expect(result.usedCount).toBe(0);
    expect(result.totalCount).toBe(0);
    expect(result.newInventoryByModel).toEqual({});
  });

  test('defaults empty condition to NEW (PMax often omits condition)', async () => {
    const rows = [
      { segments: { productItemId: 'VIN001', productCondition: '', productTitle: '2024 Honda Civic', productBrand: 'Honda' } },
      { segments: { productItemId: 'VIN002', productTitle: '2024 Honda Accord', productBrand: 'Honda' } },
      { segments: { productItemId: 'VIN003', productCondition: 'NEW', productTitle: '2024 Honda CR-V', productBrand: 'Honda' } },
    ];
    const result = await getInventory(fakeCtx(rows));
    expect(result.newCount).toBe(3);
    expect(result.usedCount).toBe(0);
  });

  test('handles large inventory without error', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({
      segments: { productItemId: `VIN${i}`, productCondition: i % 2 === 0 ? 'NEW' : 'USED' },
    }));
    const result = await getInventory(fakeCtx(rows));
    expect(result.totalCount).toBe(500);
    expect(result.newCount).toBe(250);
    expect(result.usedCount).toBe(250);
    expect(result.newInventoryByModel).toBeDefined();
  });

  test('falls back to shopping_product when performance_view fails', async () => {
    let callCount = 0;
    const ctx = {
      accessToken: 'fake', developerToken: 'fake', customerId: '123', loginCustomerId: '999',
      _queryFn: async () => {
        callCount++;
        if (callCount === 1) throw new Error('shopping_performance_view not available');
        return [
          { shoppingProduct: { itemId: 'VIN001', condition: 'NEW', brand: 'Honda', title: '2024 Honda Civic LX' } },
          { shoppingProduct: { itemId: 'VIN002', condition: 'USED', brand: 'Toyota', title: '2022 Toyota Camry' } },
        ];
      },
    };
    const result = await getInventory(ctx);
    expect(result.source).toBe('shopping_product');
    expect(result.newCount).toBe(1);
    expect(result.usedCount).toBe(1);
    expect(result.totalCount).toBe(2);
    expect(result.newInventoryByModel.civic).toBe(1);
    expect(result.newInventoryByModel.camry).toBeUndefined();
  });
});

// ===========================================================================
// getAccountLevelDailyBudget
// ===========================================================================

describe('getAccountLevelDailyBudget', () => {
  test('sums amount_micros across campaigns, dedupes shared budgets, picks majority bid strategy', async () => {
    // Google Ads REST returns int64 (amount_micros) as STRINGS — test with strings
    // to catch the += concatenation bug that would otherwise only appear in prod.
    const fakeQuery = async () => ([
      { campaign: { id: 1, biddingStrategyType: 'MAXIMIZE_CLICKS' }, campaignBudget: { resourceName: 'customers/1/campaignBudgets/a', amountMicros: '50000000' } },
      { campaign: { id: 2, biddingStrategyType: 'MAXIMIZE_CLICKS' }, campaignBudget: { resourceName: 'customers/1/campaignBudgets/b', amountMicros: '100000000' } },
      { campaign: { id: 3, biddingStrategyType: 'TARGET_CPA' }, campaignBudget: { resourceName: 'customers/1/campaignBudgets/a', amountMicros: '50000000' } }, // shared with campaign 1
    ]);
    const result = await getAccountLevelDailyBudget({
      accessToken: 't', developerToken: 'd', customerId: 'c', loginCustomerId: 'm',
      _queryFn: fakeQuery,
    });
    expect(result.totalDailyBudget).toBe(150); // $50 + $100 (shared dedup: campaign 3's budget is same as campaign 1's)
    expect(result.primaryBidStrategy).toBe('MAXIMIZE_CLICKS'); // 2 vs 1
  });

  test('returns nulls when no campaigns', async () => {
    const result = await getAccountLevelDailyBudget({
      accessToken: 't', developerToken: 'd', customerId: 'c', loginCustomerId: 'm',
      _queryFn: async () => [],
    });
    expect(result.totalDailyBudget).toBe(0);
    expect(result.primaryBidStrategy).toBeNull();
  });

  test('handles missing bidding_strategy_type gracefully', async () => {
    const result = await getAccountLevelDailyBudget({
      accessToken: 't', developerToken: 'd', customerId: 'c', loginCustomerId: 'm',
      _queryFn: async () => ([
        { campaign: { id: 1 }, campaignBudget: { resourceName: 'r1', amountMicros: 10_000_000 } },
      ]),
    });
    expect(result.totalDailyBudget).toBe(10);
    expect(result.primaryBidStrategy).toBeNull();
  });
});
