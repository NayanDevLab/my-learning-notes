// src/middleware/auth.middleware.js
// ---------------------------------------------------------------------------
// AUTHENTICATION middleware: "who are you?" Verifies the access token from the
// Authorization: Bearer <token> header and attaches the payload to req.user.
// ---------------------------------------------------------------------------
const { verifyAccess } = require('../lib/jwt');
const { UnauthorizedError } = require('../utils/errors');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new UnauthorizedError('Missing access token'));

  try {
    req.user = verifyAccess(token); // { sub, role, email }
    next();
  } catch {
    next(new UnauthorizedError('Invalid or expired access token'));
  }
}

module.exports = { requireAuth };
