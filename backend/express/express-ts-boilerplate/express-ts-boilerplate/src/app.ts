import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";

import { corsOptions } from "./config/cors";
import { rateLimiter } from "./middleware/rateLimiter";
import { requestLogger } from "./middleware/requestLogger";
import { notFound } from "./middleware/notFound";
import { errorHandler } from "./middleware/errorHandler";
import routes from "./routes";

/**
 * Builds and configures the Express application.
 *
 * Middleware ORDER matters:
 *   helmet -> cors -> rate limit -> body parser -> logger
 *   -> routes -> 404 -> error handler (last)
 */
export const createApp = (): Express => {
  const app = express();

  // Trust the first proxy hop (Nginx, ELB, Heroku, ...) so req.ip and the
  // rate limiter see the real client IP from X-Forwarded-For.
  app.set("trust proxy", 1);

  // 1. Security headers first — applied to every response.
  app.use(helmet());

  // 2. CORS — reject disallowed origins early.
  app.use(cors(corsOptions));

  // 3. Rate limiting — block abuse before doing expensive work.
  app.use(rateLimiter);

  // 4. Body parsing (with a sane size limit).
  app.use(express.json({ limit: "10kb" }));
  app.use(express.urlencoded({ extended: true, limit: "10kb" }));

  // 5. Structured request logging.
  app.use(requestLogger);

  // 6. Application routes.
  app.use(routes);

  // 7. Unmatched routes -> 404.
  app.use(notFound);

  // 8. Centralized error handler (must be last).
  app.use(errorHandler);

  return app;
};
