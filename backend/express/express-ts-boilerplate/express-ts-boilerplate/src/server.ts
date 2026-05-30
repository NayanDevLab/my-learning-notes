import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./config/logger";

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(
    `🚀 Server running at http://localhost:${env.PORT} (${env.NODE_ENV})`,
  );
});

/** Gracefully drain in-flight requests, then exit. */
const shutdown = (signal: string): void => {
  logger.info(`${signal} received — shutting down gracefully...`);
  server.close(() => {
    logger.info("HTTP server closed. Bye 👋");
    process.exit(0);
  });

  // Safety net: force-exit if shutdown hangs.
  setTimeout(() => {
    logger.error("Could not close connections in time — forcing shutdown.");
    process.exit(1);
  }, 10_000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Last-resort safety nets. Prefer fixing the root cause over relying on these.
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception — exiting");
  process.exit(1);
});
