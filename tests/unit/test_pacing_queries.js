/**
 * Unit tests for pacing GAQL query functions in google-ads.js.
 *
 * Tier 2 (unit): uses _queryFn injection with fake data, no real API calls.
 * Data is in REST/camelCase format (what Google Ads REST API returns).
 *
 * Tests: getMonthSpend, getSharedBudgets, getImpressionShare, getInventory
 */

const {
  getMonthSpend,
  getSharedBudgets,
  getImpressionShare,
  getInventory,
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
});

// ===========================================================================
// getInventory
// ===========================================================================

describe('getInventory', () => {
  const defaultRows = [
    { shoppingProduct: { itemId: 'VIN001', condition: 'NEW', brand: 'Honda' } },
    { shoppingProduct: { itemId: 'VIN002', condition: 'NEW', brand: 'Honda' } },
    { shoppingProduct: { itemId: 'VIN003', condition: 'USED', brand: 'Toyota' } },
  ];

  test('returns inventory items with condition and brand', async () => {
    const { items, truncated } = await getInventory(fakeCtx(defaultRows));

    expect(items).toHaveLength(3);
    expect(truncated).toBe(false);
    expect(items[0]).toEqual({
      itemId: 'VIN001',
      condition: 'NEW',
      brand: 'Honda',
    });
    expect(items[2]).toEqual({
      itemId: 'VIN003',
      condition: 'USED',
      brand: 'Toyota',
    });
  });

  test('returns empty items array when no inventory', async () => {
    const { items, truncated } = await getInventory(fakeCtx([]));
    expect(items).toEqual([]);
    expect(truncated).toBe(false);
  });

  test('handles missing brand as null', async () => {
    const { items } = await getInventory(fakeCtx([
      { shoppingProduct: { itemId: 'VIN999', condition: 'NEW', brand: undefined } },
    ]));
    expect(items[0].brand).toBeNull();
  });

  test('handles many inventory items without truncation flag', async () => {
    const products = Array.from({ length: 500 }, (_, i) => ({
      shoppingProduct: { itemId: `VIN${i}`, condition: i % 2 === 0 ? 'NEW' : 'USED', brand: 'Honda' },
    }));
    const { items, truncated } = await getInventory(fakeCtx(products));
    expect(items).toHaveLength(500);
    expect(truncated).toBe(false);
  });

  test('sets truncated flag when items reach limit', async () => {
    const products = Array.from({ length: 5000 }, (_, i) => ({
      shoppingProduct: { itemId: `VIN${i}`, condition: 'NEW', brand: 'Honda' },
    }));
    const { items, truncated } = await getInventory(fakeCtx(products));
    expect(items).toHaveLength(5000);
    expect(truncated).toBe(true);
  });

  test('handles empty brand gracefully', async () => {
    const { items } = await getInventory(fakeCtx([
      { shoppingProduct: { itemId: 'VIN999', condition: 'NEW', brand: '' } },
    ]));
    expect(items[0].brand).toBeNull();
  });

  test('handles null shoppingProduct gracefully', async () => {
    const { items } = await getInventory(fakeCtx([
      { shoppingProduct: null },
    ]));
    expect(items[0].itemId).toBeNull();
    expect(items[0].brand).toBeNull();
  });
});
