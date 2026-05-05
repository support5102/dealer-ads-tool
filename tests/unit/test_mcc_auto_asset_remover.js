jest.mock('../../src/services/change-history');

const remover = require('../../src/services/mcc-auto-asset-remover');
const changeHistory = require('../../src/services/change-history');

beforeEach(() => {
  jest.clearAllMocks();
});

const ACCOUNTS = [
  { customerId: '111', name: 'Honda' },
  { customerId: '222', name: 'Toyota' },
];

describe('removeByTypes', () => {
  test('filters by selected types only', async () => {
    const removeFn = jest.fn().mockResolvedValue({ removed: 2 });
    const getAssets = jest.fn().mockResolvedValue([
      { resourceName: 'rn-h', type: 'HEADLINE', text: '', scope: 'ad_group_ad' },
      { resourceName: 'rn-d', type: 'DESCRIPTION', text: '', scope: 'ad_group_ad' },
      { resourceName: 'rn-c', type: 'CALLOUT', text: '', scope: 'customer' },
    ]);
    await remover.removeByTypes({
      types: ['HEADLINE', 'CALLOUT'],
      accounts: [ACCOUNTS[0]],
      buildRestCtx: (a) => ({ customerId: a.customerId }),
      getAssets,
      removeFn,
      devMode: false,
      userEmail: 'tester',
    });
    expect(removeFn).toHaveBeenCalledTimes(1);
    const passedNames = removeFn.mock.calls[0][1];
    expect(passedNames.sort()).toEqual(['rn-c', 'rn-h'].sort());
  });

  test('happy path: 2 accounts each with 1 matching asset → 2 removeFn calls', async () => {
    const removeFn = jest.fn().mockResolvedValue({ removed: 1 });
    const result = await remover.removeByTypes({
      types: ['HEADLINE'],
      accounts: ACCOUNTS,
      buildRestCtx: (a) => ({ customerId: a.customerId }),
      getAssets: jest.fn().mockResolvedValue([{ resourceName: 'rn-h', type: 'HEADLINE', text: '', scope: 'ad_group_ad' }]),
      removeFn,
      devMode: false,
      userEmail: 'tester',
    });
    expect(result.removed).toBe(2);
    expect(removeFn).toHaveBeenCalledTimes(2);
    expect(changeHistory.addEntry).toHaveBeenCalledTimes(2);
  });

  test('DEV_MODE=true → no removeFn calls, devModeBlocked=true, audit row written', async () => {
    const removeFn = jest.fn();
    const result = await remover.removeByTypes({
      types: ['HEADLINE'],
      accounts: ACCOUNTS,
      buildRestCtx: (a) => ({ customerId: a.customerId }),
      getAssets: jest.fn().mockResolvedValue([{ resourceName: 'rn-h', type: 'HEADLINE', text: '', scope: 'ad_group_ad' }]),
      removeFn,
      devMode: true,
      userEmail: 'tester',
    });
    expect(result.devModeBlocked).toBe(true);
    expect(removeFn).not.toHaveBeenCalled();
    expect(changeHistory.addEntry).toHaveBeenCalledTimes(2);
    expect(changeHistory.addEntry.mock.calls[0][0].details.devModeBlocked).toBe(true);
  });

  test('per-account error captured, loop continues', async () => {
    const removeFn = jest.fn().mockImplementation(async (ctx) => {
      if (ctx.customerId === '111') throw new Error('Forbidden');
      return { removed: 1 };
    });
    const result = await remover.removeByTypes({
      types: ['HEADLINE'],
      accounts: ACCOUNTS,
      buildRestCtx: (a) => ({ customerId: a.customerId }),
      getAssets: jest.fn().mockResolvedValue([{ resourceName: 'rn-h', type: 'HEADLINE', text: '', scope: 'ad_group_ad' }]),
      removeFn,
      devMode: false,
      userEmail: 'tester',
    });
    expect(result.removed).toBe(1);
    expect(result.errorsByDealer).toHaveLength(1);
  });

  test('account with no matching types → no removeFn call, no audit row', async () => {
    const removeFn = jest.fn();
    await remover.removeByTypes({
      types: ['HEADLINE'],
      accounts: [ACCOUNTS[0]],
      buildRestCtx: (a) => ({ customerId: a.customerId }),
      getAssets: jest.fn().mockResolvedValue([{ resourceName: 'rn-c', type: 'CALLOUT', text: '', scope: 'customer' }]),
      removeFn,
      devMode: false,
      userEmail: 'tester',
    });
    expect(removeFn).not.toHaveBeenCalled();
    expect(changeHistory.addEntry).not.toHaveBeenCalled();
  });

  test('empty types array → no calls anywhere', async () => {
    const removeFn = jest.fn();
    const getAssets = jest.fn();
    const result = await remover.removeByTypes({
      types: [],
      accounts: ACCOUNTS,
      buildRestCtx: jest.fn(),
      getAssets,
      removeFn,
      devMode: false,
      userEmail: 'tester',
    });
    expect(result.removed).toBe(0);
    expect(getAssets).not.toHaveBeenCalled();
    expect(removeFn).not.toHaveBeenCalled();
  });
});
