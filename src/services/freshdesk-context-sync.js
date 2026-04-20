/**
 * Freshdesk Context Sync — pulls ticket history per dealer from Freshdesk,
 * extracts structured advertising context via Claude, and stores in
 * the dealer context cache.
 *
 * Called by: routes/dealer-context.js (on-demand), or scheduled background job
 * Calls: services/freshdesk.js, services/dealer-context-extractor.js,
 *        services/dealer-context-store.js
 *
 * Flow per dealer:
 *   1. Search Freshdesk tickets by dealer tag (from Google Sheet column F)
 *   2. Fetch full descriptions for recent tickets (30-day lookback)
 *   3. Batch ticket text into a single Claude call
 *   4. Store structured context in dealer-context-store
 *
 * Rate limiting: 500ms delay between Freshdesk API calls (~120/min, well under limits)
 */

const dealerContextStore = require('./dealer-context-store');
const { extractDealerContext } = require('./dealer-context-extractor');

/**
 * Syncs dealer context from Freshdesk tickets for a single dealer.
 *
 * @param {Object} freshdeskClient - From freshdesk.createClient()
 * @param {Object} claudeConfig - { apiKey, model }
 * @param {Object} dealer - { accountId, dealerName, freshdeskTag }
 * @param {Object} [options] - { lookbackDays: 30, maxTickets: 20 }
 * @returns {Promise<Object>} { success, ticketCount, context }
 */
async function syncDealerContext(freshdeskClient, claudeConfig, dealer, options = {}) {
  const { lookbackDays = 30, maxTickets = 20 } = options;
  const { accountId, dealerName, freshdeskTag } = dealer;

  if (!freshdeskTag) {
    return { success: false, ticketCount: 0, error: 'No Freshdesk tag configured' };
  }

  try {
    // Step 1: Search tickets by tag
    const ticketSummaries = await freshdeskClient.searchTicketsByTag(freshdeskTag, lookbackDays);

    if (ticketSummaries.length === 0) {
      return { success: true, ticketCount: 0, context: null };
    }

    // Step 2: Fetch full descriptions for top N tickets (sorted by most recent)
    const sorted = ticketSummaries.sort((a, b) =>
      new Date(b.updatedAt) - new Date(a.updatedAt)
    );
    const topIds = sorted.slice(0, maxTickets).map(t => t.id);
    const fullTickets = await freshdeskClient.getTicketsBulk(topIds, 500);

    if (fullTickets.length === 0) {
      return { success: true, ticketCount: 0, context: null };
    }

    // Step 3: Build combined notes from ticket subjects + descriptions
    const ticketNotes = fullTickets.map(t =>
      `[${t.priorityLabel}] ${t.subject}\n${t.description || ''}`
    ).join('\n---\n');

    // Step 4: Extract context via Claude
    const context = await extractDealerContext(claudeConfig, dealerName, ticketNotes);
    context._meta = {
      ...context._meta,
      source: 'freshdesk_tickets',
      ticketCount: fullTickets.length,
      ticketIds: fullTickets.map(t => t.id),
      freshdeskTag,
    };

    // Step 5: Save to store
    dealerContextStore.save(accountId, context);

    return { success: true, ticketCount: fullTickets.length, context };
  } catch (err) {
    console.error(`[freshdesk-sync] Failed for ${dealerName}:`, err.message);
    return { success: false, ticketCount: 0, error: err.message };
  }
}

/**
 * Syncs context for all dealers that have a Freshdesk tag.
 *
 * @param {Object} freshdeskClient - From freshdesk.createClient()
 * @param {Object} claudeConfig - { apiKey, model }
 * @param {Object[]} dealers - Array of { accountId, dealerName, freshdeskTag }
 * @param {Object} [options] - { lookbackDays: 30, maxTickets: 20 }
 * @returns {Promise<Object>} { synced, failed, total, results[] }
 */
async function syncAllDealers(freshdeskClient, claudeConfig, dealers, options = {}) {
  const tagged = dealers.filter(d => d.freshdeskTag);
  const results = [];
  let synced = 0;
  let failed = 0;

  for (const dealer of tagged) {
    const result = await syncDealerContext(freshdeskClient, claudeConfig, dealer, options);
    results.push({ dealerName: dealer.dealerName, ...result });
    if (result.success) synced++;
    else failed++;

    // Brief delay between dealers to be gentle on Freshdesk API
    await new Promise(r => setTimeout(r, 1000));
  }

  return { synced, failed, total: tagged.length, results };
}

module.exports = {
  syncDealerContext,
  syncAllDealers,
};
