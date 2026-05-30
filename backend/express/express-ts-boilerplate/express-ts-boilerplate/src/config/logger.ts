import pino, { type LoggerOptions } from "pino";
import { env } from "./env";

const isDev = env.NODE_ENV === "development";

const options: LoggerOptions = {
  level: env.LOG_LEVEL,
  // In development, pretty-print colored logs for readability.
  // In production, emit raw JSON (one object per line) so log aggregators
  // (Datadog, Loki, CloudWatch, ELK, ...) can index and query them.
  ...(isDev && {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    },
  }),
  // Never log these fields if they ever appear in an object.
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "password", "token"],
    censor: "[REDACTED]",
  },
};

export const logger = pino(options);
