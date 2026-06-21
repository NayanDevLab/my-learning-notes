// src/routes/company.routes.js
const express = require('express');
const companyController = require('../controllers/company.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/rbac.middleware');
const { validate } = require('../middleware/validate.middleware');
const { createCompanySchema, updateCompanySchema } = require('../schemas/company.schema');

const router = express.Router();

// Create: must be authenticated AND an employer.
router.post('/', requireAuth, requireRole('employer'), validate(createCompanySchema), companyController.create);

// Read: anyone (even unauthenticated) can view a company.
router.get('/:id', companyController.getById);

// Update / delete: authenticated; ownership is checked inside the service.
router.patch('/:id', requireAuth, validate(updateCompanySchema), companyController.update);
router.delete('/:id', requireAuth, companyController.remove);

module.exports = router;
