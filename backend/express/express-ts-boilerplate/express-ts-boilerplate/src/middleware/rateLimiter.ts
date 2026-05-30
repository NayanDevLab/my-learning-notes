import { rateLimit } from "express-rate-limit";
import { env } from "../config/env";

/**
 * Global per-IP rate limiter. Returns HTTP 429 when the limit is exceeded.
 *
 * For sensitive routes (e.g. login), create a stricter limiter inline:
 *   const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 5 });
 *   router.post("/login", authLimiter, handler);
 *
 * To limit per authenticated user instead of per IP, add a keyGenerator:
 *   keyGenerator: (req) => req.user?.id ?? req.ip
 */
export const rateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  standardHeaders: "draft-8", // modern combined RateLimit header
  legacyHeaders: false, // drop old X-RateLimit-* headers
  message: { error: "Too many requests, please try again later." },
});
