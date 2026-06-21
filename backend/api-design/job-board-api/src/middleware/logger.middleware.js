// src/middleware/logger.middleware.js
// ---------------------------------------------------------------------------
// Structured request logging (mimics pino-http). Logs every request as JSON
// with method, path, status, and latency once the response finishes.
// ---------------------------------------------------------------------------
const { log } = require('../lib/logger');

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    log('info', 'request', {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - start,
    });
  });
  next();
}

module.exports = { requestLogger };
