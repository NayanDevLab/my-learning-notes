import { pinoHttp } from "pino-http";
import { logger } from "../config/logger";

/**
 * Logs every HTTP request/response with method, url, status code, response
 * time and a per-request id. Uses the shared pino logger instance.
 */
export const requestLogger = pinoHttp({
  logger,
  // Quieten successful requests a little; elevate slow/erroring ones.
  customLogLevel(_req, res, err) {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
});
