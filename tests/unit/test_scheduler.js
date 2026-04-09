/**
 * Unit tests for scheduler.js.
 *
 * Tier 2 (unit): tests in-memory scheduler registration, execution, and cleanup.
 */

const scheduler = require('../../src/services/scheduler');

afterEach(() => {
  scheduler.clearAll();
});

describe('scheduler', () => {
  test('registerJob adds a job that appears in listJobs', () => {
    scheduler.registerJob('test-job', async () => {}, 60000);
    const jobs = scheduler.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('test-job');
    expect(jobs[0].intervalMs).toBe(60000);
    expect(jobs[0].running).toBe(false);
    expect(jobs[0].lastRun).toBeNull();
    expect(jobs[0].runCount).toBe(0);
  });

  test('unregisterJob removes a job', () => {
    scheduler.registerJob('test-job', async () => {}, 60000);
    expect(scheduler.listJobs()).toHaveLength(1);
    const removed = scheduler.unregisterJob('test-job');
    expect(removed).toBe(true);
    expect(scheduler.listJobs()).toHaveLength(0);
  });

  test('unregisterJob returns false for non-existent job', () => {
    expect(scheduler.unregisterJob('nonexistent')).toBe(false);
  });

  test('getJob returns specific job status', () => {
    scheduler.registerJob('job-a', async () => {}, 1000);
    scheduler.registerJob('job-b', async () => {}, 2000);
    const job = scheduler.getJob('job-a');
    expect(job.name).toBe('job-a');
    expect(job.intervalMs).toBe(1000);
  });

  test('getJob returns null for non-existent job', () => {
    expect(scheduler.getJob('nonexistent')).toBeNull();
  });

  test('registerJob replaces existing job with same name', () => {
    scheduler.registerJob('dup', async () => {}, 1000);
    scheduler.registerJob('dup', async () => {}, 5000);
    const jobs = scheduler.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].intervalMs).toBe(5000);
  });

  test('clearAll removes all jobs', () => {
    scheduler.registerJob('a', async () => {}, 1000);
    scheduler.registerJob('b', async () => {}, 2000);
    scheduler.clearAll();
    expect(scheduler.listJobs()).toHaveLength(0);
  });

  test('runImmediately executes the job right away', async () => {
    let ran = false;
    scheduler.registerJob('immediate', async () => { ran = true; }, 60000, { runImmediately: true });

    // Give the async function time to complete
    await new Promise(r => setTimeout(r, 50));
    expect(ran).toBe(true);

    const job = scheduler.getJob('immediate');
    expect(job.runCount).toBe(1);
    expect(job.lastRun).not.toBeNull();
    expect(job.lastError).toBeNull();
  });

  test('job records error on failure', async () => {
    scheduler.registerJob('fail-job', async () => {
      throw new Error('something broke');
    }, 60000, { runImmediately: true });

    await new Promise(r => setTimeout(r, 50));
    const job = scheduler.getJob('fail-job');
    expect(job.runCount).toBe(1);
    expect(job.lastError).toBe('something broke');
  });

  test('job records lastDurationMs', async () => {
    scheduler.registerJob('timed-job', async () => {
      await new Promise(r => setTimeout(r, 20));
    }, 60000, { runImmediately: true });

    await new Promise(r => setTimeout(r, 80));
    const job = scheduler.getJob('timed-job');
    expect(job.lastDurationMs).toBeGreaterThanOrEqual(15);
  });

  test('skips execution if previous run is still in progress', async () => {
    let enterCount = 0;
    let resolveFirst;
    const firstRunPromise = new Promise(r => { resolveFirst = r; });

    scheduler.registerJob('slow-job', async () => {
      enterCount++;
      if (enterCount === 1) await firstRunPromise; // Block first run
    }, 30, { runImmediately: true });

    // Wait long enough for multiple intervals to fire while first run is blocked
    await new Promise(r => setTimeout(r, 200));

    // enterCount should still be 1 — subsequent intervals were skipped
    expect(enterCount).toBe(1);

    // Unblock first run and let it finish
    resolveFirst();
    await new Promise(r => setTimeout(r, 50));

    // Now the job can run again on the next interval
    const job = scheduler.getJob('slow-job');
    expect(job.runCount).toBeGreaterThanOrEqual(1);
  });

  test('registeredAt is set on creation', () => {
    const before = new Date().toISOString();
    scheduler.registerJob('ts-job', async () => {}, 60000);
    const after = new Date().toISOString();
    const job = scheduler.getJob('ts-job');
    expect(job.registeredAt >= before).toBe(true);
    expect(job.registeredAt <= after).toBe(true);
  });
});
