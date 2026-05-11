/**
 * Savvy Inventory — wraps the Savvy Incentive API to count new-vehicle VINs.
 *
 * Endpoints used:
 *  GET /api/IncentiveData/GetAllVinsBySiteId/{siteId}  → string[] of VINs
 *  GET /api/IncentiveData/GetVehicleOffersAndIncentives/{VIN}  → { status: 'NEW'|'USED'|'CPO', ... }
 *
 * Only VINs with status === 'NEW' are counted.
 *
 * Performance: per-VIN detail requests are parallelised in batches of 20.
 * Results are cached per siteId for 4 hours.
 *
 * Error handling:
 *  - VIN-list fetch failure → log warning, return 0 / []
 *  - Individual per-VIN fetch failure → treat as non-new, continue
 *
 * Test injection: pass { _fetchFn } as the second argument to override axios.
 *
 * Called by: pacing-fetcher.js (future Phase 2), diagnostic tooling
 */

const axios = require('axios');

const BASE_URL =
  'https://savvyincentiveapi-optimized-hubbcncmhjaphfc3.eastus-01.azurewebsites.net/api/IncentiveData';

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const CONCURRENCY_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 10000; // 10 seconds per request

// ── Circuit breaker — when Savvy API is broadly down, stop hammering it ──
// If a batch of per-VIN requests has ≥80% failure rate, open the circuit for
// 5 minutes. While open, fetchNewVins returns empty immediately without making
// any HTTP calls. Prevents the pacing overview from hanging for minutes when
// the upstream API is degraded.
const CIRCUIT_FAILURE_RATIO = 0.8;
const CIRCUIT_OPEN_MS = 5 * 60 * 1000; // 5 minutes
let circuitOpenUntil = 0;

// ── Cache: siteId → { count, vins, fetchedAt } ────────────────────────────
const cache = new Map();

/**
 * Default fetch implementation using axios.
 *
 * @param {string} url
 * @returns {Promise<any>} response data
 */
async function defaultFetch(url) {
  const resp = await axios.get(url, { timeout: REQUEST_TIMEOUT_MS });
  return resp.data;
}

/**
 * Splits an array into chunks of at most `size` elements.
 *
 * @param {Array} arr
 * @param {number} size
 * @returns {Array[]}
 */
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Fetches the full list of VINs for a site, then parallel-fetches per-VIN
 * details in batches of CONCURRENCY_LIMIT, filters to status === 'NEW'.
 *
 * Results are cached for CACHE_TTL_MS. Returns { count, vins } from cache
 * or fresh fetch.
 *
 * @param {number} siteId
 * @param {{ _fetchFn?: Function }} [opts]
 * @returns {Promise<{ count: number, vins: string[] }>}
 */
async function fetchNewVins(siteId, { _fetchFn } = {}) {
  const fetch = _fetchFn || defaultFetch;

  // ── Hard kill switch — bypass all Savvy API calls when env flag is set ──
  // Set SAVVY_INVENTORY_DISABLED=true on Cloud Run when the Savvy Incentive API
  // is down/degraded. Returns empty immediately with no HTTP calls. Flip back to
  // unset (or false) once Savvy is healthy again.
  if (process.env.SAVVY_INVENTORY_DISABLED === 'true') {
    return { count: 0, vins: [] };
  }

  // ── Cache check ──
  const cached = cache.get(siteId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { count: cached.count, vins: cached.vins };
  }

  // ── Circuit-breaker check — return empty fast if API is currently degraded ──
  if (Date.now() < circuitOpenUntil) {
    return { count: 0, vins: [] };
  }

  // ── Fetch VIN list ──
  let allVins;
  try {
    allVins = await fetch(`${BASE_URL}/GetAllVinsBySiteId/${siteId}`);
    if (!Array.isArray(allVins)) {
      console.warn('[savvy-inventory] GetAllVinsBySiteId/%d returned non-array; treating as empty', siteId);
      allVins = [];
    }
  } catch (err) {
    console.warn('[savvy-inventory] GetAllVinsBySiteId/%d failed: %s', siteId, err.message);
    // Top-level VIN list failure also opens the circuit — if Savvy can't even
    // give us a list, no point trying per-VIN calls for the next 5 minutes.
    circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
    console.warn('[savvy-inventory] circuit OPEN for %d minutes after VIN-list failure', CIRCUIT_OPEN_MS / 60000);
    return { count: 0, vins: [] };
  }

  if (allVins.length === 0) {
    const result = { count: 0, vins: [], fetchedAt: Date.now() };
    cache.set(siteId, result);
    return { count: 0, vins: [] };
  }

  // ── Parallel per-VIN detail fetch in batches of CONCURRENCY_LIMIT ──
  const newVins = [];
  const chunks = chunkArray(allVins, CONCURRENCY_LIMIT);

  for (const chunk of chunks) {
    let batchFailures = 0;
    const results = await Promise.all(
      chunk.map(async (vin) => {
        try {
          const detail = await fetch(`${BASE_URL}/GetVehicleOffersAndIncentives/${vin}`);
          return detail && detail.status === 'NEW' ? vin : null;
        } catch (err) {
          // One bad VIN should not kill the whole count
          batchFailures += 1;
          console.warn('[savvy-inventory] GetVehicleOffersAndIncentives/%s failed: %s', vin, err.message);
          return null;
        }
      })
    );
    for (const vin of results) {
      if (vin !== null) newVins.push(vin);
    }

    // Circuit-breaker check: if this batch was mostly failures, the upstream
    // API is degraded. Open the circuit for 5 minutes and abort this dealer's
    // remaining batches — partial inventory is better than a 60-second hang.
    if (batchFailures / chunk.length >= CIRCUIT_FAILURE_RATIO) {
      circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
      console.warn('[savvy-inventory] circuit OPEN for %d min after batch failure rate %d/%d',
        CIRCUIT_OPEN_MS / 60000, batchFailures, chunk.length);
      break;
    }
  }

  // ── Store in cache ──
  const entry = { count: newVins.length, vins: newVins, fetchedAt: Date.now() };
  cache.set(siteId, entry);

  return { count: newVins.length, vins: newVins };
}

/**
 * Returns the count of new-vehicle VINs for a given site ID.
 * Cached for 4 hours. Returns 0 on API failure.
 *
 * @param {number} siteId
 * @param {{ _fetchFn?: Function }} [opts]
 * @returns {Promise<number>}
 */
async function getNewVinCount(siteId, { _fetchFn } = {}) {
  const { count } = await fetchNewVins(siteId, { _fetchFn });
  return count;
}

/**
 * Returns the array of new-vehicle VINs for a given site ID.
 * Cached for 4 hours. Returns [] on API failure.
 *
 * @param {number} siteId
 * @param {{ _fetchFn?: Function }} [opts]
 * @returns {Promise<string[]>}
 */
async function getNewVinsList(siteId, { _fetchFn } = {}) {
  const { vins } = await fetchNewVins(siteId, { _fetchFn });
  return vins;
}

/**
 * Clears the in-memory cache. Used by tests only.
 */
function _resetCacheForTesting() {
  cache.clear();
  circuitOpenUntil = 0;
}

/**
 * Exposes the raw cache map for test inspection only.
 * @returns {Map}
 */
function _getCacheForTesting() {
  return cache;
}

module.exports = {
  getNewVinCount,
  getNewVinsList,
  _resetCacheForTesting,
  _getCacheForTesting,
};
