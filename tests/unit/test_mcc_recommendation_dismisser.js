jest.mock('../../src/services/change-history');

const dismisser = require('../../src/services/mcc-recommendation-dismisser');
const changeHistory = require('../../src/services/change-history');

beforeEach(() => {
  jest.clearAllMocks();
});

const ACCOUNTS = [
  { customerId: '111', name: 'Honda' },
  { customerId: '222', name: 'Toyota' },
];

describe('dismissByType', () => {
  test('happy path: 2 accounts each with 1 matching rec → dismissFn called per account', async () => {
    const dismissFn = jest.fn().mockResolvedValue({ dismissed: 1 });
    const result = await dismisser.dismissByType({
      type: 'ENHANCED_CPC_OPT_IN',
      accounts: ACCOUNTS,
      buildRestCtx: (a) => ({ customerId: a.customerId }),
      getRecs: jest.fn().mockResolvedValue([{ resourceName: 'rn-1', type: 'ENHANCED_CPC_OPT_IN' }]),
      dismissFn,
      devMode: false,
      userEmail: 'tester@example.com',
    });
    expect(result.dismissed).toBe(2);
    expect(result.errorsByDealer).toEqual([]);
    expect(result.devModeBlocked).toBe(false);
    expect(dismissFn).toHaveBeenCalledTimes(2);
    expect(changeHistory.addEntry).toHaveBeenCalledTimes(2);
  });

  test('non-matching type filtered out per account', async () => {
    const dismissFn = jest.fn().mockResolvedValue({ dismissed: 1 });
    await dismisser.dismissByType({
      type: 'ENHANCED_CPC_OPT_IN',
      accounts: [ACCOUNTS[0]],
      buildRestCtx: (a) => ({ customerId: a.customerId }),
      getRecs: jest.fn().mockResolvedValue([
        { resourceName: 'rn-1', type: 'ENHANCED_CPC_OPT_IN' },
        { resourceName: 'rn-2', type: 'KEYWORD' },
      ]),
      dismissFn,
      devMode: false,
      userEmail: 'tester',
    });
    expect(dismissFn.mock.calls[0][1]).toEqual(['rn-1']);
  });

  test('DEV_MODE=true → no dismissFn calls, devModeBlocked=true, change_history still written', async () => {
    const dismissFn = jest.fn();
    const result = await dismisser.dismissByType({
      type: 'ENHANCED_CPC_OPT_IN',
      accounts: ACCOUNTS,
      buildRestCtx: (a) => ({ customerId: a.customerId }),
      getRecs: jest.fn().mockResolvedValue([{ resourceName: 'rn-1', type: 'ENHANCED_CPC_OPT_IN' }]),
      dismissFn,
      devMode: true,
      userEmail: 'tester',
    });
    expect(result.devModeBlocked).toBe(true);
    expect(dismissFn).not.toHaveBeenCalled();
    expect(changeHistory.addEntry).toHaveBeenCalledTimes(2);
    const firstCall = changeHistory.addEntry.mock.calls[0][0];
    expect(firstCall.details.devModeBlocked).toBe(true);
  });

  test('per-account error captured, loop continues', async () => {
    const dismissFn = jest.fn().mockImplementation(async (ctx) => {
      if (ctx.customerId === '111') throw new Error('Permission denied');
      return { dismissed: 1 };
    });
    const result = await dismisser.dismissByType({
      type: 'ENHANCED_CPC_OPT_IN',
      accounts: ACCOUNTS,
      buildRestCtx: (a) => ({ customerId: a.customerId }),
      getRecs: jest.fn().mockResolvedValue([{ resourceName: 'rn-1', type: 'ENHANCED_CPC_OPT_IN' }]),
      dismissFn,
      devMode: false,
      userEmail: 'tester',
    });
    expect(result.dismissed).toBe(1);
    expect(result.errorsByDealer).toHaveLength(1);
    expect(result.errorsByDealer[0]).toMatchObject({ customerId: '111', error: 'Permission denied' });
  });
});

describe('dismissSelected', () => {
  test('groups items by customerId and dismisses each batch', async () => {
    const dismissFn = jest.fn().mockResolvedValue({ dismissed: 1 });
    const result = await dismisser.dismissSelected({
      items: [
        { customerId: '111', resourceName: 'rn-a' },
        { customerId: '222', resourceName: 'rn-b' },
        { customerId: '111', resourceName: 'rn-c' },
      ],
      accounts: ACCOUNTS,
      buildRestCtx: (a) => ({ customerId: a.customerId }),
      dismissFn,
      devMode: false,
      userEmail: 'tester',
    });
    expect(dismissFn).toHaveBeenCalledTimes(2);
    const firstCallArgs = dismissFn.mock.calls.find(c => c[0].customerId === '111');
    expect(firstCallArgs[1]).toEqual(['rn-a', 'rn-c']);
  });

  test('item for unknown customerId → skipped (account not found)', async () => {
    const dismissFn = jest.fn().mockResolvedValue({ dismissed: 1 });
    const result = await dismisser.dismissSelected({
      items: [{ customerId: '999', resourceName: 'rn-x' }],
      accounts: ACCOUNTS,
      buildRestCtx: (a) => ({ customerId: a.customerId }),
      dismissFn,
      devMode: false,
      userEmail: 'tester',
    });
    expect(result.dismissed).toBe(0);
    expect(dismissFn).not.toHaveBeenCalled();
  });
});
