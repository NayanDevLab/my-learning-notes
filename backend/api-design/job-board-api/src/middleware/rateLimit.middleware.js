// src/middleware/rateLimit.middleware.js
// ---------------------------------------------------------------------------
// A simple in-memory rate limiter (mimics express-rate-limit). Tracks requests
// per IP in a sliding window and returns 429 when the limit is exceeded.
// In production you'd back this with Redis so it works across servers.
// Used on auth + search endpoints (prevents brute force / abuse).
// ---------------------------------------------------------------------------
const { AppError } = require('../utils/errors');

function rateLimit({ windowMs, max }) {
  const hits = new Map(); // ip -> [timestamps]

  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;

    // Keep only timestamps inside the current window.
    const timestamps = (hits.get(ip) || []).filter((t) => t > windowStart);
    timestamps.push(now);
    hits.set(ip, timestamps);

    if (timestamps.length > max) {
      return next(new AppError('Too many requests, please slow down', 429, 'RATE_LIMITED'));
    }
    next();
  };
}

module.exports = { rateLimit };
