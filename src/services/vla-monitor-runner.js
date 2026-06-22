/**
 * VLA Monitor Runner — daily scheduled scan of every dealer in the MCC.
 *
 * For each dealer:
 *   1. Pull current VLA snapshot (campaigns, daily metrics, product issues)
 *   2. Run pure detection logic (vla-monitor.js) → array of alerts
 *   3. Reconcile against stored state (vla-alert-store.js) → lifecycle actions
 *   4. Create / update / close Freshdesk tickets per action
 *
 * Authenticated via a background refresh token (env var GOOGLE_ADS_BG_REFRESH_TOKEN);
 * no user session needed. Concurrency 6 to keep total runtime reasonable for
 * 30-dealer MCCs. Aborts if account-level error rate exceeds 30% (meta-circuit
 * mirroring savvy-inventory.js).
 *
 * Feature-flagged via VLA_MONITOR_ENABLED.
 */

const googleAds = require('./google-ads');
const freshdesk = require('./freshdesk');
const { discoverAccounts } = require('./account-iterator');
const vlaMonitor = require('./vla-monitor');
const vlaAlertStore = require('./vla-alert-store');

const CONCURRENCY = 6;
const ERROR_RATE_ABORT = 0.30;
const MIN_ACCOUNTS_BEFORE_CIRCUIT = 5;

const SEVERITY_TO_FD_PRIORITY = {
  critical: 3, // Freshdesk: 1=low 2=medium 3=high 4=urgent
  warning: 2,
};

/**
 * Builds a background REST context for one account (no user session).
 *
 * @param {Object} config - Validated app config
 * @param {string} mccAccessToken - Already-refreshed background access token
 * @param {Object} account - { customerId, name, managingMccId }
 */
function buildRestCtxForAccount(config, mccAccessToken, account) {
  const customerId = String(account.customerId || account.id || '').replace(/-/g, '');
  return {
    accessToken: mccAccessToken,
    developerToken: config.googleAds.developerToken,
    customerId,
    loginCustomerId: String(account.managingMccId || config.googleAds.mccId || '').replace(/-/g, ''),
  };
}

/**
 * Fetches one dealer's VLA snapshot in parallel.
 */
async function fetchSnapshot(restCtx) {
  const [vlaCampaigns, productIssues, productTotal] = await Promise.all([
    googleAds.getVlaCampaigns(restCtx).catch(() => []),
    googleAds.getProductIssues(restCtx).catch(() => []),
    googleAds.getProductTotal(restCtx).catch(() => 0),
  ]);

  let dailyMetrics = [];
  if (vlaCampaigns.length > 0) {
    const campaignIds = vlaCampaigns.map(c => c.campaignId);
    dailyMetrics = await googleAds.getVlaDailyMetrics14Days(restCtx, campaignIds).catch(() => []);
  }

  return { vlaCampaigns, productIssues, productTotal, dailyMetrics };
}

/**
 * Main entry point.
 *
 * @param {Object} opts
 * @param {Object} opts.config - App config from validateEnv()
 * @param {Function} [opts.now] - Injectable now() for tests
 * @returns {Promise<Object>} Run summary
 */
async function run({ config, now = () => new Date() } = {}) {
  const summary = {
    startedAt: now().toISOString(),
    processed: 0,
    errors: 0,
    aborted: false,
    ticketsCreated: 0,
    ticketsUpdated: 0,
    ticketsClosed: 0,
    skipped: 0,
  };

  if (!config) {
    try { config = require('../utils/config').validateEnv(); }
    catch (e) { return { ...summary, error: 'config invalid: ' + e.message }; }
  }
  if (!config.vlaMonitorEnabled) {
    return { ...summary, disabled: true };
  }
  if (!config.googleAdsBgRefreshToken) {
    console.warn('[vla-monitor] GOOGLE_ADS_BG_REFRESH_TOKEN not set — cannot run without background auth');
    return { ...summary, missingBgToken: true };
  }

  const mccId = config.googleAds.mccId;
  if (!mccId) {
    return { ...summary, missingMcc: true };
  }

  const fdClient = freshdesk.getDefaultClient && freshdesk.getDefaultClient();
  // Freshdesk is optional in early rollout — we still record state, just no tickets.
  const fdDryMode = !fdClient;
  if (fdDryMode) console.warn('[vla-monitor] Freshdesk not configured — running in DRY mode (state only, no tickets)');

  // Refresh background access token once for the whole run.
  let accessToken;
  try {
    accessToken = await googleAds.refreshAccessToken(config.googleAds, config.googleAdsBgRefreshToken);
  } catch (err) {
    return { ...summary, error: 'bg-auth-refresh failed: ' + err.message };
  }

  // Walk the MCC for child accounts (non-managers only).
  let accounts;
  try {
    const all = await discoverAccounts(config.googleAds, accessToken, mccId);
    accounts = (all || []).filter(a => !a.isManager);
  } catch (err) {
    return { ...summary, error: 'account discovery failed: ' + err.message };
  }

  if (accounts.length === 0) {
    return { ...summary, accounts: 0 };
  }

  // Bounded-concurrency worker pool (matches cpc-optimizer-scan).
  let cursor = 0;
  async function worker() {
    while (!summary.aborted) {
      const idx = cursor++;
      if (idx >= accounts.length) return;
      const account = accounts[idx];
      try {
        await processOne(account, { config, accessToken, fdClient, fdDryMode, summary });
        summary.processed += 1;
      } catch (err) {
        summary.errors += 1;
        console.warn(`[vla-monitor] ${account.name || account.customerId} failed: ${err.message}`);
      }
      // Meta-circuit: if early returns are mostly failing, stop the run.
      const seen = summary.processed + summary.errors;
      if (seen >= MIN_ACCOUNTS_BEFORE_CIRCUIT && (summary.errors / seen) > ERROR_RATE_ABORT) {
        summary.aborted = true;
        console.warn(`[vla-monitor] aborting — error rate ${Math.round((summary.errors / seen) * 100)}% > 30%`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, accounts.length) }, () => worker()));

  summary.finishedAt = now().toISOString();
  summary.totalAccounts = accounts.length;
  console.log('[vla-monitor] run complete', summary);
  return summary;
}

