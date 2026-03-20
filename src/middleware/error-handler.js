/**
 * Error Handler — centralized Express error middleware.
 *
 * Called by: src/server.js (registered as last middleware)
 * Calls: nothing
 *
 * Catches unhandled errors from all routes and returns a consistent
 * JSON error response. Logs the full error server-side, sends a
 * safe message to the client.
 */

/**
 * Express error-handling middleware.
 * Must have 4 parameters for Express to recognize it as an error handler.
 *
 * @param {Error} err - The error that was thrown
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next middleware
 */
function errorHandler(err, req, res, next) {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);

  const statusCode = err.statusCode || 500;
  const message = statusCode === 500
    ? 'Internal server error. Check server logs for details.'
    : err.message;

  res.status(statusCode).json({ error: message });
}

module.exports = { errorHandler };
