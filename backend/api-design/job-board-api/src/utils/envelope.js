// src/utils/envelope.js
// ---------------------------------------------------------------------------
// Consistent response envelope — see your "REST API Design" notes.
// EVERY response has the same shape: { data, error, meta }. The client writes
// ONE response handler instead of guessing each endpoint's structure.
// ---------------------------------------------------------------------------
function ok(res, status, data, meta = null) {
  return res.status(status).json({ data, error: null, meta });
}

function fail(res, status, code, message) {
  return res.status(status).json({
    data: null,
    error: { code, message },
    meta: null,
  });
}

module.exports = { ok, fail };