/**
 * Processes one dealer end-to-end.
 */
async function processOne(account, ctx) {
  const { config, accessToken, fdClient, fdDryMode, summary } = ctx;
  const dealerName = account.name || `customer-${account.customerId}`;
  const restCtx = buildRestCtxForAccount(config, accessToken, account);

  const snapshot = await fetchSnapshot(restCtx);
  if (snapshot.vlaCampaigns.length === 0) return; // not a VLA account

  const alerts = vlaMonitor.detectAlerts(snapshot);
  const actions = await vlaAlertStore.reconcile(dealerName, alerts);

  for (const action of actions) {
    let ticketId = action.existing ? action.existing.freshdesk_ticket_id : null;

    if (action.op === 'create' && !fdDryMode) {
      const ticket = await fdClient.createTicket({
        subject: buildSubject(dealerName, action.alert),
        description: buildBody(dealerName, account, action.alert),
        priority: SEVERITY_TO_FD_PRIORITY[action.alert.severity] || 2,
        tags: ['vla-monitor', 'auto-detect', action.alert.alert_kind.toLowerCase()],
      }).catch(err => {
        console.warn(`[vla-monitor] Freshdesk createTicket failed for ${dealerName}: ${err.message}`);
        return null;
      });
      ticketId = ticket ? ticket.id : null;
      if (ticketId) summary.ticketsCreated += 1;
    } else if (action.op === 'update' && !fdDryMode && ticketId && fdClient.addNote) {
      await fdClient.addNote(ticketId, buildUpdateNote(action.alert)).catch(err => {
        console.warn(`[vla-monitor] Freshdesk addNote failed: ${err.message}`);
      });
      summary.ticketsUpdated += 1;
    } else if (action.op === 'close' && !fdDryMode && ticketId && fdClient.updateTicket) {
      await fdClient.updateTicket(ticketId, { status: 5 /* Closed */ }).catch(err => {
        console.warn(`[vla-monitor] Freshdesk close failed: ${err.message}`);
      });
      summary.ticketsClosed += 1;
    } else if (action.op === 'skip') {
      summary.skipped += 1;
    }

    await vlaAlertStore.applyAction(dealerName, action, ticketId);
  }
}

function buildSubject(dealer, alert) {
  return `[VLA] ${dealer}: ${alert.message}`;
}

function buildBody(dealer, account, alert) {
  const lines = [
    `<strong>Dealer:</strong> ${escape(dealer)}`,
    `<strong>Customer ID:</strong> ${escape(account.customerId || account.id || '')}`,
    `<strong>Alert:</strong> ${escape(alert.alert_kind)} (${escape(alert.severity)})`,
    `<strong>Detail:</strong> ${escape(alert.message)}`,
  ];
  if (alert.payload) {
    lines.push('<strong>Payload:</strong>');
    lines.push(`<pre>${escape(JSON.stringify(alert.payload, null, 2))}</pre>`);
  }
  lines.push(`<hr/><p><a href="https://ads.savvydealer.com/pacing-overview.html">Open pacing overview</a></p>`);
  return lines.join('<br/>');
}

function buildUpdateNote(alert) {
  return `<strong>Update — ${alert.alert_kind} signature changed.</strong><br/>${escape(alert.message)}<br/><pre>${escape(JSON.stringify(alert.payload || {}, null, 2))}</pre>`;
}

function escape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = {
  run,
  buildRestCtxForAccount,
  fetchSnapshot,
  CONCURRENCY,
};
