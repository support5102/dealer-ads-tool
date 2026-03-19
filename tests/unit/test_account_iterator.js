/**
 * Unit tests for account-iterator.js.
 *
 * Tier 2 (unit): uses injected query function, no real API calls.
 */

const { discoverAccounts, iterateAccounts } = require('../../src/services/account-iterator');

const fakeConfig = {
  clientId: 'fake-id',
  clientSecret: 'fake-secret',
  developerToken: 'fake-dev-token',
};

const fakeChildRows = [
  { customerClient: { id: '111', descriptiveName: 'Dealer A', currencyCode: 'USD', manager: false, level: 1 } },
  { customerClient: { id: '222', descriptiveName: 'Dealer B', currencyCode: 'USD', manager: false, level: 1 } },
  { customerClient: { id: '333', descriptiveName: 'Sub-MCC', currencyCode: 'USD', manager: true, level: 1 } },
  { customerClient: { id: '999', descriptiveName: 'MCC Self', currencyCode: 'USD', manager: true, level: 0 } },
];

// ===========================================================================
// discoverAccounts
// ===========================================================================

describe('discoverAccounts', () => {
  test('returns only non-manager child accounts', async () => {
    const queryFn = async () => fakeChildRows;
    const accounts = await discoverAccounts(fakeConfig, 'fake-token', '999', queryFn);
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toEqual({ customerId: '111', name: 'Dealer A', currency: 'USD', isManager: false });
    expect(accounts[1]).toEqual({ customerId: '222', name: 'Dealer B', currency: 'USD', isManager: false });
  });

  test('filters out MCC self-reference', async () => {
    const queryFn = async () => fakeChildRows;
    const accounts = await discoverAccounts(fakeConfig, 'fake-token', '999', queryFn);
    const ids = accounts.map(a => a.customerId);
    expect(ids).not.toContain('999');
  });

  test('filters out manager accounts', async () => {
    const queryFn = async () => fakeChildRows;
    const accounts = await discoverAccounts(fakeConfig, 'fake-token', '999', queryFn);
    const ids = accounts.map(a => a.customerId);
    expect(ids).not.toContain('333');
  });

  test('filters out rows with missing customerClient.id', async () => {
    const queryFn = async () => [
      { customerClient: { id: '111', descriptiveName: 'Good', currencyCode: 'USD', manager: false } },
      { customerClient: { descriptiveName: 'No ID', currencyCode: 'USD', manager: false } },
      { customerClient: {} },
      {},
    ];
    const accounts = await discoverAccounts(fakeConfig, 'fake-token', '999', queryFn);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].customerId).toBe('111');
  });

  test('handles empty results', async () => {
    const queryFn = async () => [];
    const accounts = await discoverAccounts(fakeConfig, 'fake-token', '999', queryFn);
    expect(accounts).toEqual([]);
  });

  test('strips dashes from MCC ID', async () => {
    let capturedCustomerId;
    const queryFn = async (_token, _dev, custId) => {
      capturedCustomerId = custId;
      return [];
    };
    await discoverAccounts(fakeConfig, 'fake-token', '999-888-7777', queryFn);
    expect(capturedCustomerId).toBe('9998887777');
  });
});

// ===========================================================================
// iterateAccounts
// ===========================================================================

describe('iterateAccounts', () => {
  const discoveryFn = async (_token, _dev, custId, _query, _login) => {
    // Return child accounts when queried for customer_client
    return [
      { customerClient: { id: '111', descriptiveName: 'Dealer A', currencyCode: 'USD', manager: false, level: 1 } },
      { customerClient: { id: '222', descriptiveName: 'Dealer B', currencyCode: 'USD', manager: false, level: 1 } },
    ];
  };

  test('iterates all accounts and collects results', async () => {
    const callback = async (_ctx, account) => ({ status: 'ok', name: account.name });
    const result = await iterateAccounts({
      config: fakeConfig,
      accessToken: 'fake-token',
      mccId: '999',
      callback,
      options: { delayMs: 0, queryFn: discoveryFn },
    });

    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.results[0].accountName).toBe('Dealer A');
    expect(result.results[0].result).toEqual({ status: 'ok', name: 'Dealer A' });
    expect(result.results[0].error).toBeNull();
  });

  test('isolates errors per account', async () => {
    let callCount = 0;
    const callback = async () => {
      callCount++;
      if (callCount === 1) throw new Error('API quota exceeded');
      return { status: 'ok' };
    };

    const result = await iterateAccounts({
      config: fakeConfig,
      accessToken: 'fake-token',
      mccId: '999',
      callback,
      options: { delayMs: 0, queryFn: discoveryFn },
    });

    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results[0].error).toBe('API quota exceeded');
    expect(result.results[1].error).toBeNull();
  });

  test('calls onProgress for each account', async () => {
    const progressCalls = [];
    const callback = async () => ({ done: true });

    await iterateAccounts({
      config: fakeConfig,
      accessToken: 'fake-token',
      mccId: '999',
      callback,
      options: {
        delayMs: 0,
        queryFn: discoveryFn,
        onProgress: (info) => progressCalls.push(info),
      },
    });

    expect(progressCalls).toHaveLength(2);
    expect(progressCalls[0].current).toBe(1);
    expect(progressCalls[0].total).toBe(2);
    expect(progressCalls[1].current).toBe(2);
  });

  test('passes correct restCtx to callback', async () => {
    const capturedCtxs = [];
    const callback = async (ctx) => { capturedCtxs.push(ctx); return null; };

    await iterateAccounts({
      config: fakeConfig,
      accessToken: 'fake-token',
      mccId: '999',
      callback,
      options: { delayMs: 0, queryFn: discoveryFn },
    });

    expect(capturedCtxs).toHaveLength(2);
    expect(capturedCtxs[0].accessToken).toBe('fake-token');
    expect(capturedCtxs[0].developerToken).toBe('fake-dev-token');
    expect(capturedCtxs[0].customerId).toBe('111');
    expect(capturedCtxs[0].loginCustomerId).toBe('999');
    expect(capturedCtxs[1].customerId).toBe('222');
  });

  test('survives onProgress callback error', async () => {
    const callback = async () => ({ done: true });

    const result = await iterateAccounts({
      config: fakeConfig,
      accessToken: 'fake-token',
      mccId: '999',
      callback,
      options: {
        delayMs: 0,
        queryFn: discoveryFn,
        onProgress: () => { throw new Error('progress handler crashed'); },
      },
    });

    // Iteration should complete despite onProgress error
    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(2);
  });

  test('returns null result when callback returns undefined', async () => {
    const callback = async () => undefined;

    const result = await iterateAccounts({
      config: fakeConfig,
      accessToken: 'fake-token',
      mccId: '999',
      callback,
      options: { delayMs: 0, queryFn: discoveryFn },
    });

    expect(result.results[0].result).toBeNull();
  });

  test('handles zero child accounts', async () => {
    const emptyFn = async () => [];
    const callback = async () => ({ done: true });

    const result = await iterateAccounts({
      config: fakeConfig,
      accessToken: 'fake-token',
      mccId: '999',
      callback,
      options: { delayMs: 0, queryFn: emptyFn },
    });

    expect(result.total).toBe(0);
    expect(result.results).toEqual([]);
  });
});
