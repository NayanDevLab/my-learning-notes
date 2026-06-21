// src/schemas/auth.schema.js
const { z } = require('zod');

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  name: z.string().min(2).max(100),
  role: z.enum(['seeker', 'employer']).default('seeker'),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

module.exports = { registerSchema, loginSchema };
