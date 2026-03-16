/**
 * Unit tests for pacing GAQL query functions in google-ads.js.
 *
 * Tier 2 (unit): uses FakeGoogleAdsClient, no real API calls.
 *
 * Tests: getMonthSpend, getSharedBudgets, getImpressionShare, getInventory
 */

const { FakeGoogleAdsClient } = require('../fakes/google-ads-fake');
const {
  getMonthSpend,
  getSharedBudgets,
  getImpressionShare,
  getInventory,
} = require('../../src/services/google-ads');

// ===========================================================================
// getMonthSpend
// ===========================================================================

describe('getMonthSpend', () => {
  test('returns MTD spend per campaign in dollars', async () => {
    const client = new FakeGoogleAdsClient();
    const results = await getMonthSpend(client);

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

  test('converts cost_micros to dollars correctly', async () => {
    const client = new FakeGoogleAdsClient({
      monthSpend: [
        { campaign: { id: '1', name: 'Test', status: 'ENABLED' }, metrics: { cost_micros: 1 } },
        { campaign: { id: '2', name: 'Test2', status: 'ENABLED' }, metrics: { cost_micros: 999999 } },
        { campaign: { id: '3', name: 'Test3', status: 'ENABLED' }, metrics: { cost_micros: 1000000 } },
      ],
    });
    const results = await getMonthSpend(client);

    expect(results[0].spend).toBeCloseTo(0.000001, 6);
    expect(results[1].spend).toBeCloseTo(0.999999, 6);
    expect(results[2].spend).toBe(1.00);
  });

  test('returns empty array when no campaigns have spend', async () => {
    const client = new FakeGoogleAdsClient({ monthSpend: [] });
    const results = await getMonthSpend(client);
    expect(results).toEqual([]);
  });

  test('handles zero spend', async () => {
    const client = new FakeGoogleAdsClient({
      monthSpend: [
        { campaign: { id: '1', name: 'Zero Spend', status: 'ENABLED' }, metrics: { cost_micros: 0 } },
      ],
    });
    const results = await getMonthSpend(client);
    expect(results[0].spend).toBe(0);
  });

  test('handles null cost_micros as zero', async () => {
    const client = new FakeGoogleAdsClient({
      monthSpend: [
        { campaign: { id: '1', name: 'No Data', status: 'ENABLED' }, metrics: { cost_micros: null } },
      ],
    });
    const results = await getMonthSpend(client);
    expect(results[0].spend).toBe(0);
  });

  test('coerces campaign ID to string', async () => {
    const client = new FakeGoogleAdsClient({
      monthSpend: [
        { campaign: { id: 12345, name: 'Numeric ID', status: 'ENABLED' }, metrics: { cost_micros: 1000000 } },
      ],
    });
    const results = await getMonthSpend(client);
    expect(results[0].campaignId).toBe('12345');
  });

  test('normalizes integer status enum to string', async () => {
    const client = new FakeGoogleAdsClient({
      monthSpend: [
        { campaign: { id: '1', name: 'Numeric Status', status: 2 }, metrics: { cost_micros: 1000000 } },
      ],
    });
    const results = await getMonthSpend(client);
    expect(results[0].status).toBe('ENABLED');
  });

  test('handles large spend values', async () => {
    const client = new FakeGoogleAdsClient({
      monthSpend: [
        { campaign: { id: '1', name: 'Big Spender', status: 'ENABLED' }, metrics: { cost_micros: 50000000000 } },
      ],
    });
    const results = await getMonthSpend(client);
    expect(results[0].spend).toBe(50000);
  });
});

// ===========================================================================
// getSharedBudgets
// ===========================================================================

describe('getSharedBudgets', () => {
  test('returns shared budgets deduplicated with linked campaigns', async () => {
    const client = new FakeGoogleAdsClient();
    const results = await getSharedBudgets(client);

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
    const client = new FakeGoogleAdsClient({ sharedBudgets: [] });
    const results = await getSharedBudgets(client);
    expect(results).toEqual([]);
  });

  test('converts amount_micros to dollars correctly', async () => {
    const client = new FakeGoogleAdsClient({
      sharedBudgets: [
        { campaign: { id: '1', name: 'Test Camp' }, campaign_budget: { resource_name: 'r/1', name: 'Test', amount_micros: 1500000 } },
      ],
    });
    const results = await getSharedBudgets(client);
    expect(results[0].dailyBudget).toBe(1.50);
  });

  test('handles null amount_micros as zero', async () => {
    const client = new FakeGoogleAdsClient({
      sharedBudgets: [
        { campaign: { id: '1', name: 'Test Camp' }, campaign_budget: { resource_name: 'r/1', name: 'Zero', amount_micros: null } },
      ],
    });
    const results = await getSharedBudgets(client);
    expect(results[0].dailyBudget).toBe(0);
  });

  test('coerces campaign ID to string', async () => {
    const client = new FakeGoogleAdsClient({
      sharedBudgets: [
        { campaign: { id: 42, name: 'Numeric' }, campaign_budget: { resource_name: 'r/1', name: 'Budget', amount_micros: 1000000 } },
      ],
    });
    const results = await getSharedBudgets(client);
    expect(results[0].campaigns[0].campaignId).toBe('42');
  });
});

// ===========================================================================
// getImpressionShare
// ===========================================================================

describe('getImpressionShare', () => {
  test('returns impression share metrics per campaign', async () => {
    const client = new FakeGoogleAdsClient();
    const results = await getImpressionShare(client);

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
    const client = new FakeGoogleAdsClient({ impressionShare: [] });
    const results = await getImpressionShare(client);
    expect(results).toEqual([]);
  });

  test('handles null impression share as null', async () => {
    const client = new FakeGoogleAdsClient({
      impressionShare: [
        { campaign: { id: '1', name: 'New Campaign' }, metrics: { search_impression_share: null, search_budget_lost_impression_share: null } },
      ],
    });
    const results = await getImpressionShare(client);
    expect(results[0].impressionShare).toBeNull();
    expect(results[0].budgetLostShare).toBeNull();
  });

  test('handles zero impression share', async () => {
    const client = new FakeGoogleAdsClient({
      impressionShare: [
        { campaign: { id: '1', name: 'No Impressions' }, metrics: { search_impression_share: 0, search_budget_lost_impression_share: 0 } },
      ],
    });
    const results = await getImpressionShare(client);
    expect(results[0].impressionShare).toBe(0);
    expect(results[0].budgetLostShare).toBe(0);
  });

  test('coerces campaign ID to string', async () => {
    const client = new FakeGoogleAdsClient({
      impressionShare: [
        { campaign: { id: 999, name: 'Test' }, metrics: { search_impression_share: 0.5, search_budget_lost_impression_share: 0.1 } },
      ],
    });
    const results = await getImpressionShare(client);
    expect(results[0].campaignId).toBe('999');
  });
});

// ===========================================================================
// getInventory
// ===========================================================================

describe('getInventory', () => {
  test('returns inventory items with condition, brand, model', async () => {
    const client = new FakeGoogleAdsClient();
    const { items, truncated } = await getInventory(client);

    expect(items).toHaveLength(3);
    expect(truncated).toBe(false);
    expect(items[0]).toEqual({
      itemId: 'VIN001',
      condition: 'NEW',
      brand: 'Honda',
      model: 'Civic',
    });
    expect(items[1]).toEqual({
      itemId: 'VIN002',
      condition: 'NEW',
      brand: 'Honda',
      model: 'Accord',
    });
    expect(items[2]).toEqual({
      itemId: 'VIN003',
      condition: 'USED',
      brand: 'Toyota',
      model: 'Camry',
    });
  });

  test('returns empty items array when no inventory', async () => {
    const client = new FakeGoogleAdsClient({ shoppingProducts: [] });
    const { items, truncated } = await getInventory(client);
    expect(items).toEqual([]);
    expect(truncated).toBe(false);
  });

  test('handles missing custom_label1 as null', async () => {
    const client = new FakeGoogleAdsClient({
      shoppingProducts: [
        { shopping_product: { resource_name: 'r/1', item_id: 'VIN999', condition: 'NEW', brand: 'Ford', custom_label1: undefined } },
      ],
    });
    const { items } = await getInventory(client);
    expect(items[0].model).toBeNull();
  });

  test('handles missing brand as null', async () => {
    const client = new FakeGoogleAdsClient({
      shoppingProducts: [
        { shopping_product: { resource_name: 'r/1', item_id: 'VIN999', condition: 'NEW', brand: undefined, custom_label1: 'Civic' } },
      ],
    });
    const { items } = await getInventory(client);
    expect(items[0].brand).toBeNull();
  });

  test('handles many inventory items without truncation flag', async () => {
    const products = Array.from({ length: 500 }, (_, i) => ({
      shopping_product: {
        resource_name: `r/${i}`,
        item_id: `VIN${i}`,
        condition: i % 2 === 0 ? 'NEW' : 'USED',
        brand: 'Honda',
        custom_label1: 'Civic',
      },
    }));
    const client = new FakeGoogleAdsClient({ shoppingProducts: products });
    const { items, truncated } = await getInventory(client);
    expect(items).toHaveLength(500);
    expect(truncated).toBe(false);
  });

  test('sets truncated flag when items reach limit', async () => {
    const products = Array.from({ length: 5000 }, (_, i) => ({
      shopping_product: {
        resource_name: `r/${i}`,
        item_id: `VIN${i}`,
        condition: 'NEW',
        brand: 'Honda',
        custom_label1: 'Civic',
      },
    }));
    const client = new FakeGoogleAdsClient({ shoppingProducts: products });
    const { items, truncated } = await getInventory(client);
    expect(items).toHaveLength(5000);
    expect(truncated).toBe(true);
  });
});
