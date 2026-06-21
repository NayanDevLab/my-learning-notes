// src/server.js
// ---------------------------------------------------------------------------
// The entry point. Seeds sample data, then starts the HTTP server.
// Run with: npm start   (or npm run dev for auto-reload)
// ---------------------------------------------------------------------------
const app = require('./app');
const config = require('./config');
const { seedDatabase } = require('../seed');
const { log } = require('./lib/logger');

// Populate sample data so the API is immediately usable.
seedDatabase();

app.listen(config.port, () => {
  log('info', `🚀 Job Board API running on http://localhost:${config.port}`);
  log('info', 'Try it →  curl http://localhost:' + config.port + '/v1/jobs');
  log('info', 'Login   →  employer@demo.com / seeker@demo.com  (password: password123)');
});
