// src/routes/job.routes.js
// ---------------------------------------------------------------------------
// Routes for the /v1/jobs resource. Shows the full middleware chain per route:
//   rateLimit (search) / requireAuth / requireRole / validate → controller.
// ---------------------------------------------------------------------------
const express = require('express');
const jobController = require('../controllers/job.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/rbac.middleware');
const { validate } = require('../middleware/validate.middleware');
const { rateLimit } = require('../middleware/rateLimit.middleware');
const { createJobSchema, updateJobSchema, listJobsSchema } = require('../schemas/job.schema');
const config = require('../config');

const router = express.Router();

// Rate-limit the SEARCH/list endpoint (it can be expensive + abused).
const searchLimiter = rateLimit({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.searchMax });

// LIST: anyone can browse. Validate the QUERY params (note the 'query' source).
// listJobsSchema coerces strings → numbers and applies the default limit.
router.get('/', searchLimiter, validate(listJobsSchema, 'query'), jobController.list);

// READ one job: anyone.
router.get('/:id', jobController.getById);

// CREATE: must be authenticated AND an employer. Ownership of the company is
// then checked inside the service (job -> company -> owner).
router.post('/', requireAuth, requireRole('employer'), validate(createJobSchema), jobController.create);

// UPDATE / DELETE: authenticated; ownership checked inside the service.
router.patch('/:id', requireAuth, validate(updateJobSchema), jobController.update);
router.delete('/:id', requireAuth, jobController.remove);

module.exports = router;
