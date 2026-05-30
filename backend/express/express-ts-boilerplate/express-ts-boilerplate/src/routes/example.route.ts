import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate";
import { asyncHandler } from "../utils/asyncHandler";
import { createExample, getExample } from "../controllers/example.controller";

const router = Router();

// Zod schema (Zod v4 syntax). On Zod v3 use z.string().email() instead.
const createExampleSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.email("Invalid email address"),
});

// POST /api/v1/examples  -> validated body, then handler
router.post(
  "/",
  validate({ body: createExampleSchema }),
  asyncHandler(createExample),
);

// GET /api/v1/examples/:id  -> may throw NotFoundError
router.get("/:id", asyncHandler(getExample));

export default router;
