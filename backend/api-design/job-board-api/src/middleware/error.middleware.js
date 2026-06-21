// src/middleware/error.middleware.js
// ---------------------------------------------------------------------------
// Central error handler. Every thrown/next(err) lands here. Domain errors
// (AppError) carry their own status + code; anything else is a 500.
// This is where domain errors get MAPPED to HTTP — keeping that concern out
// of the services. (Express error middleware has 4 args.)
// ---------------------------------------------------------------------------
const { AppError } = require('../utils/errors');
const { fail } = require('../utils/envelope');
const { log } = require('../lib/logger');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return fail(res, err.status, err.code, err.message);
  }
  // Unexpected error → log it, return a generic 500 (don't leak internals).
  log('error', 'unhandled error', { message: err.message, stack: err.stack });
  return fail(res, 500, 'INTERNAL_ERROR', 'Something went wrong');
}

module.exports = { errorHandler };
