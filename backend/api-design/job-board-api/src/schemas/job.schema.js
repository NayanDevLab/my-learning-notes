// src/schemas/job.schema.js
const { z } = require('zod');

const createJobSchema = z.object({
  companyId: z.string().uuid(),
  title: z.string().min(3).max(200),
  location: z.string().max(100).optional(),
  type: z.enum(['remote', 'onsite', 'hybrid']).optional(),
  minSalary: z.number().int().nonnegative().optional(),
  description: z.string().min(10).max(5000),
});

const updateJobSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  location: z.string().max(100).optional(),
  type: z.enum(['remote', 'onsite', 'hybrid']).optional(),
  minSalary: z.number().int().nonnegative().optional(),
  description: z.string().min(10).max(5000).optional(),
});

// Query params arrive as strings → z.coerce converts them to the right types.
const listJobsSchema = z.object({
  location: z.string().optional(),
  type: z.enum(['remote', 'onsite', 'hybrid']).optional(),
  minSalary: z.coerce.number().int().nonnegative().optional(),
  q: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

module.exports = { createJobSchema, updateJobSchema, listJobsSchema };
