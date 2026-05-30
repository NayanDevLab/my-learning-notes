import { Router } from "express";
import healthRoute from "./health.route";
import exampleRoute from "./example.route";

const router = Router();

// Health check (kept at top level for load balancers / uptime monitors).
router.use("/health", healthRoute);

// Versioned API routes.
router.use("/api/v1/examples", exampleRoute);

export default router;
