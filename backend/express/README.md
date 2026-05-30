# Express + TypeScript Production Boilerplate

A clean, opinionated starting point for every Node.js API. Batteries included:
**TypeScript (strict)**, structured logging, request validation, security
headers, CORS allowlist, rate limiting, a global error handler with custom
error classes, environment validation that fails fast, and a health check.

---

## ✨ Features

- **TypeScript** in strict mode with a modern `tsconfig.json`.
- **Structured logging** with [pino](https://getpino.io) — pretty in dev, JSON in prod.
- **Request validation** with [Zod](https://zod.dev) via reusable middleware.
- **Global error handling** with custom error classes (`AppError`, `NotFoundError`, ...).
- **Async wrapper** so rejected promises always reach the error handler.
- **Security**: [helmet](https://helmetjs.github.io) headers + [CORS](https://github.com/expressjs/cors) allowlist + [rate limiting](https://github.com/express-rate-limit/express-rate-limit).
- **Env validation**: the app refuses to start if config is missing/invalid.
- **Health check** at `GET /health` for load balancers and uptime monitors.
- **Graceful shutdown** on `SIGINT` / `SIGTERM` plus crash safety nets.

---

## 📁 Folder Structure

```
src/
├── config/          # env validation, logger, cors options
│   ├── env.ts
│   ├── logger.ts
│   └── cors.ts
├── controllers/     # request handlers (thin — call services)
│   ├── health.controller.ts
│   └── example.controller.ts
├── middleware/      # cross-cutting middleware
│   ├── validate.ts
│   ├── rateLimiter.ts
│   ├── requestLogger.ts
│   ├── notFound.ts
│   └── errorHandler.ts
├── routes/          # route definitions, mounted in index.ts
│   ├── index.ts
│   ├── health.route.ts
│   └── example.route.ts
├── services/        # business logic / data access
│   ├── health.service.ts
│   └── example.service.ts
├── utils/           # shared helpers
│   ├── asyncHandler.ts
│   └── errors.ts
├── app.ts           # builds the Express app (middleware order lives here)
└── server.ts        # entry point: starts server + graceful shutdown
```

**The request flow:** `route → validate() → asyncHandler(controller) → service`,
with errors funneling to a single error handler.

---

## 🚀 Getting Started

### 1. Prerequisites
- Node.js **18+** (developed on Node 22).

### 2. Install
```bash
npm install
```

### 3. Configure environment
```bash
cp .env.example .env
# edit .env as needed
```

### 4. Run in development (hot reload)
```bash
npm run dev
```

### 5. Build & run in production
```bash
npm run build
npm start
```

The server starts on `http://localhost:3000` (configurable via `PORT`).

---

## 📜 Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start with hot reload (`tsx watch`). |
| `npm run build` | Clean `dist/` and compile TypeScript. |
| `npm start` | Run the compiled app from `dist/`. |
| `npm run typecheck` | Type-check without emitting files. |
| `npm run clean` | Remove the `dist/` folder. |

---

## ⚙️ Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | no | `development` | `development` \| `production` \| `test` |
| `PORT` | no | `3000` | Port to listen on |
| `LOG_LEVEL` | no | `info` | pino level (`fatal`..`trace`, `silent`) |
| `CORS_ORIGINS` | no | `http://localhost:3000` | Comma-separated allowed origins |
| `RATE_LIMIT_WINDOW_MS` | no | `60000` | Rate limit window (ms) |
| `RATE_LIMIT_MAX` | no | `100` | Max requests per window per IP |

> **Making a variable required:** remove its `.default()` in
> `src/config/env.ts`. Missing/invalid values cause the app to print a clear
> message and **exit on startup** — see the commented `DATABASE_URL` example.

---

## 🧪 Try It

```bash
# Health check
curl http://localhost:3000/health

# Create (valid) — returns 201
curl -X POST http://localhost:3000/api/v1/examples \
  -H "Content-Type: application/json" \
  -d '{"name":"Nayan","email":"nayan@example.com"}'

# Create (invalid) — returns 400 with structured field errors
curl -X POST http://localhost:3000/api/v1/examples \
  -H "Content-Type: application/json" \
  -d '{"email":"bad"}'

# Inspect security headers (note: no X-Powered-By)
curl -I http://localhost:3000/health
```

---

## 🧩 Adding a New Resource

1. **Service** — `src/services/<name>.service.ts` (business logic / DB).
2. **Controller** — `src/controllers/<name>.controller.ts` (thin handlers).
3. **Route** — `src/routes/<name>.route.ts` (define a Zod schema, wire
   `validate()` + `asyncHandler()`).
4. **Mount it** — add `router.use("/api/v1/<name>", <name>Route)` in
   `src/routes/index.ts`.

Use the included `example` resource as a template.

---

## 🛡️ Notes for Production

- Behind a proxy (Nginx, AWS ELB, Heroku), `trust proxy` is already set so the
  real client IP is used for rate limiting and logs.
- Tighten the helmet **Content-Security-Policy** to your app's needs in
  `src/app.ts`.
- Keep the **CORS allowlist** strict — never use `*` with credentials.
- Swap the in-memory `example.service` store for a real database.
- Add a Redis store to `express-rate-limit` if you run multiple instances.

---

## 📤 Push to GitHub

```bash
git init
git add .
git commit -m "chore: initial commit — express + typescript boilerplate"
git branch -M main

# Create an empty repo on GitHub first, then:
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

> ✅ `.gitignore` already excludes `node_modules/`, `dist/`, and `.env`.
> Never commit your real `.env` — only `.env.example` is tracked.

**Tip:** to reuse this for every project, push it once and click
*"Use this template"* on GitHub (Settings → Template repository), or simply
`git clone` and re-init git.

---

## 📄 License

MIT — use it freely.
