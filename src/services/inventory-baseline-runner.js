/**
 * Inventory Baseline Runner — daily scheduled job.
 *
 * For each dealer with a site-id mapping, fetches current new-VIN count
 * from Savvy API and records it in the baseline store. Updates the
 * rolling 90-day baseline for each dealer.
 *
 * Feature-flagged via PACING_ENGINE_V2_ENABLED. Gracefully skips when disabled.
 * Called by: scheduler.registerJob('inventory-baseline-daily', ...) in server.js.
 */

const siteIdRegistry = require('./site-id-registry');
const savvyInventory = require('./savvy-inventory');
const baselineStore = require('./inventory-baseline-store');

async function run() {
  const mappings = await siteIdRegistry.loadAll();
  const summary = { total: mappings.size, sampled: 0, failed: 0, samples: [] };

  for (const [dealerName, { siteId }] of mappings) {
    try {
      const count = await savvyInventory.getNewVinCount(siteId);
      await baselineStore.recordSample(dealerName, count);
      summary.sampled += 1;
      summary.samples.push({ dealerName, count });
    } catch (err) {
      summary.failed += 1;
      console.warn(`[inventory-baseline] ${dealerName} failed:`, err.message);
    }
  }

  console.log('[inventory-baseline] run complete', {
    total: summary.total,
    sampled: summary.sampled,
    failed: summary.failed,
  });
  return summary;
}

module.exports = { run };
