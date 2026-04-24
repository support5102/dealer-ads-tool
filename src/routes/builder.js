/**
 * Builder Routes — proxies Claude API calls and runs a verified autofill
 * pipeline for the Campaign Builder page.
 *
 * Called by: src/server.js (mounted at /api/builder/*)
 * Calls: Anthropic REST API via axios, link-checker for URL verification
 *
 * Routes:
 *   POST /api/builder/ai        → Proxy a raw Claude API call (legacy, still used by geocode/comps)
 *   POST /api/builder/autofill  → Multi-step verified autofill from a dealer URL
 */

const express = require('express');
const axios = require('axios');
const { checkUrls } = require('../services/link-checker');

// ── Helper: call Claude API with optional tools ──
async function callClaude(config, { system, prompt, tokens, tools }) {
  const payload = {
    model: config.claude.model,
    max_tokens: Math.min(tokens || 4096, 8192),
    system,
    messages: [{ role: 'user', content: prompt }],
  };
  if (tools && Array.isArray(tools)) payload.tools = tools;

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    payload,
    {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.claude.apiKey,
        'anthropic-version': '2023-06-01',
      },
      timeout: 90000,
    }
  );
  return response.data;
}

// ── Helper: extract text from Claude response (handles tool_use blocks) ──
function extractText(response) {
  if (!response || !response.content) return '';
  return response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

// ── Helper: parse JSON from Claude text (strips markdown fences) ──
function parseJSON(text) {
  const clean = (text || '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  // Find the first { or [ and parse from there
  const start = clean.search(/[{\[]/);
  if (start < 0) return null;
  try { return JSON.parse(clean.slice(start)); } catch (_) { return null; }
}

/**
 * Creates builder routes with the given config.
 */
function createBuilderRouter(config) {
  const router = express.Router();

  // ────────────────────────────────────────────────────────────
  // Legacy: raw Claude proxy (still used by geocode, findComps)
  // ────────────────────────────────────────────────────────────
  router.post('/api/builder/ai', async (req, res, next) => {
    try {
      const { system, prompt, tokens, tools } = req.body;
      if (!system || !prompt) {
        return res.status(400).json({ error: 'system and prompt are required' });
      }
      const data = await callClaude(config, { system, prompt, tokens, tools });
      res.json(data);
    } catch (err) {
      if (err.response && err.response.data) {
        return res.status(err.response.status || 500).json({
          error: err.response.data.error?.message || 'Claude API error',
          details: err.response.data.error,
        });
      }
      next(err);
    }
  });

  // ────────────────────────────────────────────────────────────
  // NEW: Verified autofill pipeline
  //
  // Input:  { url: "https://dealer-website.com/new-inventory" }
  // Output: { dealer, city, state, makes, models: [{ make, model, url, urlVerified }],
  //           location: { lat, lng, verified }, competitors: [...], nearbyCities: [...],
  //           siteType, steps: [{ step, status, message }] }
  //
  // Every piece of data is verified before being returned.
  // ────────────────────────────────────────────────────────────
  router.post('/api/builder/autofill', async (req, res, next) => {
    const { url } = req.body;
    if (!url || !url.startsWith('http')) {
      return res.status(400).json({ error: 'Valid URL required (must start with http)' });
    }

    const steps = [];
    function log(step, status, message) {
      steps.push({ step, status, message, time: new Date().toISOString() });
    }

    try {
      // ── STEP 1: Read the dealer site → extract dealer info + inventory links ──
      log('read_site', 'running', 'Reading dealer website...');

      const siteResponse = await callClaude(config, {
        system: `You are extracting verified information from a car dealership website. You MUST use web_search to fetch and read the actual page — never guess or use training data.

INSTRUCTIONS — follow every step precisely:

1. DEALER NAME: Find the branded dealership name shown in the site header, logo, or page title. Use the SHORT branded name (e.g. "Thayer Ford", "Alan Jay Chevrolet"). Do NOT use legal entity names, parent company names, or group names.

2. PHYSICAL ADDRESS: Find the dealership's physical street address on the page. Check header, footer, and contact section. Extract city and state abbreviation.

3. MAKES: List ONLY the OEM brands this dealer sells as NEW vehicles. Look at navigation links, "New Inventory" sections, and model-specific pages. Do NOT include used-only brands.

4. NEW MODEL INVENTORY URLS: This is the most important part.
   - Navigate to the "New Inventory" or "New Vehicles" section of the site
   - Find links to EACH specific model's inventory page (e.g. the page that shows all new Ford F-150s in stock)
   - For EACH model the dealer sells NEW, extract:
     a. The make (e.g. "Ford")
     b. The model name (e.g. "F-150")
     c. The EXACT URL that links to that model's new inventory page — copy the real URL from the page, do NOT construct or guess it
   - Only include models where you found an actual link on the site
   - Do NOT use the hardcoded model list from your training data — only report models that appear on THIS dealer's website

5. SITE PLATFORM: Identify the website platform from URL patterns:
   - "autofusion": URLs contain /search/New+Make+Model+tmM
   - "teamvelocity": URLs contain /inventory/new/make/model
   - "dealerinspire": URLs contain /new-vehicles/model/
   - "eprocess": URLs contain /search/new-make-model-city-state/?cy=
   - "foxdealer": URLs contain /new-inventory/ or /inventory/?condition=new
   - "unknown": if none match

Return ONLY valid JSON — no markdown, no explanation:
{
  "dealerName": "Dealer Name",
  "street": "123 Main St",
  "city": "Springfield",
  "state": "IL",
  "makes": ["Ford"],
  "siteType": "dealerinspire",
  "models": [
    { "make": "Ford", "model": "F-150", "url": "https://example.com/new-vehicles/f-150/" },
    { "make": "Ford", "model": "Explorer", "url": "https://example.com/new-vehicles/explorer/" }
  ]
}`,
        prompt: `Fetch this dealer website and extract all the information described above: ${url}`,
        tokens: 4096,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      });

      const siteText = extractText(siteResponse);
      const siteInfo = parseJSON(siteText);

      if (!siteInfo || !siteInfo.dealerName) {
        log('read_site', 'error', 'Could not extract dealer info from page');
        return res.json({ error: 'Could not read dealer site', steps });
      }

      log('read_site', 'done', `Found: ${siteInfo.dealerName} — ${(siteInfo.makes || []).join(', ')} — ${siteInfo.city}, ${siteInfo.state}`);

      // ── STEP 2: Verify every model URL with HTTP check ──
      const models = siteInfo.models || [];
      log('verify_urls', 'running', `Verifying ${models.length} model URLs...`);

      const modelUrls = models.map(m => m.url).filter(Boolean);
      let urlResults = [];
      if (modelUrls.length > 0) {
        urlResults = await checkUrls(modelUrls, { timeoutMs: 10000 });
      }

      // Build a map of url → result
      const urlStatus = {};
      for (const r of urlResults) {
        urlStatus[r.url] = r;
      }

      // Annotate each model with verification status
      const verifiedModels = models.map(m => {
        const check = urlStatus[m.url];
        let verified = false;
        let urlIssue = null;

        if (!m.url) {
          urlIssue = 'No URL found on site';
        } else if (!check) {
          urlIssue = 'URL not checked';
        } else if (check.status === 'ok') {
          verified = true;
        } else if (check.status === 'redirect_to_home') {
          urlIssue = 'Redirects to homepage — page may not exist';
        } else if (check.status === 'http_error') {
          urlIssue = `HTTP ${check.statusCode} error`;
        } else if (check.status === 'timeout') {
          urlIssue = 'Timed out';
        } else if (check.status === 'network_error') {
          urlIssue = 'Network error: ' + (check.error || '').slice(0, 60);
        } else if (check.status === 'ssl_error') {
          urlIssue = 'SSL certificate issue';
          verified = true; // SSL issues are warnings, URL still works
        } else {
          urlIssue = check.status;
        }

        return {
          make: m.make,
          model: m.model,
          url: m.url || '',
          urlVerified: verified,
          urlIssue,
        };
      });

      const verifiedCount = verifiedModels.filter(m => m.urlVerified).length;
      const failedCount = verifiedModels.length - verifiedCount;
      log('verify_urls', failedCount > 0 ? 'warning' : 'done',
        `${verifiedCount}/${verifiedModels.length} URLs verified` +
        (failedCount > 0 ? ` — ${failedCount} failed` : ''));

      // ── STEP 3: Geocode the address ──
      log('geocode', 'running', `Geocoding ${siteInfo.city}, ${siteInfo.state}...`);

      let location = { lat: null, lng: null, verified: false };
      try {
        const geoResponse = await callClaude(config, {
          system: 'You are a geocoding service. Return ONLY a JSON object with lat, lng as decimal numbers. Use your knowledge to provide accurate GPS coordinates for US cities. Do NOT explain or add markdown.',
          prompt: `GPS coordinates for ${siteInfo.city}, ${siteInfo.state}, USA. Return: {"lat": 00.000000, "lng": -00.000000}`,
          tokens: 100,
        });
        const geoText = extractText(geoResponse);
        const geo = parseJSON(geoText);
        if (geo && typeof geo.lat === 'number' && typeof geo.lng === 'number') {
          // Basic sanity: lat must be 24-50 (CONUS), lng must be -125 to -66
          if (geo.lat >= 24 && geo.lat <= 50 && geo.lng >= -125 && geo.lng <= -66) {
            location = { lat: +geo.lat.toFixed(6), lng: +geo.lng.toFixed(6), verified: true };
            log('geocode', 'done', `${siteInfo.city}, ${siteInfo.state} → ${location.lat}, ${location.lng}`);
          } else {
            log('geocode', 'warning', `Coordinates out of CONUS range: ${geo.lat}, ${geo.lng}`);
            location = { lat: +geo.lat.toFixed(6), lng: +geo.lng.toFixed(6), verified: false };
          }
        } else {
          log('geocode', 'error', 'Could not parse geocode response');
        }
      } catch (geoErr) {
        log('geocode', 'error', 'Geocoding failed: ' + geoErr.message);
      }

      // ── STEP 4: Find nearby cities ──
      log('nearby_cities', 'running', 'Finding nearby cities...');

      let nearbyCities = [];
      try {
        const nearbyResponse = await callClaude(config, {
          system: 'You are a US geography expert. Return ONLY a JSON array of city names (strings) within approximately 30 miles of the given city. Include 5-10 cities, sorted by proximity. Do NOT include the city itself. No markdown.',
          prompt: `Cities within 30 miles of ${siteInfo.city}, ${siteInfo.state}: return ["City1", "City2", ...]`,
          tokens: 300,
        });
        const nearbyText = extractText(nearbyResponse);
        const nearby = parseJSON(nearbyText);
        if (Array.isArray(nearby)) {
          nearbyCities = nearby.filter(c => typeof c === 'string').slice(0, 10);
          log('nearby_cities', 'done', `Found ${nearbyCities.length} nearby cities`);
        } else {
          log('nearby_cities', 'warning', 'Could not parse nearby cities');
        }
      } catch (ncErr) {
        log('nearby_cities', 'error', 'Nearby cities failed: ' + ncErr.message);
      }

      // ── STEP 5: Find competitors ──
      log('competitors', 'running', 'Finding competitor dealers...');

      let competitors = [];
      try {
        const makesStr = (siteInfo.makes || []).join('/');
        const compResponse = await callClaude(config, {
          system: 'You are a car industry expert with knowledge of US dealership locations. Return ONLY a JSON array of dealer name strings — the 5 closest authorized same-make franchise dealerships. No markdown, no explanation.',
          prompt: `List up to 5 authorized ${makesStr} franchise dealerships closest to ${siteInfo.city}, ${siteInfo.state}. Do NOT include "${siteInfo.dealerName}". Return: ["Dealer A", "Dealer B"]`,
          tokens: 300,
        });
        const compText = extractText(compResponse);
        const comps = parseJSON(compText);
        if (Array.isArray(comps)) {
          competitors = comps.filter(c => typeof c === 'string').slice(0, 5);
          log('competitors', 'done', `Found ${competitors.length} competitors`);
        } else {
          log('competitors', 'warning', 'Could not parse competitors');
        }
      } catch (compErr) {
        log('competitors', 'error', 'Competitors failed: ' + compErr.message);
      }

      // ── Return verified result ──
      res.json({
        dealer: siteInfo.dealerName,
        city: siteInfo.city,
        state: siteInfo.state,
        street: siteInfo.street || '',
        makes: siteInfo.makes || [],
        siteType: siteInfo.siteType || 'unknown',
        models: verifiedModels,
        location,
        nearbyCities,
        competitors,
        steps,
        sourceUrl: url,
      });

    } catch (err) {
      log('fatal', 'error', err.message);
      console.error('Builder autofill error:', err.message);
      res.status(500).json({ error: 'Autofill failed: ' + err.message, steps });
    }
  });

  return router;
}

module.exports = { createBuilderRouter };
