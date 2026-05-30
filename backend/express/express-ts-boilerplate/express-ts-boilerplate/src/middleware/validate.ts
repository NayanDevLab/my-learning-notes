import type { Request, Response, NextFunction } from "express";
import type { ZodType } from "zod";

interface ValidationSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Validates request body / query / params against Zod schemas.
 * On failure, responds 400 with a structured list of field errors.
 *
 * Only `req.body` is reassigned with the parsed (coerced, defaulted) data,
 * because `req.query` and `req.params` are read-only getters in Express 5.
 */
export const validate =
  (schemas: ValidationSchemas) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const targets = ["body", "query", "params"] as const;

    for (const target of targets) {
      const schema = schemas[target];
      if (!schema) continue;

      const result = schema.safeParse(req[target]);

      if (!result.success) {
        res.status(400).json({
          error: "Validation failed",
          target,
          details: result.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        });
        return;
      }

      if (target === "body") {
        req.body = result.data;
      }
    }

    next();
  };
