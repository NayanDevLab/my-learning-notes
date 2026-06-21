// src/controllers/auth.controller.js
// ---------------------------------------------------------------------------
// CONTROLLER layer = HTTP only. Parse request → call service → format response.
// No business logic, no DB. Errors are passed to next() → error middleware.
// ---------------------------------------------------------------------------
const authService = require('../services/auth.service');
const userRepo = require('../repositories/user.repository');
const { ok } = require('../utils/envelope');
const config = require('../config');

// Helper: set the refresh token in an httpOnly cookie (JS can't read it → XSS-safe).
function setRefreshCookie(res, token) {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: false, // true in production (HTTPS only)
    sameSite: 'strict',
    maxAge: config.refreshTtlSeconds * 1000,
  });
}

function publicUser(u) {
  // Never leak the password hash (projection / least exposure).
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

class AuthController {
  register = async (req, res, next) => {
    try {
      const user = await authService.register(req.body);
      ok(res, 201, { user: publicUser(user) });
    } catch (e) { next(e); }
  };

  login = async (req, res, next) => {
    try {
      const { user, accessToken, refreshToken } = await authService.login(req.body);
      setRefreshCookie(res, refreshToken); // refresh → cookie
      ok(res, 200, { user: publicUser(user), accessToken }); // access → body
    } catch (e) { next(e); }
  };

  refresh = async (req, res, next) => {
    try {
      const { accessToken, refreshToken } = await authService.refresh(req.cookies.refreshToken);
      setRefreshCookie(res, refreshToken); // rotated refresh token
      ok(res, 200, { accessToken });
    } catch (e) { next(e); }
  };

  logout = async (req, res, next) => {
    try {
      authService.logout(req.cookies.refreshToken);
      res.clearCookie('refreshToken');
      res.status(204).send(); // 204 No Content
    } catch (e) { next(e); }
  };

  me = async (req, res, next) => {
    try {
      const user = userRepo.findById(req.user.sub);
      ok(res, 200, { user: publicUser(user) });
    } catch (e) { next(e); }
  };
}

module.exports = new AuthController();
