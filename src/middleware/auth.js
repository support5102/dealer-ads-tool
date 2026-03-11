/**
 * Auth Middleware — protects API routes that require Google Ads authentication.
 *
 * Called by: routes/accounts.js, routes/changes.js (applied to all /api/* routes)
 * Calls: nothing (reads req.session only)
 *
 * Checks that the user has a valid OAuth refresh token in their session.
 * Returns 401 with a descriptive message if not authenticated.
 */

/**
 * Express middleware that requires a valid Google Ads OAuth session.
 *
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next middleware
 */
function requireAuth(req, res, next) {
  if (!req.session.tokens?.refresh_token) {
    return res.status(401).json({
      error: 'Not authenticated. Please connect your Google Ads account.',
    });
  }
  next();
}

module.exports = { requireAuth };
