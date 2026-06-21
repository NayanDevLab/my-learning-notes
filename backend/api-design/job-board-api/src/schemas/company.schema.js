// src/schemas/company.schema.js
const { z } = require('zod');

const createCompanySchema = z.object({
  name: z.string().min(2).max(200),
  description: z.string().max(2000).optional(),
});

const updateCompanySchema = z.object({
  name: z.string().min(2).max(200).optional(),
  description: z.string().max(2000).optional(),
});

module.exports = { createCompanySchema, updateCompanySchema };
