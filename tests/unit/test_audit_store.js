/**
 * Unit tests for audit-store.js.
 *
 * Tier 2 (unit): tests in-memory audit result storage.
 */

const auditStore = require('../../src/services/audit-store');

afterEach(() => {
  auditStore.clear();
});

describe('auditStore', () => {
  const sampleResult = { score: 85, checks: [{ name: 'test', status: 'pass' }] };

  test('save and getLatest returns the result', () => {
    auditStore.save('111', sampleResult);
    const latest = auditStore.getLatest('111');
    expect(latest.score).toBe(85);
    expect(latest.checks).toHaveLength(1);
    expect(latest.timestamp).toBeDefined();
  });

  test('getLatest returns null for unknown account', () => {
    expect(auditStore.getLatest('unknown')).toBeNull();
  });

  test('save adds timestamp if not present', () => {
    auditStore.save('111', { score: 90 });
    const latest = auditStore.getLatest('111');
    expect(latest.timestamp).toBeDefined();
    expect(new Date(latest.timestamp).getTime()).not.toBeNaN();
  });

  test('save preserves existing timestamp', () => {
    const ts = '2026-01-15T10:00:00.000Z';
    auditStore.save('111', { score: 90, timestamp: ts });
    expect(auditStore.getLatest('111').timestamp).toBe(ts);
  });

  test('multiple saves create history (newest first)', () => {
    auditStore.save('111', { score: 80 });
    auditStore.save('111', { score: 85 });
    auditStore.save('111', { score: 90 });
    const history = auditStore.getHistory('111');
    expect(history).toHaveLength(3);
    expect(history[0].score).toBe(90);
    expect(history[2].score).toBe(80);
  });

  test('getLatest returns newest after multiple saves', () => {
    auditStore.save('111', { score: 80 });
    auditStore.save('111', { score: 95 });
    expect(auditStore.getLatest('111').score).toBe(95);
  });

  test('history is trimmed to maxHistory', () => {
    for (let i = 0; i < 10; i++) {
      auditStore.save('111', { score: i }, 3);
    }
    const history = auditStore.getHistory('111');
    expect(history).toHaveLength(3);
    expect(history[0].score).toBe(9); // newest
    expect(history[2].score).toBe(7); // oldest retained
  });

  test('getHistory returns empty array for unknown account', () => {
    expect(auditStore.getHistory('unknown')).toEqual([]);
  });

  test('getHistory respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      auditStore.save('111', { score: i });
    }
    const history = auditStore.getHistory('111', 2);
    expect(history).toHaveLength(2);
  });

  test('getAllLatest returns latest for all accounts', () => {
    auditStore.save('111', { score: 80 });
    auditStore.save('222', { score: 90 });
    auditStore.save('333', { score: 70 });

    const all = auditStore.getAllLatest();
    expect(all).toHaveLength(3);
    const ids = all.map(a => a.accountId);
    expect(ids).toContain('111');
    expect(ids).toContain('222');
    expect(ids).toContain('333');
  });

  test('getAllLatest returns empty array when no data', () => {
    expect(auditStore.getAllLatest()).toEqual([]);
  });

  test('size returns number of accounts', () => {
    expect(auditStore.size()).toBe(0);
    auditStore.save('111', { score: 80 });
    auditStore.save('222', { score: 90 });
    expect(auditStore.size()).toBe(2);
  });

  test('clear removes all data', () => {
    auditStore.save('111', { score: 80 });
    auditStore.save('222', { score: 90 });
    auditStore.clear();
    expect(auditStore.size()).toBe(0);
    expect(auditStore.getLatest('111')).toBeNull();
  });

  test('save throws on missing accountId', () => {
    expect(() => auditStore.save(null, sampleResult)).toThrow('accountId is required');
    expect(() => auditStore.save('', sampleResult)).toThrow('accountId is required');
  });

  test('save throws on missing auditResult', () => {
    expect(() => auditStore.save('111', null)).toThrow('auditResult is required');
  });

  test('separate accounts have independent histories', () => {
    auditStore.save('111', { score: 80 });
    auditStore.save('222', { score: 90 });
    auditStore.save('111', { score: 85 });

    expect(auditStore.getHistory('111')).toHaveLength(2);
    expect(auditStore.getHistory('222')).toHaveLength(1);
  });
});
