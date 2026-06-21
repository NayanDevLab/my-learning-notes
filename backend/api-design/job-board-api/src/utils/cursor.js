// src/utils/cursor.js
// ---------------------------------------------------------------------------
// Cursor (keyset) pagination helpers — see your "Pagination Patterns" notes.
// The cursor is an OPAQUE base64 token holding the last row's sort key
// (created_at + id as a tiebreaker). The client just echoes it back; it never
// sees or constructs internal ids.
// ---------------------------------------------------------------------------
function encodeCursor(item) {
  const payload = { createdAt: item.created_at, id: item.id };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function decodeCursor(cursor) {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
  } catch {
    return null; // malformed cursor → treat as no cursor
  }
}

module.exports = { encodeCursor, decodeCursor };
