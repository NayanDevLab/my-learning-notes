import type { CorsOptions } from "cors";
import { env } from "./env";

const allowedOrigins = env.CORS_ORIGINS.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // Requests with no Origin header (curl, mobile apps, server-to-server)
    // are allowed. Browser requests must come from an allowlisted origin.
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  credentials: true, // allow cookies / Authorization header
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
};
