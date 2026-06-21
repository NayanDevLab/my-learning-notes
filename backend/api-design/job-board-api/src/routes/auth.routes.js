// src/routes/auth.routes.js
const express = require('express');
const authController = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const { rateLimit } = require('../middleware/rateLimit.middleware');
const { registerSchema, loginSchema } = require('../schemas/auth.schema');
const config = require('../config');

const router = express.Router();

// Rate-limit the auth endpoints (prevents brute-force / abuse).
const authLimiter = rateLimit({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.authMax });

// Middleware chain reads left → right: rateLimit → validate → controller.
router.post('/register', authLimiter, validate(registerSchema), authController.register);
router.post('/login', authLimiter, validate(loginSchema), authController.login);
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);
router.get('/me', requireAuth, authController.me);

module.exports = router;
