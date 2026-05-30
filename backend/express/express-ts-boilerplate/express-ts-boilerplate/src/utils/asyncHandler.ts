import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Wraps an async route handler so that any thrown error or rejected promise
 * is automatically forwarded to Express's error-handling middleware via next().
 *
 * Usage:
 *   router.get("/", asyncHandler(async (req, res) => { ... }));
 *
 * Note: Express 5 forwards async rejections natively, but this wrapper keeps
 * handlers explicit, works identically on Express 4, and documents intent.
 */
export const asyncHandler =
  (
    fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
  ): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
