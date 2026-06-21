// src/lib/jwt.js
// ---------------------------------------------------------------------------
// JWT helpers — see your "JWT Internals" and "Access + Refresh Token" notes.
//   - Access token  = short-lived (15m), sent on every request.
//   - Refresh token = long-lived (7d), used only to get new access tokens,
//                     carries a unique `jti` so we can revoke it on logout.
// ---------------------------------------------------------------------------
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');

function makeAccessToken(user) {
  // `sub` = subject (the user id), `role` for RBAC checks.
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    config.accessSecret,
    { expiresIn: config.accessTtl }
  );
}

function makeRefreshToken(user) {
  const jti = crypto.randomUUID(); // unique id for this token (for revocation)
  const token = jwt.sign({ sub: user.id, jti }, config.refreshSecret, {
    expiresIn: config.refreshTtl,
  });
  return { token, jti };
}

function verifyAccess(token) {
  return jwt.verify(token, config.accessSecret); // throws if invalid/expired
}

function verifyRefresh(token) {
  return jwt.verify(token, config.refreshSecret);
}

module.exports = { makeAccessToken, makeRefreshToken, verifyAccess, verifyRefresh };
