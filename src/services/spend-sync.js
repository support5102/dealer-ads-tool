/**
 * Spend Sync — daily automated spend pull from Google Ads → Google Sheets.
 *
 * Called by: server.js (registered on startup or via API)
 * Calls: services/google-ads.js, Google Sheets API
 *
 * Pulls month-to-date spend for every account under the MCC hierarchy,
 * then writes each account's total spend to the "PPC Spend Pace" sheet
 * Column B (Cost). Runs daily at 8 AM EST via a self-scheduling timer.
 */

const axios = require('axios');
const googleAds = require('./google-ads');
const { discoverAccounts } = require('./account-iterator');

// ─── State ──────────────────────────────────────────────────────────────

let syncState = {
  enabled: false,
  timerId: null,
  config: null,         // googleAds config
  refreshToken: null,   // stored on enable so background job can refresh
  mccId: null,
  spreadsheetId: null,
  lastRun: null,
  lastError: null,
  lastDurationMs: null,
  lastAccountCount: 0,
  running: false,
  nextRun: null,
};

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Calculate milliseconds until next 8:00 AM Eastern (handles EST/EDT).
 * Returns at least 60 seconds to avoid tight loops.
 */
function msUntilNext8amEastern() {
  const now = new Date();
  // Build a date string in America/New_York timezone
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const easternHour = eastern.getHours();
  const easternMin = eastern.getMinutes();

  // Calculate target: today at 8:00 if it hasn't passed, else tomorrow
  let targetEastern = new Date(eastern);
  targetEastern.setHours(8, 0, 0, 0);

  if (easternHour > 8 || (easternHour === 8 && easternMin >= 0)) {
    // Already past 8 AM today — target tomorrow
    targetEastern.setDate(targetEastern.getDate() + 1);
  }

  // Convert back to actual UTC offset difference
  const diffMs = targetEastern.getTime() - eastern.getTime();
  return Math.max(diffMs, 60_000); // At least 60s
}

/**
 * Write spend values to Google Sheets column B for matching account rows.
 *
 * @param {string} accessToken - OAuth access token with spreadsheets scope
 * @param {string} spreadsheetId - Google Sheets ID
 * @param {Map<string,number>} spendByName - Map of normalized account name → total spend
 */
async function writeSpendToSheet(accessToken, spreadsheetId, spendByName) {
  // Read existing rows to find which row each account is in
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent('PPC Spend Pace!A2:C')}`;
  const readResp = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const rows = readResp.data.values || [];
  if (rows.length === 0) {
    console.log('[spend-sync] No rows in PPC Spend Pace sheet — nothing to update.');
    return 0;
  }

  // Build batch update: for each row, if we have spend data, update column B
  const updates = [];
  for (let i = 0; i < rows.length; i++) {
    const name = (rows[i][0] || '').trim().toLowerCase();
    if (spendByName.has(name)) {
      const spend = spendByName.get(name);
      const rowNum = i + 2; // +2 because sheet is 1-indexed and we skip header
      updates.push({
        range: `PPC Spend Pace!B${rowNum}`,
        values: [[`$${spend.toFixed(2)}`]],
      });
    }
  }

  if (updates.length === 0) {
    console.log('[spend-sync] No matching accounts found in sheet.');
    return 0;
  }

  // Batch update via Sheets API
  const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`;
  await axios.post(batchUrl, {
    valueInputOption: 'USER_ENTERED',
    data: updates,
  }, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  console.log(`[spend-sync] Updated ${updates.length} account spend values in sheet.`);
  return updates.length;
}

// ─── Core sync function ─────────────────────────────────────────────────

/**
 * Runs one spend sync cycle:
 * 1. Refresh access token
 * 2. Discover all accounts under MCC
 * 3. Fetch month-to-date spend for each account
 * 4. Write spend to Google Sheets column B
 */
