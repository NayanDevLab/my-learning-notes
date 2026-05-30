/**
 * Base application error. Distinguishes EXPECTED, "operational" errors
 * (bad input, not found, unauthorized — safe to show the client) from
 * unexpected bugs (which should be logged at error level and hidden).
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode = 500, isOperational = true) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.isOperational = isOperational;

    // Restore the prototype chain (needed when extending built-ins in TS).
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad Request") {
    super(message, 400);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not Found") {
    super(message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super(message, 409);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = "Too Many Requests") {
    super(message, 429);
  }
}
