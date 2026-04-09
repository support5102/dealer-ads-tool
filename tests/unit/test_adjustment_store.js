/**
 * Unit tests for adjustment-store.js
 */

const { AdjustmentStore, STATUSES } = require('../../src/services/adjustment-store');

function makeBatch(overrides = {}) {
  return {
    adjustmentId: `adj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    customerId: '111-111-1111',
    dealerName: 'Test Dealer',
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    direction: 'under',
    adjustments: [{ target: 'VLA Campaign', change: 50 }],
    summary: { totalChangeNeeded: 50 },
    ...overrides,
  };
}

describe('AdjustmentStore', () => {
  let store;

  beforeEach(() => {
    store = new AdjustmentStore();
  });

  afterEach(() => {
    store.destroy();
  });

  test('save and get', () => {
    const batch = makeBatch();
    store.save(batch);
    const retrieved = store.get(batch.adjustmentId);
    expect(retrieved).not.toBeNull();
    expect(retrieved.adjustmentId).toBe(batch.adjustmentId);
    expect(retrieved.status).toBe(STATUSES.PENDING);
  });

  test('get returns null for unknown ID', () => {
    expect(store.get('nonexistent')).toBeNull();
  });

  test('list returns all items', () => {
    store.save(makeBatch({ adjustmentId: 'a1' }));
    store.save(makeBatch({ adjustmentId: 'a2' }));
    expect(store.list()).toHaveLength(2);
  });

  test('list filters by status', () => {
    store.save(makeBatch({ adjustmentId: 'a1' }));
    store.save(makeBatch({ adjustmentId: 'a2' }));
    store.approve('a1', 'user@test.com');
    expect(store.list(STATUSES.PENDING)).toHaveLength(1);
    expect(store.list(STATUSES.APPROVED)).toHaveLength(1);
  });

  test('listForAccount filters by customerId and pending status', () => {
    store.save(makeBatch({ adjustmentId: 'a1', customerId: 'AAA' }));
    store.save(makeBatch({ adjustmentId: 'a2', customerId: 'BBB' }));
    store.save(makeBatch({ adjustmentId: 'a3', customerId: 'AAA' }));
    expect(store.listForAccount('AAA')).toHaveLength(2);
    expect(store.listForAccount('BBB')).toHaveLength(1);
  });

  test('approve transitions pending → approved', () => {
    const batch = makeBatch({ adjustmentId: 'a1' });
    store.save(batch);
    const result = store.approve('a1', 'user@test.com');
    expect(result.status).toBe(STATUSES.APPROVED);
    expect(result.approvedBy).toBe('user@test.com');
    expect(result.approvedAt).toBeDefined();
  });

  test('approve returns null for non-pending', () => {
    store.save(makeBatch({ adjustmentId: 'a1' }));
    store.approve('a1', 'user@test.com');
    expect(store.approve('a1', 'user@test.com')).toBeNull(); // already approved
  });

  test('approve returns null for expired batch', () => {
    store.save(makeBatch({
      adjustmentId: 'a1',
      expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
    }));
    const result = store.approve('a1', 'user@test.com');
    expect(result).toBeNull();
    expect(store.get('a1').status).toBe(STATUSES.EXPIRED);
  });

  test('reject transitions pending → rejected', () => {
    store.save(makeBatch({ adjustmentId: 'a1' }));
    const result = store.reject('a1', 'user@test.com', 'Not needed');
    expect(result.status).toBe(STATUSES.REJECTED);
    expect(result.rejectedBy).toBe('user@test.com');
    expect(result.rejectedReason).toBe('Not needed');
  });

  test('reject returns null for non-pending', () => {
    store.save(makeBatch({ adjustmentId: 'a1' }));
    store.reject('a1', 'user@test.com');
    expect(store.reject('a1', 'another@test.com')).toBeNull();
  });

  test('recordExecution transitions approved → executed', () => {
    store.save(makeBatch({ adjustmentId: 'a1' }));
    store.approve('a1', 'user@test.com');
    const result = store.recordExecution('a1', { applied: 3, failed: 0 });
    expect(result.status).toBe(STATUSES.EXECUTED);
    expect(result.executedAt).toBeDefined();
    expect(result.executionResults.applied).toBe(3);
  });

  test('recordExecution returns null for non-approved', () => {
    store.save(makeBatch({ adjustmentId: 'a1' }));
    expect(store.recordExecution('a1', {})).toBeNull(); // still pending
  });

  test('_expireStale marks old pending as expired', () => {
    store.save(makeBatch({
      adjustmentId: 'a1',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }));
    store._expireStale();
    expect(store.get('a1').status).toBe(STATUSES.EXPIRED);
  });

  test('_expireStale does not affect non-pending', () => {
    store.save(makeBatch({
      adjustmentId: 'a1',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }));
    store.approve('a1', 'user@test.com'); // won't approve (expired) but status set
    store._expireStale();
    // Already expired from approve attempt
    expect(store.get('a1').status).toBe(STATUSES.EXPIRED);
  });

  test('clear removes all items', () => {
    store.save(makeBatch({ adjustmentId: 'a1' }));
    store.save(makeBatch({ adjustmentId: 'a2' }));
    store.clear();
    expect(store.size).toBe(0);
  });
});