async function runSpendSync() {
  if (syncState.running) {
    console.log('[spend-sync] Already running, skipping.');
    return;
  }
  if (!syncState.config || !syncState.refreshToken) {
    console.error('[spend-sync] Not configured — missing config or refresh token.');
    return;
  }

  syncState.running = true;
  const start = Date.now();
  console.log('[spend-sync] Starting daily spend sync...');

  try {
    // 1. Refresh access token
    const accessToken = await googleAds.refreshAccessToken(
      syncState.config,
      syncState.refreshToken
    );

    // 2. Discover all accounts (recursive through sub-MCCs)
    const accounts = await discoverAccounts(
      syncState.config,
      accessToken,
      syncState.mccId
    );
    console.log(`[spend-sync] Found ${accounts.length} accounts.`);

    // 3. Fetch month-to-date spend for each account (batched to avoid rate limits)
    const spendByName = new Map();
    const BATCH_SIZE = 6;

    for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
      const batch = accounts.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (acct) => {
          const loginMcc = acct.managingMccId || String(syncState.mccId).replace(/-/g, '');
          const restCtx = {
            accessToken,
            developerToken: syncState.config.developerToken,
            customerId: acct.customerId.replace(/-/g, ''),
            loginCustomerId: loginMcc,
          };
          const campaigns = await googleAds.getMonthSpend(restCtx);
          const totalSpend = campaigns.reduce((sum, c) => sum + (c.spend || 0), 0);
          return { name: acct.name, spend: totalSpend };
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled') {
          const key = r.value.name.trim().toLowerCase();
          spendByName.set(key, r.value.spend);
        }
      }

      // Rate limit between batches
      if (i + BATCH_SIZE < accounts.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    console.log(`[spend-sync] Fetched spend for ${spendByName.size} accounts.`);

    // 4. Write to Google Sheets
    const updated = await writeSpendToSheet(accessToken, syncState.spreadsheetId, spendByName);

    syncState.lastError = null;
    syncState.lastAccountCount = updated;
    console.log(`[spend-sync] Complete. Updated ${updated} rows in ${Date.now() - start}ms.`);

  } catch (err) {
    syncState.lastError = err.message || String(err);
    console.error('[spend-sync] Failed:', err.message);
  } finally {
    syncState.running = false;
    syncState.lastRun = new Date().toISOString();
    syncState.lastDurationMs = Date.now() - start;
    // Schedule next run
    scheduleNextRun();
  }
}

// ─── Scheduling ─────────────────────────────────────────────────────────

function scheduleNextRun() {
  if (!syncState.enabled) return;
  if (syncState.timerId) clearTimeout(syncState.timerId);

  const delay = msUntilNext8amEastern();
  const nextDate = new Date(Date.now() + delay);
  syncState.nextRun = nextDate.toISOString();

  console.log(`[spend-sync] Next run scheduled for ${nextDate.toLocaleString('en-US', { timeZone: 'America/New_York' })} Eastern (in ${Math.round(delay / 60000)}min)`);

  syncState.timerId = setTimeout(() => {
    runSpendSync();
  }, delay);
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Enable the daily spend sync.
 *
 * @param {Object} params
 * @param {Object} params.config - googleAds config
 * @param {string} params.refreshToken - OAuth refresh token
 * @param {string} params.mccId - MCC customer ID
 * @param {string} params.spreadsheetId - Google Sheets ID
 * @param {boolean} [params.runNow=false] - Run immediately in addition to scheduling
 */
function enableSpendSync(params) {
  const { config, refreshToken, mccId, spreadsheetId, runNow = false } = params;

  syncState.config = config;
  syncState.refreshToken = refreshToken;
  syncState.mccId = mccId;
  syncState.spreadsheetId = spreadsheetId;
  syncState.enabled = true;

  console.log('[spend-sync] Enabled. Scheduling daily sync at 8 AM Eastern.');
  scheduleNextRun();

  if (runNow) {
    runSpendSync();
  }
}

/**
 * Disable the daily spend sync.
 */
function disableSpendSync() {
  syncState.enabled = false;
  if (syncState.timerId) {
    clearTimeout(syncState.timerId);
    syncState.timerId = null;
  }
  syncState.nextRun = null;
  console.log('[spend-sync] Disabled.');
}

/**
 * Update the stored refresh token (called when user re-authenticates).
 */
function updateRefreshToken(refreshToken) {
  if (refreshToken && syncState.enabled) {
    syncState.refreshToken = refreshToken;
    console.log('[spend-sync] Refresh token updated.');
  }
}

/**
 * Get current sync status.
 */
function getSpendSyncStatus() {
  return {
    enabled: syncState.enabled,
    running: syncState.running,
    lastRun: syncState.lastRun,
    lastError: syncState.lastError,
    lastDurationMs: syncState.lastDurationMs,
    lastAccountCount: syncState.lastAccountCount,
    nextRun: syncState.nextRun,
    hasRefreshToken: !!syncState.refreshToken,
    hasMccId: !!syncState.mccId,
    hasSpreadsheetId: !!syncState.spreadsheetId,
  };
}

module.exports = {
  enableSpendSync,
  disableSpendSync,
  updateRefreshToken,
  getSpendSyncStatus,
  runSpendSync,
};
