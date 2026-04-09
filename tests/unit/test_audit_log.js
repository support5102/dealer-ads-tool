/**
 * Tier 2 Audit Log Tests — validates structured JSON logging to stdout.
 *
 * Tests: src/utils/audit-log.js
 * Captures console.log output and verifies JSON structure.
 */

const { logAudit } = require('../../src/utils/audit-log');

describe('logAudit', () => {
  let consoleSpy;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test('outputs valid JSON to console.log', () => {
    logAudit({ action: 'test_action' });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = consoleSpy.mock.calls[0][0];
    expect(() => JSON.parse(output)).not.toThrow();
  });

  test('includes _audit marker and timestamp', () => {
    logAudit({ action: 'test_action' });

    const record = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(record._audit).toBe(true);
    expect(record.timestamp).toBeDefined();
    expect(new Date(record.timestamp).toISOString()).toBe(record.timestamp);
  });

  test('includes all provided fields', () => {
    logAudit({
      action:     'apply_changes',
      email:      'user@dealer.com',
      customerId: '123-456-7890',
      dryRun:     false,
      applied:    3,
      failed:     1,
    });

    const record = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(record.action).toBe('apply_changes');
    expect(record.email).toBe('user@dealer.com');
    expect(record.customerId).toBe('123-456-7890');
    expect(record.dryRun).toBe(false);
    expect(record.applied).toBe(3);
    expect(record.failed).toBe(1);
  });

  test('includes changes summary array', () => {
    logAudit({
      action:  'apply_changes',
      changes: [
        { type: 'pause_campaign', campaign: 'Honda Civic - Search' },
        { type: 'update_budget', campaign: 'Toyota Trucks' },
      ],
    });

    const record = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(record.changes).toHaveLength(2);
    expect(record.changes[0].type).toBe('pause_campaign');
    expect(record.changes[1].campaign).toBe('Toyota Trucks');
  });

  test('handles minimal entry with just action', () => {
    logAudit({ action: 'parse_task' });

    const record = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(record.action).toBe('parse_task');
    expect(record._audit).toBe(true);
    expect(record.timestamp).toBeDefined();
  });

  test('includes error field when provided', () => {
    logAudit({
      action: 'apply_changes',
      error:  'Campaign not found: Bad Name',
    });

    const record = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(record.error).toBe('Campaign not found: Bad Name');
  });

  test('_audit and timestamp cannot be overridden by entry', () => {
    logAudit({ _audit: false, timestamp: 'fake-time', action: 'test' });

    const record = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(record._audit).toBe(true);
    expect(record.timestamp).not.toBe('fake-time');
  });
});
