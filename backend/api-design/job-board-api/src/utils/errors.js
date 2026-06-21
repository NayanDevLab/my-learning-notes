// src/utils/errors.js
// ---------------------------------------------------------------------------
// Domain errors — see your "Architecture Patterns" notes.
// SERVICES throw these (pure business meaning, no HTTP knowledge). The error
// middleware maps each to the right HTTP status code. This keeps HTTP concerns
// in the web layer and business rules in the service layer.
// ---------------------------------------------------------------------------
class AppError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status; // HTTP status to return
    this.code = code; // machine-readable error code
  }
}

class ValidationError extends AppError {
  constructor(message) { super(message, 422, 'VALIDATION_ERROR'); }
}
class NotFoundError extends AppError {
  constructor(message = 'Not found') { super(message, 404, 'NOT_FOUND'); }
}
class ConflictError extends AppError {
  constructor(message) { super(message, 409, 'CONFLICT'); }
}
class UnauthorizedError extends AppError {
  constructor(message = 'Not authenticated') { super(message, 401, 'UNAUTHORIZED'); }
}
class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') { super(message, 403, 'FORBIDDEN'); }
}

module.exports = {
  AppError, ValidationError, NotFoundError, ConflictError,
  UnauthorizedError, ForbiddenError,
};
