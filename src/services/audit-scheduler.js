/**
 * Audit Scheduler — orchestrates scheduled audit runs across MCC accounts.
 *
 * Called by: routes/audit.js (POST /api/audit/schedule/start, /stop)
 * Calls: services/scheduler.js, services/account-iterator.js,
 *        services/audit-engine.js, services/audit-store.js,
 *        services/google-ads.js (token refresh)
 *
 * Stores a refresh token at schedule-start time, then on each interval:
 *   1. Refreshes the OAuth access token
 *   2. Discovers all child accounts under the MCC
 *   3. Runs the audit engine against each account
 *   4. Stores results in audit-store
 *
 * The scheduler runs in-memory — it resets on server restart (Railway deploys).
 */

const scheduler = require('./scheduler');
const { discoverAccounts } = require('./account-iterator');
const { runAudit } = require('./audit-engine');
const auditStore = require('./audit-store');
const googleAds = require('./google-ads');

const JOB_NAME = 'mcc-audit';
const DEFAULT_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MIN_INTERVAL_MS = 30 * 60 * 1000;  // 30 minutes
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory state for the scheduled audit
let scheduledState = null;
let cycleRunning = false;

/**
 * Starts scheduled audits across all MCC child accounts.
 *
 * @param {Object} params
 * @param {Object} params.config - googleAds config (clientId, clientSecret, developerToken)
 * @param {string} params.refreshToken - OAuth refresh token (stored for future runs)
 * @param {string} params.mccId - MCC customer ID
 * @param {number} [params.intervalMs] - Interval between runs (default: 4 hours)
 * @param {boolean} [params.runImmediately] - Run first audit immediately
 * @returns {Object} { started: true, jobName, intervalMs, mccId }
 */
function startScheduledAudit(params) {
  const {
    config,
    refreshToken,
    mccId,
    intervalMs = DEFAULT_INTERVAL_MS,
    runImmediately = false,
  } = params;

  if (!config || !refreshToken || !mccId) {
    throw new Error('config, refreshToken, and mccId are required');
  }

  if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    throw new Error(`intervalMs must be between ${MIN_INTERVAL_MS}ms (30min) and ${MAX_INTERVAL_MS}ms (24h)`);
  }

  // Store credentials for future runs
  scheduledState = {
    config,
    refreshToken,
    mccId: String(mccId).replace(/-/g, ''),
    intervalMs,
    startedAt: new Date().toISOString(),
    lastRunAccounts: 0,
    lastRunFindings: 0,
    lastRunError: null,
  };

  const jobFn = async () => {
    await runScheduledAuditCycle();
  };

  scheduler.registerJob(JOB_NAME, jobFn, intervalMs, { runImmediately });

  return {
    started: true,
    jobName: JOB_NAME,
    intervalMs,
    mccId: scheduledState.mccId,
  };
}

/**
 * Stops the scheduled audit job.
 *
 * @returns {Object} { stopped: true } or { stopped: false, reason: string }
 */
function stopScheduledAudit() {
  const removed = scheduler.unregisterJob(JOB_NAME);
  if (removed) {
    scheduledState = null;
    // cycleRunning will be reset by the finally block if a cycle is in-flight
    return { stopped: true };
  }
  return { stopped: false, reason: 'No scheduled audit is running.' };
}

/**
 * Returns the current scheduler status.
 *
 * @returns {Object} Status including job state and last run info
 */
function getScheduleStatus() {
  const job = scheduler.getJob(JOB_NAME);

  if (!job || !scheduledState) {
    return { active: false };
  }

  return {
    active: true,
    running: job.running,
    intervalMs: job.intervalMs,
    mccId: scheduledState.mccId,
    startedAt: scheduledState.startedAt,
    lastRun: job.lastRun,
    lastError: job.lastError,
    runCount: job.runCount,
    nextRun: job.nextRun,
    lastRunAccounts: scheduledState.lastRunAccounts,
    lastRunFindings: scheduledState.lastRunFindings,
  };
}

/**
 * Executes one audit cycle: refresh token → discover accounts → audit each → store results.
 * Called by the scheduler on each interval tick.
 *
 * @returns {Promise<Object>} { total, succeeded, failed, totalFindings }
 */
async function runScheduledAuditCycle() {
  if (!scheduledState) {
    throw new Error('No scheduled audit state — call startScheduledAudit first');
  }

  if (cycleRunning) {
    console.warn('[audit-scheduler] Cycle already in progress, skipping');
    return { total: 0, succeeded: 0, failed: 0, totalFindings: 0, skipped: true };
  }

  cycleRunning = true;
  try {
    const { config, refreshToken, mccId } = scheduledState;

    // Step 1: Refresh access token
    let accessToken;
    try {
      accessToken = await googleAds.refreshAccessToken(config, refreshToken);
    } catch (err) {
      if (scheduledState) scheduledState.lastRunError = `Token refresh failed: ${err.message}`;
      throw new Error(`Token refresh failed: ${err.message}`);
    }

    // Step 2: Discover accounts
    let accounts;
    try {
      accounts = await discoverAccounts(config, accessToken, mccId);
    } catch (err) {
      if (scheduledState) scheduledState.lastRunError = `Account discovery failed: ${err.message}`;
      throw new Error(`Account discovery failed: ${err.message}`);
    }

    // Step 3: Audit each account sequentially (rate limiting built in)
    let succeeded = 0;
    let failed = 0;
    let totalFindings = 0;

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const restCtx = {
        accessToken,
        developerToken: config.developerToken,
        customerId: account.customerId.replace(/-/g, ''),
        loginCustomerId: mccId,
      };

      try {
        const result = await runAudit(restCtx);
        auditStore.save(account.customerId, result);
        totalFindings += (result.summary?.total || 0);
        succeeded++;
      } catch (err) {
        console.error(`[audit-scheduler] Audit failed for ${account.customerId} (${account.name}):`, err.message);
        failed++;
      }

      // Rate limit: 500ms between accounts
      if (i < accounts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // Update state (guard: stop may have nulled scheduledState mid-cycle)
    if (scheduledState) {
      scheduledState.lastRunAccounts = accounts.length;
      scheduledState.lastRunFindings = totalFindings;
      scheduledState.lastRunError = failed > 0 ? `${failed} account(s) failed` : null;
    }

    console.log(`[audit-scheduler] Cycle complete: ${succeeded}/${accounts.length} accounts audited, ${totalFindings} findings`);

    return { total: accounts.length, succeeded, failed, totalFindings };
  } finally {
    cycleRunning = false;
  }
}

module.exports = {
  startScheduledAudit,
  stopScheduledAudit,
  getScheduleStatus,
  runScheduledAuditCycle,
  JOB_NAME,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
};
