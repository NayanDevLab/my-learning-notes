// src/lib/storage.js
// ---------------------------------------------------------------------------
// A LOCAL-FILE mock of AWS S3 so you can practise file uploads with no AWS
// account. See your "File Uploads + AWS S3" notes for the real version.
//
// 🎓 LEARNING NOTE: In production `uploadResume()` would call the AWS SDK
// (PutObjectCommand) or hand the client a pre-signed URL. Here it just writes
// the file to the ./uploads folder and returns a URL-like path. The IMPORTANT
// patterns are still demonstrated:
//   1. Validate the file by its MAGIC BYTES, not its extension.
//   2. Generate a UUID filename — never trust the user's filename.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

// Ensure the uploads directory exists.
fs.mkdirSync(config.uploadsDir, { recursive: true });

// PDF files start with the bytes "%PDF" => 0x25 0x50 0x44 0x46.
// This is the "magic bytes" check — far more reliable than trusting ".pdf".
function isPdf(buffer) {
  return (
    buffer.length > 4 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46
  );
}

function uploadResume(buffer) {
  // Generate our own UUID filename (prevents path traversal + collisions).
  const filename = `${crypto.randomUUID()}.pdf`;
  const filepath = path.join(config.uploadsDir, filename);
  fs.writeFileSync(filepath, buffer);
  // Return a URL-like string (in real S3 this would be an https bucket URL).
  return `/uploads/${filename}`;
}

module.exports = { isPdf, uploadResume };
