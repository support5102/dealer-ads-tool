/**
 * Change Alerts Runner — daily scheduled job.
 *
 * For each dealer in the MCC, queries Google Ads change_event for recent changes
 * to budgets / campaigns / ad groups / location targeting. For each undeduped
 * change, creates a Freshdesk ticket. Records the change_resource_name +
 * change_date_time pair in change_alert_dedup to avoid double-ticketing.
 *
 * Feature-flagged via CHANGE_ALERTS_ENABLED. Independent of PACING_ENGINE_V2_ENABLED.
 */

const googleAds = require('./google-ads');
const freshdesk = require('./freshdesk');
const database = require('./database');

const CHANGE_TYPES = {
  CAMPAIGN_BUDGET: { label: 'Budget edited', priority: 2 },
  CAMPAIGN: { label: 'Campaign added/removed', priority: 2 },
  AD_GROUP: { label: 'Ad group added/removed', priority: 2 },
  CAMPAIGN_CRITERION: { label: 'Location targeting changed', priority: 2 },
};

async function run({ listAccounts, getRestCtxForAccount }) {
  const summary = { processed: 0, ticketsCreated: 0, deduped: 0, errors: 0 };

  // Feature flag check
  let flagEnabled = false;
  try {
    const { validateEnv } = require('../utils/config');
    const cfg = validateEnv();
    flagEnabled = cfg.changeAlertsEnabled;
  } catch (_) {}
  if (!flagEnabled) {
    console.log('[change-alerts] disabled via CHANGE_ALERTS_ENABLED; skipping run');
    return { ...summary, disabled: true };
  }

  const fdClient = freshdesk.getDefaultClient();
  if (!fdClient) {
    console.warn('[change-alerts] Freshdesk not configured; skipping run');
    return { ...summary, fdNotConfigured: true };
  }

  const accounts = await listAccounts();

  for (const account of accounts) {
    summary.processed += 1;
    try {
      const restCtx = await getRestCtxForAccount(account);
      const changes = await googleAds.getRecentChangeEvents(restCtx, 28);

      for (const change of changes) {
        try {
          const resourceName = change.changeEvent?.resourceName;
          const changeTime = change.changeEvent?.changeDateTime;
          if (!resourceName || !changeTime) continue;

          // Dedup check
          const alreadySeen = await isAlreadyAlerted(resourceName, changeTime);
          if (alreadySeen) { summary.deduped += 1; continue; }

          // Create ticket
          const ticket = await fdClient.createTicket({
            subject: `[Auto-detect] ${account.name}: ${CHANGE_TYPES[change.changeEvent.changeResourceType]?.label || 'Change detected'}`,
            description: buildTicketBody(account, change),
            priority: CHANGE_TYPES[change.changeEvent.changeResourceType]?.priority || 2,
            tags: ['auto-detect', 'pacing-recs-v2'],
          });

          await recordAlerted(resourceName, changeTime, ticket.id);
          summary.ticketsCreated += 1;
        } catch (innerErr) {
          summary.errors += 1;
          console.warn(`[change-alerts] change-processing failed for ${account.name}:`, innerErr.message);
        }
      }
    } catch (err) {
      summary.errors += 1;
      console.warn(`[change-alerts] account ${account.name} failed:`, err.message);
    }
  }

  console.log('[change-alerts] run complete', summary);
  return summary;
}

// Dedup helpers — use Postgres if available, in-memory fallback otherwise
const inMemoryDedup = new Set();

async function isAlreadyAlerted(resourceName, changeTime) {
  const pool = database.getPool();
  if (!pool) {
    return inMemoryDedup.has(`${resourceName}|${changeTime}`);
  }
  const res = await pool.query(
    'SELECT 1 FROM change_alert_dedup WHERE change_resource_name = $1 AND change_date_time = $2',
    [resourceName, changeTime]
  );
  return res.rowCount > 0;
}

async function recordAlerted(resourceName, changeTime, ticketId) {
  const pool = database.getPool();
  if (!pool) {
    inMemoryDedup.add(`${resourceName}|${changeTime}`);
    return;
  }
  await pool.query(
    'INSERT INTO change_alert_dedup (change_resource_name, change_date_time, freshdesk_ticket_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [resourceName, changeTime, ticketId]
  );
}

function buildTicketBody(account, change) {
  const ev = change.changeEvent || {};
  const lines = [
    `<strong>Dealer:</strong> ${account.name}`,
    `<strong>Customer ID:</strong> ${account.customerId || account.id}`,
    `<strong>Change type:</strong> ${ev.changeResourceType}`,
    `<strong>Operation:</strong> ${ev.operation || 'unknown'}`,
    `<strong>Changed at:</strong> ${ev.changeDateTime}`,
    `<strong>Changed by:</strong> ${ev.userEmail || '(unknown)'}`,
    `<strong>Resource:</strong> ${ev.changeResourceName || ev.resourceName}`,
  ];
  if (ev.changedFields) lines.push(`<strong>Fields:</strong> ${ev.changedFields}`);
  if (ev.oldResource) lines.push(`<strong>Old value:</strong> <pre>${JSON.stringify(ev.oldResource, null, 2)}</pre>`);
  if (ev.newResource) lines.push(`<strong>New value:</strong> <pre>${JSON.stringify(ev.newResource, null, 2)}</pre>`);
  lines.push(`<hr/><p><a href="https://dealer-ads-tool-840281790428.us-east1.run.app/pacing-overview.html">Open pacing overview</a></p>`);
  return lines.join('<br/>');
}

module.exports = { run, _inMemoryDedup: inMemoryDedup };
