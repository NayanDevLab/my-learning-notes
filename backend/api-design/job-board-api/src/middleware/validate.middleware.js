// src/middleware/validate.middleware.js
// ---------------------------------------------------------------------------
// Zod validation middleware. Parses req.body (or query) against a schema.
// On failure → 422 with the validation details. This is INPUT validation at
// the edge; deeper business validation lives in the services.
// ---------------------------------------------------------------------------
const { ValidationError } = require('../utils/errors');

// validate(schema) checks req.body; validate(schema, 'query') checks req.query.
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const first = result.error.issues[0];
      const path = first.path.join('.');
      return next(new ValidationError(`${path ? path + ': ' : ''}${first.message}`));
    }
    // Replace with the parsed (and coerced) data.
    req[source] = result.data;
    next();
  };
}

module.exports = { validate };
