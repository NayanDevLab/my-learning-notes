// src/config.js
// ---------------------------------------------------------------------------
// All configuration in ONE place, read from environment variables with
// sensible defaults so the project runs out-of-the-box for learning.
// In production you'd set these via real env vars / secrets, never hard-code.
// ---------------------------------------------------------------------------
module.exports = {
  port: process.env.PORT || 3000,

  // JWT secrets (NEVER hard-code real secrets — use env vars in production)
  accessSecret: process.env.ACCESS_SECRET || 'dev-access-secret-change-me',
  refreshSecret: process.env.REFRESH_SECRET || 'dev-refresh-secret-change-me',
  accessTtl: '15m', // short-lived access token (limits blast radius if leaked)
  refreshTtl: '7d', // long-lived refresh token
  refreshTtlSeconds: 7 * 24 * 60 * 60,

  // bcrypt cost factor (10–12 is the 2026 sweet spot)
  bcryptCost: 10, // 10 for fast demo; use 12 in production

  // rate limiting
  rateLimit: {
    windowMs: 60 * 1000, // 1 minute window
    authMax: 10, // max auth attempts per window per IP
    searchMax: 30, // max search requests per window per IP
  },

  // local "S3" storage (mock) — in production this is a real S3 bucket
  uploadsDir: require('path').join(__dirname, '..', 'uploads'),
  maxUploadBytes: 5 * 1024 * 1024, // 5MB
};
