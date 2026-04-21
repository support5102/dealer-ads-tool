/**
 * Site ID Registry — maps dealer_name to Savvy Incentive API site_id.
 *
 * Storage: PostgreSQL (dealer_site_mappings table) when DATABASE_URL is set,
 * in-memory fallback otherwise.
 *
 * Cache: module-level sync cache so siteIdFor() can remain synchronous.
 *
 * NOTE: Seeded names are derived from URLs and likely won't exactly match
 * Google Sheet dealer names. Operators will need to correct via setMapping()
 * after initial setup (future admin UI in Phase 6).
 *
 * Called by: savvy-inventory.js (siteIdFor), future admin routes
 */

const db = require('./database');

// ── Seed data: site_id → live_url ──────────────────────────────────────────
// Source: Brian's 50+ dealer→site_id mappings. Dealer names are derived from
// URLs by stripping www. and TLD, then converting to Title Case with spaces.
const SEED_MAPPINGS = [
  { siteId: 4,  liveUrl: 'www.bobweaverauto.com' },
  { siteId: 5,  liveUrl: 'www.gasvselectric.com' },
  { siteId: 10, liveUrl: 'www.lunghamerford.com' },
  { siteId: 13, liveUrl: 'www.reliabledealer.com' },
  { siteId: 15, liveUrl: 'www.karlflammerford.com' },
  { siteId: 17, liveUrl: 'www.cogswellmotors.com' },
  { siteId: 18, liveUrl: 'www.brightonfordco.com' },
  { siteId: 19, liveUrl: 'www.colemanmotors.com' },
  { siteId: 20, liveUrl: 'www.jarrettscottford.com' },
  { siteId: 24, liveUrl: 'www.thunderchrysler.com' },
  { siteId: 30, liveUrl: 'www.lakepowellford.com' },
  { siteId: 37, liveUrl: 'www.alanjaychevrolet.com' },
  { siteId: 38, liveUrl: 'www.alanjaykia.com' },
  { siteId: 39, liveUrl: 'www.bartowauto.com' },
  { siteId: 41, liveUrl: 'www.bannerford.com' },
  { siteId: 42, liveUrl: 'www.bannerfordofmonroe.com' },
  { siteId: 43, liveUrl: 'www.bannerchevy.com' },
  { siteId: 44, liveUrl: 'www.alanjay.com' },
  { siteId: 46, liveUrl: 'www.jarrettgordonfordwinterhaven.com' },
  { siteId: 47, liveUrl: 'alanjayfordofsebring-old.azurewebsites.net' },
  { siteId: 48, liveUrl: 'www.alanjaychryslerdodgeramjeep.com' },
  { siteId: 49, liveUrl: 'www.jarrettauto.com' },
  { siteId: 50, liveUrl: 'www.traversautomotivegroup.com' },
  { siteId: 51, liveUrl: 'www.jarrettfordofcharlottecounty.net' },
  { siteId: 52, liveUrl: 'www.bannerauto.com' },
  { siteId: 53, liveUrl: 'www.vinfastofsebring.com' },
  { siteId: 54, liveUrl: 'www.jarrettgordonforddavenport.com' },
  { siteId: 55, liveUrl: 'www.jarrettfordavonpark.com' },
  { siteId: 56, liveUrl: 'www.jarrettforddadecity.com' },
  { siteId: 57, liveUrl: 'www.stpetemitsubishi.com' },
  { siteId: 58, liveUrl: 'www.car2sellnj.com' },
  { siteId: 59, liveUrl: 'www.scarpamotors.com' },
  { siteId: 60, liveUrl: 'www.car2sell.us' },
  { siteId: 61, liveUrl: 'www.floridatrucks.com' },
  { siteId: 63, liveUrl: 'www.alamoford.com' },
  { siteId: 64, liveUrl: 'www.elmerhareford.com' },
  { siteId: 65, liveUrl: 'www.harecarpinochevroletgmc.com' },
  { siteId: 66, liveUrl: 'www.alanjayfordofsebring.com' },
  { siteId: 67, liveUrl: 'www.fordofwauchula.com' },
  { siteId: 68, liveUrl: 'www.stevefaulknerfordks.com' },
  { siteId: 69, liveUrl: 'www.alanjaynissan.com' },
  { siteId: 70, liveUrl: 'www.burlingtonchevy.com' },
  { siteId: 71, liveUrl: 'www.mcquillenchevrolet.com' },
  { siteId: 72, liveUrl: 'www.thayerchevrolet.com' },
  { siteId: 73, liveUrl: 'www.thayertoyota.com' },
  { siteId: 74, liveUrl: 'www.thayernissan.com' },
  { siteId: 75, liveUrl: 'www.thayerford.net' },
  { siteId: 76, liveUrl: 'www.thayerhonda.com' },
  { siteId: 77, liveUrl: 'www.thayercdjr.com' },
  { siteId: 78, liveUrl: 'www.srqauto.com' },
];

