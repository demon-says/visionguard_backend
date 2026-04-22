// src/middleware/errorHandler.js
// Catches all errors thrown/passed to next() and returns
// a consistent JSON error response.

function errorHandler(err, req, res, next) {
  const status  = err.status  || err.statusCode || 500;
  const message = err.message || 'Internal Server Error';
  const code    = err.code    || 'INTERNAL_ERROR';

  // Always log unexpected server errors
  if (status >= 500) {
    console.error(`[Error] ${req.method} ${req.originalUrl}`, err);
  }

  res.status(status).json({
    success : false,
    error   : message,
    code,
  });
}

// Convenience factory for user-facing HTTP errors
function createError(status, message, code) {
  const err    = new Error(message);
  err.status   = status;
  err.code     = code || 'REQUEST_ERROR';
  return err;
}

module.exports = { errorHandler, createError };
