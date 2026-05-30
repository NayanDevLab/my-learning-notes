import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { AppError } from "../utils/errors";
import { logger } from "../config/logger";
import { env } from "../config/env";

/**
 * Centralized error handler. MUST be registered last and MUST keep all four
 * parameters (Express identifies error middleware by its arity).
 */
export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  // 1) Zod validation errors thrown outside the validate() middleware.
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Validation failed",
      details: err.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  // 2) Known, expected application errors.
  if (err instanceof AppError) {
    if (err.isOperational) {
      logger.warn(
        { statusCode: err.statusCode, message: err.message },
        "Operational error",
      );
    } else {
      logger.error({ err }, "Non-operational AppError");
    }
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  // 3) Anything else is an unexpected bug — log full detail, hide internals.
  logger.error({ err }, "Unexpected error");
  res.status(500).json({
    error: "Internal Server Error",
    ...(env.NODE_ENV === "development" &&
      err instanceof Error && { message: err.message, stack: err.stack }),
  });
};
