/**
 * Scheduler — in-memory job scheduler for recurring tasks.
 *
 * Called by: server.js (registers jobs on startup)
 * Calls: registered job functions (audit, etc.)
 *
 * Simple setInterval-based scheduler for running periodic tasks.
 * Jobs are registered at server startup and run on their interval.
 * All state is in-memory — jobs re-register on server restart.
 */

const jobs = new Map();

/**
 * Registers a named job to run on an interval.
 * If a job with the same name already exists, it is replaced.
 *
 * @param {string} name - Unique job identifier
 * @param {Function} fn - Async function to execute on each run
 * @param {number} intervalMs - Interval between runs in milliseconds
 * @param {Object} [options] - { runImmediately: false }
 */
function registerJob(name, fn, intervalMs, options = {}) {
  // Clear existing job with same name
  if (jobs.has(name)) {
    unregisterJob(name);
  }

  const job = {
    name,
    fn,
    intervalMs,
    timerId: null,
    lastRun: null,
    lastError: null,
    lastDurationMs: null,
    running: false,
    runCount: 0,
    registeredAt: new Date().toISOString(),
  };

  const execute = async () => {
    if (job.running) return; // Skip if previous run still in progress
    job.running = true;
    const start = Date.now();
    try {
      await fn();
      job.lastError = null;
    } catch (err) {
      job.lastError = err.message || String(err);
      console.error(`[scheduler] Job "${name}" failed:`, err.message);
    } finally {
      job.lastDurationMs = Date.now() - start;
      job.lastRun = new Date().toISOString();
      job.runCount++;
      job.running = false;
    }
  };

  job.timerId = setInterval(execute, intervalMs);
  jobs.set(name, job);

  if (options.runImmediately) {
    execute();
  }
}

/**
 * Unregisters a job by name, clearing its interval.
 *
 * @param {string} name - Job identifier
 * @returns {boolean} True if job was found and removed
 */
function unregisterJob(name) {
  const job = jobs.get(name);
  if (!job) return false;
  clearInterval(job.timerId);
  jobs.delete(name);
  return true;
}

/**
 * Returns status of all registered jobs.
 *
 * @returns {Object[]} Array of job status objects
 */
function listJobs() {
  return Array.from(jobs.values()).map(job => ({
    name: job.name,
    intervalMs: job.intervalMs,
    running: job.running,
    lastRun: job.lastRun,
    lastError: job.lastError,
    lastDurationMs: job.lastDurationMs,
    runCount: job.runCount,
    registeredAt: job.registeredAt,
    nextRun: job.lastRun
      ? new Date(new Date(job.lastRun).getTime() + job.intervalMs).toISOString()
      : null,
  }));
}

/**
 * Returns status of a single job by name.
 *
 * @param {string} name - Job identifier
 * @returns {Object|null} Job status or null if not found
 */
function getJob(name) {
  const all = listJobs();
  return all.find(j => j.name === name) || null;
}

/**
 * Clears all registered jobs. Used for testing cleanup.
 */
function clearAll() {
  for (const [name] of jobs) {
    unregisterJob(name);
  }
}

module.exports = {
  registerJob,
  unregisterJob,
  listJobs,
  getJob,
  clearAll,
};
