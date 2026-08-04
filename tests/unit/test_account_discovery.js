/**
 * Tests for discoverAllAccounts — the single-query account discovery.
 *
 * A customer_client query from the root MCC returns every descendant at all levels,
 * so discovery must be ONE round-trip (no per-sub-MCC recursion) and must return all
 * non-manager accounts (including level-2 ones under sub-MCCs), skipping managers and
 * the MCC itself.
 */

jest.mock('../../src/services/google-ads');
const googleAds = require('../../src/services/google-ads');
const { discoverAllAccounts } = require('../../src/routes/accounts');

const ROWS = [
  { customerClient: { id: '939', manager: true, level: '0', descriptiveName: 'Root MCC' } },      // the MCC itself
  { customerClient: { id: '111', manager: false, level: '1', descriptiveName: 'Dealer A', currencyCode: 'USD' } },
  { customerClient: { id: '222', manager: true, level: '1', descriptiveName: 'Alan Jay Sub-MCC' } }, // a sub-MCC
  { customerClient: { id: '333', manager: false, level: '2', descriptiveName: 'Dealer B (under sub-MCC)', currencyCode: 'USD' } },
  { customerClient: { id: '444', manager: false, level: '2', descriptiveName: 'Dealer C (under sub-MCC)' } },
];

beforeEach(() => jest.clearAllMocks());

test('makes exactly ONE query — no per-sub-MCC recursion', async () => {
  googleAds.queryViaRest.mockResolvedValue(ROWS);
  await discoverAllAccounts('tok', 'dev', '939', '939');
  expect(googleAds.queryViaRest).toHaveBeenCalledTimes(1);
});

test('returns all non-manager accounts including level-2, skips managers + the MCC', async () => {
  googleAds.queryViaRest.mockResolvedValue(ROWS);
  const accounts = await discoverAllAccounts('939-042-4920', 'dev', '939', '939');
  expect(accounts.map(a => a.id).sort()).toEqual(['111', '333', '444']); // no '939' (self), no '222' (manager)
  const b = accounts.find(a => a.id === '333');
  expect(b).toEqual({ id: '333', name: 'Dealer B (under sub-MCC)', currency: 'USD', isManager: false, mccId: '939' });
});

test('login-customer-id header uses the root MCC (dash-stripped)', async () => {
  googleAds.queryViaRest.mockResolvedValue(ROWS);
  await discoverAllAccounts('tok', 'dev', '939-042-4920', '939-042-4920');
  const call = googleAds.queryViaRest.mock.calls[0];
  expect(call[2]).toBe('9390424920'); // cid arg dash-stripped
  expect(call[4]).toBe('9390424920'); // loginCustomerId arg dash-stripped
});

test('falls back to name/blank currency, and is resilient to a non-array response', async () => {
  googleAds.queryViaRest.mockResolvedValue([{ customerClient: { id: '555', manager: false } }]);
  const one = await discoverAllAccounts('tok', 'dev', '939');
  expect(one[0]).toEqual({ id: '555', name: 'Account 555', currency: '', isManager: false, mccId: '939' });

  googleAds.queryViaRest.mockResolvedValue(null);
  expect(await discoverAllAccounts('tok', 'dev', '939')).toEqual([]);
});
