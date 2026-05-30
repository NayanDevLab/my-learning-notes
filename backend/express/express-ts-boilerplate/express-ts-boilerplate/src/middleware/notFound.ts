import type { Request, Response, NextFunction } from "express";
import { NotFoundError } from "../utils/errors";

/**
 * Catches any request that did not match a route and forwards a 404
 * to the global error handler.
 */
export const notFound = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  next(new NotFoundError(`Route not found: ${req.method} ${req.originalUrl}`));
};
