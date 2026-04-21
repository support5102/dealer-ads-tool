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

  // ── Cache check ──
  const cached = cache.get(siteId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { count: cached.count, vins: cached.vins };
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
    const results = await Promise.all(
      chunk.map(async (vin) => {
        try {
          const detail = await fetch(`${BASE_URL}/GetVehicleOffersAndIncentives/${vin}`);
          return detail && detail.status === 'NEW' ? vin : null;
        } catch (err) {
          // One bad VIN should not kill the whole count
          console.warn('[savvy-inventory] GetVehicleOffersAndIncentives/%s failed: %s', vin, err.message);
          return null;
        }
      })
    );
    for (const vin of results) {
      if (vin !== null) newVins.push(vin);
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
