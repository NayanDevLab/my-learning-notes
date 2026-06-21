// src/app.js
// ---------------------------------------------------------------------------
// The Express application — wires middleware + routes together. Kept separate
// from server.js so it can be imported by tests (smoke-test.js) without
// actually starting a listening server.
//
// Middleware/route order matters and reads top-to-bottom:
//   parse cookies → parse JSON body → log request → mount routes →
//   serve uploaded files → 404 → central error handler (MUST be last).
// ---------------------------------------------------------------------------
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const { requestLogger } = require('./middleware/logger.middleware');
const { errorHandler } = require('./middleware/error.middleware');
const { fail } = require('./utils/envelope');
const { registerEmailHandlers } = require('./jobs/email.worker');

const authRoutes = require('./routes/auth.routes');
const companyRoutes = require('./routes/company.routes');
const jobRoutes = require('./routes/job.routes');
const applicationRoutes = require('./routes/application.routes');

const app = express();

// Register the background email handlers once at startup.
registerEmailHandlers();

// --- Global middleware ---
app.use(cookieParser());                       // reads the httpOnly refresh cookie
app.use(express.json({ limit: '10mb' }));      // raised limit for base64 resume payloads
app.use(requestLogger);                        // structured log per request

// --- A friendly root + health check ---
app.get('/', (req, res) => {
  res.json({
    name: 'Job Board API',
    version: '1.0.0',
    docs: 'See README.md for the full endpoint list',
    health: 'ok',
  });
});

// --- Routes (all under /v1) ---
app.use('/v1/auth', authRoutes);
app.use('/v1/companies', companyRoutes);
app.use('/v1/jobs', jobRoutes);
// Application routes are mounted at /v1 because they span /jobs/:id/... AND
// /applications/me. The /:id route in jobRoutes only matches one segment, so
// the nested application paths fall through to here. (See application.routes.js.)
app.use('/v1', applicationRoutes);

// --- Serve uploaded "resumes" (the local S3 mock) ---
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// --- 404 for anything unmatched ---
app.use((req, res) => fail(res, 404, 'NOT_FOUND', `No route for ${req.method} ${req.originalUrl}`));

// --- Central error handler (must be the LAST middleware) ---
app.use(errorHandler);

module.exports = app;
