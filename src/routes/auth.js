/**
 * Auth Routes — handles Google OAuth flow for Google Ads API access.
 *
 * Called by: src/server.js (mounted at /auth/* and /api/auth/*)
 * Calls: Google OAuth endpoints via axios
 *
 * Routes:
 *   GET  /auth/google    → Redirect to Google OAuth consent screen
 *   GET  /auth/callback  → Exchange auth code for tokens, store in session
 *   GET  /auth/logout    → Destroy session, redirect home
 *   GET  /api/auth/status → Check if user is authenticated
 */

const express = require('express');
const axios   = require('axios');

/**
 * Creates auth routes with the given config.
 *
 * @param {Object} config - App configuration from config.js
 * @param {Object} config.googleAds - Google Ads credentials
 * @param {Object} config.app - App settings (url, port)
 * @returns {express.Router} Configured auth router
 */
function createAuthRouter(config) {
  const router = express.Router();
  // Step 1: Redirect user to Google consent screen
  router.get('/auth/google', (req, res) => {
    const params = new URLSearchParams({
      client_id:     config.googleAds.clientId,
      redirect_uri:  `${config.app.url}/auth/callback`,
      response_type: 'code',
      scope:         'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/userinfo.email',
      access_type:   'offline',
      prompt:        'consent',
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  // Step 2: Exchange code for tokens
  router.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/?error=no_code');

    try {
      const { data } = await axios.post('https://oauth2.googleapis.com/token', {
        code,
        client_id:     config.googleAds.clientId,
        client_secret: config.googleAds.clientSecret,
        redirect_uri:  `${config.app.url}/auth/callback`,
        grant_type:    'authorization_code',
      });

      req.session.tokens = {
        access_token:  data.access_token,
        refresh_token: data.refresh_token,
      };

      // Fetch user identity for audit logging
      try {
        const userInfo = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${data.access_token}` },
        });
        req.session.userEmail = userInfo.data.email;
      } catch (_) {
        // Non-fatal — audit log will show 'unknown' if this fails
      }

      res.redirect('/?connected=true');
    } catch (err) {
      console.error('OAuth error:', err.response?.data || err.message);
      res.redirect('/?error=oauth_failed');
    }
  });

  // Sign out
  router.get('/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
  });

  // Check auth status
  router.get('/api/auth/status', (req, res) => {
    const connected = !!req.session.tokens?.refresh_token;
    res.json({
      connected,
      email: connected ? (req.session.userEmail || null) : null,
    });
  });

  return router;
}

module.exports = { createAuthRouter };
