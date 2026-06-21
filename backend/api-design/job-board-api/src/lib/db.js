// src/lib/db.js
// ---------------------------------------------------------------------------
// A simple IN-MEMORY data store so the project runs with ZERO setup.
//
// 🎓 LEARNING NOTE: This stands in for a real database (Postgres/MongoDB).
// The REPOSITORY layer is the ONLY code that touches this object. Because the
// repositories hide it behind a clean interface (findById, create, ...), you
// could replace this entire file with real Postgres queries and NOTHING in the
// services or controllers would change. That's the whole point of the
// Repository pattern — storage is a swappable implementation detail.
//
// Data resets every time the server restarts (it's in memory). Run `npm run
// seed` is not needed — seeding happens automatically on boot (see seed.js
// usage in server.js) so you always have sample data to play with.
// ---------------------------------------------------------------------------

// Each "collection" is just an array of objects (like rows in a table).
const db = {
  users: [],
  companies: [],
  jobs: [],
  applications: [],
  // Redis-style denylist for revoked refresh tokens (logout). In production
  // this would live in Redis with a TTL. Here it's just a Set of token ids.
  revokedRefreshTokens: new Set(),
};

module.exports = db;
