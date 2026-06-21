// src/schemas/application.schema.js
const { z } = require('zod');

// Note: the resume file itself is handled separately (multipart in real life;
// here we accept a base64 string for simplicity — see the controller). This
// schema validates the text part of the application.
const applySchema = z.object({
  coverLetter: z.string().max(5000).optional(),
  // For this no-deps demo we accept the resume as a base64 string.
  // In production this is a multipart file parsed by multer.
  resumeBase64: z.string().min(1, 'A resume PDF is required'),
});

module.exports = { applySchema };
