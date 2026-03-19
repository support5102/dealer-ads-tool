/**
 * Builder Routes — proxies Claude API calls for the Campaign Builder page.
 *
 * Called by: src/server.js (mounted at /api/builder/*)
 * Calls: Anthropic REST API via axios
 *
 * The Campaign Builder UI needs Claude for:
 *   - Autofill dealer info (with web_search tool)
 *   - Geocoding city/state to lat/lng
 *   - Finding competitor dealerships
 *   - Finding nearby cities
 *
 * All calls are proxied through this route to keep the API key server-side.
 * No Google Ads OAuth required — the builder only generates CSV files.
 *
 * Routes:
 *   POST /api/builder/ai  → Proxy a Claude API call (system + prompt + optional tools)
 */

const express = require('express');
const axios = require('axios');

/**
 * Creates builder routes with the given config.
 *
 * @param {Object} config - App configuration from config.js
 * @returns {express.Router} Configured builder router
 */
function createBuilderRouter(config) {
  const router = express.Router();

  /**
   * Proxy a Claude API call.
   *
   * Accepts system prompt, user prompt, optional tools array, and optional max_tokens.
   * Forwards to Anthropic using the server-side API key.
   * Returns the raw Anthropic response body so the client can parse it as before.
   */
  router.post('/api/builder/ai', async (req, res, next) => {
    try {
      const { system, prompt, tokens, tools } = req.body;

      if (!system || !prompt) {
        return res.status(400).json({ error: 'system and prompt are required' });
      }

      const payload = {
        model: config.claude.model,
        max_tokens: Math.min(tokens || 300, 4096),
        system,
        messages: [{ role: 'user', content: prompt }],
      };

      if (tools && Array.isArray(tools)) {
        payload.tools = tools;
      }

      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.claude.apiKey,
            'anthropic-version': '2023-06-01',
          },
          timeout: 60000, // 60s — autofill with web_search can be slow
        }
      );

      res.json(response.data);
    } catch (err) {
      // Forward Anthropic API errors with their status code
      if (err.response && err.response.data) {
        return res.status(err.response.status || 500).json({
          error: err.response.data.error?.message || 'Claude API error',
          details: err.response.data.error,
        });
      }
      next(err);
    }
  });

  return router;
}

module.exports = { createBuilderRouter };