// ── In-memory fallback state (used when DATABASE_URL is not set) ──
// Map<dealerName, { siteId, liveUrl }>
const memMappings = new Map();

// ── Sync cache (populated by loadAll, invalidated on writes) ──
// null = stale, Map = fresh
let cache = null;

/**
 * Derives a dealer name from a URL.
 *
 * Algorithm:
 *  1. Strip leading "www." and known TLDs (.com, .net, .us, .org)
 *  2. Strip subdomains like "alanjayfordofsebring-old.azurewebsites" → take only the
 *     meaningful hostname segment (before first dot for non-www hosts)
 *  3. Split on hyphens, convert each word to Title Case, join with spaces
 *
 * Examples:
 *  www.bobweaverauto.com       → "Bob Weaver Auto"
 *  www.alanjaychevrolet.com    → "Alan Jay Chevrolet"
 *  alanjayfordofsebring-old.azurewebsites.net → "Alan Jay Ford Of Sebring Old"
 *
 * @param {string} url
 * @returns {string}
 */
function deriveDealerName(url) {
  let host = url.toLowerCase();

  // Strip www. prefix
  host = host.replace(/^www\./, '');

  // For azure/subdomain URLs, take the part before the first dot
  // e.g. "alanjayfordofsebring-old.azurewebsites.net" → "alanjayfordofsebring-old"
  const dotIdx = host.indexOf('.');
  let slug = dotIdx !== -1 ? host.slice(0, dotIdx) : host;

  // Split on hyphens, Title Case each word, join with spaces
  const words = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(' ');
}

/**
 * Loads all mappings from DB (or in-memory), refreshes cache.
 *
 * @returns {Promise<Map<string, { siteId: number, liveUrl: string }>>}
 */
async function loadAll() {
  const pool = db.getPool();
  if (pool) {
    try {
      const res = await pool.query(
        'SELECT dealer_name, site_id, live_url FROM dealer_site_mappings ORDER BY dealer_name'
      );
      const map = new Map();
      for (const row of res.rows) {
        map.set(row.dealer_name, { siteId: row.site_id, liveUrl: row.live_url });
      }
      cache = map;
      return map;
    } catch (err) {
      console.error('[site-id-registry] loadAll DB error:', err.message);
      // Fall through to in-memory
    }
  }

  // In-memory fallback
  cache = new Map(memMappings);
  return cache;
}

/**
 * Normalizes a dealer name for fuzzy matching.
 * Strips whitespace, hyphens, underscores, dots, and all non-word characters,
 * then lowercases the result.
 *
 * Examples:
 *  "Alan Jay Ford of Sebring" → "alanjayfordofsebring"
 *  "Alanjayfordofsebring"     → "alanjayfordofsebring"
 *  "SRQ Auto"                 → "srqauto"
 *
 * @param {string} name
 * @returns {string}
 */
function normalize(name) {
  return String(name || '').toLowerCase().replace(/[\s\-_.]+/g, '').replace(/[^\w]/g, '');
}

/**
 * Returns the site_id + liveUrl for a dealer name. SYNCHRONOUS — reads from cache.
 * If cache is stale, triggers an async reload and returns null for this call.
 * Next call will have a fresh cache.
 *
 * Lookup order:
 *  1. Exact (case-sensitive) match — preserves operator-corrected names
 *  2. Normalized fuzzy match — allows human-readable names (with spaces/punctuation)
 *     to match seed-derived keys (compact lowercase strings)
 *
 * @param {string} dealerName
 * @returns {{ siteId: number, liveUrl: string } | null}
 */
