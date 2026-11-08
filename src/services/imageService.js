'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { HttpError } = require('../lib/http');

// Whitelist. SVG is deliberately excluded: it is XML that can carry <script>, so serving it from
// your origin is a stored-XSS vector. GIF/BMP/TIFF are excluded simply because the catalog does not need them.
const ALLOWED = {
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Identify the real type from the file's first bytes — the client's Content-Type and file name are not trusted. */
function sniff(buf) {
  for (const [mime, test] of Object.entries(ALLOWED)) if (test(buf)) return mime;
  return null;
}

function createImageService(db, { uploadDir }) {
  fs.mkdirSync(uploadDir, { recursive: true, mode: 0o750 });
  const stmts = {
    insert: db.prepare('INSERT INTO images (id, mime, size, sha256, created_at) VALUES (?, ?, ?, ?, ?)'),
    get: db.prepare('SELECT id, mime, size, sha256 FROM images WHERE id = ?'),
    remove: db.prepare('DELETE FROM images WHERE id = ?'),
  };

  // The stored file name is our UUID — never anything from the client — so `../../etc/passwd` style
  // names have nothing to attach to. The resolve() check is defence in depth.
  function filePath(id) {
    if (!UUID_RE.test(id)) throw new HttpError(404, 'Not found');
    const p = path.resolve(uploadDir, id);
    if (path.dirname(p) !== path.resolve(uploadDir)) throw new HttpError(404, 'Not found');
    return p;
  }

  return {
    /**
     * @param {Buffer} buf           body, already size-limited by the caller
     * @param {string} declaredType  the request Content-Type
     */
    async save(buf, declaredType) {
      const declared = (declaredType || '').split(';')[0].trim().toLowerCase();
      if (!(declared in ALLOWED)) {
        throw new HttpError(415, 'Only JPEG, PNG and WebP images are accepted');
      }
      if (buf.length === 0) throw new HttpError(400, 'Empty file');
      const actual = sniff(buf);
      if (actual !== declared) {
        throw new HttpError(415, 'File content does not match an allowed image type');
      }
      // Optional hardening: re-encode with `sharp` here (strips EXIF/GPS metadata and neutralises
      // polyglot files). Left out to keep this project dependency-free.
      const id = crypto.randomUUID();
      const target = filePath(id);
      // 'wx' = fail if the file exists; 0o640 = not executable, not world-readable.
      await fsp.writeFile(target, buf, { flag: 'wx', mode: 0o640 });
      try {
        stmts.insert.run(id, actual, buf.length, crypto.createHash('sha256').update(buf).digest('hex'), Date.now());
      } catch (err) {
        await fsp.rm(target, { force: true });
        throw err;
      }
      return { id, mime: actual, size: buf.length };
    },

    find(id) {
      if (!UUID_RE.test(id)) return null;
      return stmts.get.get(id) || null;
    },

    openStream(id) {
      return fs.createReadStream(filePath(id));
    },

    async remove(id) {
      if (!id || !UUID_RE.test(id)) return;
      stmts.remove.run(id);
      await fsp.rm(filePath(id), { force: true });
    },
  };
}

module.exports = { createImageService, sniff };
