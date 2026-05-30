import dotenv from "dotenv";
import { z } from "zod";

// Load variables from a .env file into process.env (no-op in production if you
// inject env vars another way, e.g. via your container/orchestrator).
dotenv.config({ quiet: true });

/**
 * Schema for all environment variables the app needs.
 *
 * - Variables WITH `.default(...)` are optional and fall back to a safe value.
 * - Variables WITHOUT a default are REQUIRED — the app will refuse to start
 *   if they are missing. To make a variable required, simply remove its
 *   `.default()` (see the commented DATABASE_URL example below).
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  PORT: z.coerce.number().int().positive().default(3000),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  // Comma-separated list of allowed CORS origins.
  CORS_ORIGINS: z.string().default("http://localhost:3000"),

  // Rate limiting.
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  // ── Example of a REQUIRED variable (no default) ──────────────────────────
  // Uncomment to require a database URL. With this active, the app will exit
  // on startup unless DATABASE_URL is set and is a valid URL.
  // DATABASE_URL: z.url("DATABASE_URL must be a valid connection URL"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // We cannot use the pino logger here because it depends on this very config.
  // Fail loud and fail fast so misconfiguration is caught at deploy time.
  console.error("❌ Invalid or missing environment variables:\n");
  for (const issue of parsed.error.issues) {
    console.error(`  • ${issue.path.join(".")}: ${issue.message}`);
  }
  console.error("\nFix your .env file (see .env.example) and restart.\n");
  process.exit(1);
}

/** Validated, fully-typed environment config. Import this everywhere. */
export const env = parsed.data;

export type Env = typeof env;