function siteIdFor(dealerName) {
  if (cache === null) {
    // Fire-and-forget reload so next call has fresh data
    loadAll().catch(err => console.error('[site-id-registry] background loadAll failed:', err.message));
    return null;
  }

  const key = String(dealerName || '').trim();

  // 1. Exact match first (operator-corrected names win)
  if (cache.has(key)) {
    return cache.get(key);
  }

  // 2. Normalized fuzzy fallback
  const normalizedInput = normalize(key);
  for (const [cacheKey, value] of cache) {
    if (normalize(cacheKey) === normalizedInput) {
      return value;
    }
  }

  return null;
}

/**
 * Upserts a dealer → site_id mapping. Invalidates cache.
 *
 * @param {string} dealerName
 * @param {number} siteId
 * @param {string} [liveUrl]
 * @returns {Promise<void>}
 */
async function setMapping(dealerName, siteId, liveUrl) {
  const pool = db.getPool();
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO dealer_site_mappings (dealer_name, site_id, live_url, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (dealer_name) DO UPDATE
           SET site_id = EXCLUDED.site_id,
               live_url = EXCLUDED.live_url,
               updated_at = NOW()`,
        [dealerName, siteId, liveUrl || null]
      );
      cache = null;
      return;
    } catch (err) {
      console.error('[site-id-registry] setMapping DB error:', err.message);
      throw err;
    }
  }

  // In-memory fallback
  memMappings.set(dealerName, { siteId, liveUrl: liveUrl || null });
  cache = null;
}

/**
 * Removes a dealer mapping. Invalidates cache.
 *
 * @param {string} dealerName
 * @returns {Promise<void>}
 */
async function removeMapping(dealerName) {
  const pool = db.getPool();
  if (pool) {
    try {
      await pool.query('DELETE FROM dealer_site_mappings WHERE dealer_name = $1', [dealerName]);
      cache = null;
      return;
    } catch (err) {
      console.error('[site-id-registry] removeMapping DB error:', err.message);
      throw err;
    }
  }

  // In-memory fallback
  memMappings.delete(dealerName);
  cache = null;
}

/**
 * Seeds default dealer → site_id mappings at startup.
 *
 * If the table is empty AND DATABASE_URL is set, bulk-inserts all SEED_MAPPINGS.
 * Idempotent — uses ON CONFLICT (dealer_name) DO NOTHING so repeated calls
 * are safe. In in-memory mode, populates memMappings if it is empty.
 *
 * @returns {Promise<number>} Count of rows inserted (0 if already seeded)
 */
async function seedDefaults() {
  const pool = db.getPool();

  if (pool) {
    try {
      const existing = await pool.query('SELECT COUNT(*)::int AS n FROM dealer_site_mappings');
      if (existing.rows[0].n > 0) return 0; // already seeded

      let inserted = 0;
      for (const entry of SEED_MAPPINGS) {
        const dealerName = deriveDealerName(entry.liveUrl);
        await pool.query(
          `INSERT INTO dealer_site_mappings (dealer_name, site_id, live_url)
           VALUES ($1, $2, $3)
           ON CONFLICT (dealer_name) DO NOTHING`,
          [dealerName, entry.siteId, entry.liveUrl]
        );
        inserted++;
      }
      cache = null;
      console.log('[site-id-registry] Seeded %d default dealer→site_id mappings', inserted);
      return inserted;
    } catch (err) {
      console.error('[site-id-registry] seedDefaults error:', err.message);
      return 0;
    }
  }

  // In-memory fallback: seed if empty
  if (memMappings.size > 0) return 0;

  for (const entry of SEED_MAPPINGS) {
    const dealerName = deriveDealerName(entry.liveUrl);
    memMappings.set(dealerName, { siteId: entry.siteId, liveUrl: entry.liveUrl });
  }
  cache = null;
  return SEED_MAPPINGS.length;
}

/**
 * Resets in-memory state. Used by tests only.
 */
function _resetForTesting() {
  memMappings.clear();
  cache = null;
}

module.exports = {
  loadAll,
  siteIdFor,
  setMapping,
  removeMapping,
  seedDefaults,
  deriveDealerName,  // exported for tests
  normalize,         // exported for tests
  SEED_MAPPINGS,     // exported for tests
  _resetForTesting,
};
