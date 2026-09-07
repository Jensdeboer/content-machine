'use strict';
// multipart/form-data, built in memory. Both callers post a handful of
// slide-sized jpgs and nothing larger, so a Buffer is the whole story: no
// streaming, and no dependency for a format that is twenty lines.
//
// Parts are either { name, value } or { name, filename, contentType, data }.
const crypto = require('crypto');
const path = require('path');

function build(parts) {
  const boundary = `----content-machine-${crypto.randomBytes(12).toString('hex')}`;
  const chunks = [];
  for (const p of parts) {
    const head = p.filename === undefined
      ? `Content-Disposition: form-data; name="${p.name}"\r\n\r\n`
      : `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n`
        + `Content-Type: ${p.contentType || 'application/octet-stream'}\r\n\r\n`;
    chunks.push(Buffer.from(`--${boundary}\r\n${head}`));
    chunks.push(p.filename === undefined ? Buffer.from(String(p.value)) : p.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(chunks) };
}

const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const contentTypeFor = (file) => TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';

module.exports = { build, contentTypeFor };
