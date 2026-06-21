// src/middleware/rbac.middleware.js
// ---------------------------------------------------------------------------
// AUTHORIZATION middleware: "what are you allowed to do?" Role check.
// (Resource OWNERSHIP checks live in the services, because they need to fetch
// the resource and compare owner ids — see the service files.)
// ---------------------------------------------------------------------------
const { ForbiddenError } = require('../utils/errors');

// Usage: requireRole('employer')
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      // 403 = authenticated but not allowed (vs 401 = not authenticated).
      return next(new ForbiddenError(`Requires role: ${allowedRoles.join(' or ')}`));
    }
    next();
  };
}

module.exports = { requireRole };
