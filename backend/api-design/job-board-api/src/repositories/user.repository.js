// src/repositories/user.repository.js
// ---------------------------------------------------------------------------
// REPOSITORY layer = database access ONLY. No business logic, no HTTP.
// Hides the storage behind a clean interface. Swap db.js for real Postgres
// and the services above never change.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const db = require('../lib/db');

class UserRepository {
  findById(id) {
    return db.users.find((u) => u.id === id) || null;
  }

  findByEmail(email) {
    return db.users.find((u) => u.email === email) || null;
  }

  create({ email, passwordHash, role, name }) {
    const user = {
      id: crypto.randomUUID(),
      email,
      password_hash: passwordHash,
      role,
      name,
      created_at: new Date().toISOString(),
    };
    db.users.push(user);
    return user;
  }
}

module.exports = new UserRepository();
