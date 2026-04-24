/**
 * Link Checker — HTTP health checker for ad final URLs.
 *
 * Called by: ad-copy-analyzer.js (checkBrokenLinks)
 * Calls: axios for HTTP requests
 *
 * Performs a GET request following up to 5 redirects, then classifies the
 * outcome into one of:
 *   - 'ok'                  → 2xx response, did not land on the homepage
 *   - 'http_error'          → 4xx/5xx status code (CRITICAL)
 *   - 'redirect_to_home'    → final URL pathname is '/' or empty (WARNING)
 *   - 'network_error'       → DNS, connection refused, ECONNRESET (CRITICAL)
 *   - 'timeout'             → request exceeded 8s (CRITICAL)
 *   - 'ssl_error'           → certificate validation failure (WARNING)
 *
 * Performance: dedupes URLs and runs them in parallel batches of 10 with
 * Promise.allSettled so a single hang doesn't block the audit.
 */

const axios = require('axios');

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Checks one URL and returns a classification object.
 *
 * @param {string} url - The URL to check
 * @param {Object} [options] - { timeoutMs, maxRedirects }
 * @returns {Promise<Object>} { url, status, finalUrl, statusCode?, error? }
 */
async function checkUrl(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let originalPath = '/';
  try {
    originalPath = new URL(url).pathname || '/';
  } catch (_) {
    return { url, status: 'invalid_url', error: 'Malformed URL' };
  }

  try {
    const response = await axios.get(url, {
      timeout: timeoutMs,
      maxRedirects,
      validateStatus: () => true, // we'll classify ourselves
      headers: {
        // Some dealer sites refuse default axios UA; pretend to be a real browser
        'User-Agent': 'Mozilla/5.0 (compatible; DealerAdsAuditor/1.0; +health-check)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    // axios resolves the final URL after following redirects in
    // response.request.res.responseUrl (Node) or response.request.responseURL (browser)
    const finalUrl =
      (response.request && response.request.res && response.request.res.responseUrl) ||
      response.request?.responseURL ||
      url;

    let finalPath = '/';
    try {
      finalPath = new URL(finalUrl).pathname || '/';
    } catch (_) { /* keep '/' */ }

    if (response.status >= 400) {
      return {
        url,
        finalUrl,
        statusCode: response.status,
        status: 'http_error',
      };
    }

    // Redirect-to-home: the original URL had a real path but landed on '/'
    const originalIsHome = originalPath === '/' || originalPath === '';
    const finalIsHome = finalPath === '/' || finalPath === '';
    if (!originalIsHome && finalIsHome) {
      return {
        url,
        finalUrl,
        statusCode: response.status,
        status: 'redirect_to_home',
      };
    }

    return { url, finalUrl, statusCode: response.status, status: 'ok' };
  } catch (err) {
    // axios error classification
    if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message)) {
      return { url, status: 'timeout', error: err.message };
    }
    if (err.code === 'CERT_HAS_EXPIRED' ||
        err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
        err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
        /certificate/i.test(err.message)) {
      return { url, status: 'ssl_error', error: err.message };
    }
    return { url, status: 'network_error', error: err.message || String(err) };
  }
}

/**
 * Checks many URLs in parallel batches.
 *
 * @param {string[]} urls - Array of URLs to check (will be deduped)
 * @param {Object} [options] - { timeoutMs, batchSize, checker }
 *   - checker: optional override of checkUrl, used by tests for injection
 * @returns {Promise<Object[]>} Results in original (deduped) input order
 */
async function checkUrls(urls, options = {}) {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const checker = options.checker || checkUrl;

  // Dedupe while preserving order
  const seen = new Set();
  const unique = [];
  for (const u of urls) {
    if (typeof u !== 'string' || !u) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    unique.push(u);
  }

  const results = [];
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map(u => checker(u, options)));
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      if (s.status === 'fulfilled') {
        results.push(s.value);
      } else {
        // checker itself threw (shouldn't happen — checkUrl swallows errors)
        results.push({ url: batch[j], status: 'network_error', error: String(s.reason) });
      }
    }
  }

  return results;
}

module.exports = {
  checkUrl,
  checkUrls,
};
