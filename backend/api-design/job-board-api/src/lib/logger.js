// src/lib/logger.js
// ---------------------------------------------------------------------------
// A tiny structured (JSON) logger — mimics Pino from your notes. Structured
// logs are searchable and machine-readable, unlike plain console.log strings.
// In production you'd use real `pino` for performance + features.
// ---------------------------------------------------------------------------
function log(level, msg, extra = {}) {
  const entry = {
    level,
    time: new Date().toISOString(),
    msg,
    ...extra,
  };
  // Pretty-print so it's readable while learning; real pino emits compact JSON.
  const color = { info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' }[level] || '';
  const reset = '\x1b[0m';
  console.log(`${color}${JSON.stringify(entry)}${reset}`);
}

module.exports = { log };
