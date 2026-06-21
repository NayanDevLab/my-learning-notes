// src/routes/application.routes.js
// ---------------------------------------------------------------------------
// Application routes. These span two URL shapes, so this router is mounted at
// '/v1' (see app.js) and uses full paths:
//   POST /v1/jobs/:id/apply         → a SEEKER applies to a job
//   GET  /v1/jobs/:id/applications  → the EMPLOYER who owns the job sees applicants
//   GET  /v1/applications/me        → a SEEKER sees their own applications
//
// 🎓 Why mounted at '/v1' and not '/v1/jobs': two of these live UNDER a job
// (/jobs/:id/...) and one lives under /applications. Mounting at '/v1' lets one
// router own all application-related paths. Express tries the /v1/jobs router
// first, but '/:id' only matches a single segment, so '/jobs/:id/apply' and
// '/jobs/:id/applications' fall through to here. (See app.js mounting order.)
// ---------------------------------------------------------------------------
const express = require('express');
const applicationController = require('../controllers/application.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/rbac.middleware');
const { validate } = require('../middleware/validate.middleware');
const { applySchema } = require('../schemas/application.schema');

const router = express.Router();

// A seeker applies to a job (uploads a resume). 409 if already applied.
router.post(
  '/jobs/:id/apply',
  requireAuth,
  requireRole('seeker'),
  validate(applySchema),
  applicationController.apply
);

// The employer who owns the job views its applicants (ownership in service).
router.get(
  '/jobs/:id/applications',
  requireAuth,
  requireRole('employer'),
  applicationController.listForJob
);

// A seeker views their own applications.
router.get(
  '/applications/me',
  requireAuth,
  requireRole('seeker'),
  applicationController.listMine
);

module.exports = router;
