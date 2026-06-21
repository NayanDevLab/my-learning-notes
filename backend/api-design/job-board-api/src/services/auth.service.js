// src/services/auth.service.js
// ---------------------------------------------------------------------------
// SERVICE layer = business logic. No HTTP here (no req/res). Throws domain
// errors. Combines your Password Security + JWT + Access/Refresh notes.
// ---------------------------------------------------------------------------
const bcrypt = require('bcryptjs');
const userRepo = require('../repositories/user.repository');
const db = require('../lib/db');
const { makeAccessToken, makeRefreshToken, verifyRefresh } = require('../lib/jwt');
const config = require('../config');
const { ConflictError, UnauthorizedError } = require('../utils/errors');

class AuthService {
  async register({ email, password, name, role }) {
    // Business rule: no duplicate emails.
    if (userRepo.findByEmail(email)) {
      throw new ConflictError('Email already in use');
    }
    // Business rule: hash the password with bcrypt (never store plaintext).
    const passwordHash = await bcrypt.hash(password, config.bcryptCost);
    return userRepo.create({ email, passwordHash, role, name });
  }

  async login({ email, password }) {
    const user = userRepo.findByEmail(email);
    // Same generic message whether email is unknown or password is wrong
    // (prevents user enumeration). bcrypt.compare is timing-safe.
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) throw new UnauthorizedError('Invalid email or password');

    const accessToken = makeAccessToken(user);
    const { token: refreshToken } = makeRefreshToken(user);
    return { user, accessToken, refreshToken };
  }

  // Refresh-token ROTATION: verify the old token, revoke it, issue a new pair.
  async refresh(oldRefreshToken) {
    let payload;
    try {
      payload = verifyRefresh(oldRefreshToken);
    } catch {
      throw new UnauthorizedError('Invalid refresh token');
    }
    // If this token was already revoked → reject (logout / reuse detection).
    if (db.revokedRefreshTokens.has(payload.jti)) {
      throw new UnauthorizedError('Refresh token has been revoked');
    }
    const user = userRepo.findById(payload.sub);
    if (!user) throw new UnauthorizedError('User no longer exists');

    // Rotate: revoke the old token, mint a fresh pair.
    db.revokedRefreshTokens.add(payload.jti);
    const accessToken = makeAccessToken(user);
    const { token: refreshToken } = makeRefreshToken(user);
    return { accessToken, refreshToken };
  }

  // Logout: revoke the refresh token so it can't be used again.
  logout(refreshToken) {
    try {
      const payload = verifyRefresh(refreshToken);
      db.revokedRefreshTokens.add(payload.jti);
    } catch {
      // already invalid — nothing to do
    }
  }
}

module.exports = new AuthService();
