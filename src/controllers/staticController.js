'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('../lib/http');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', // only for your own shipped assets — never for uploads
};

/**
 * Serve files from one directory. Path traversal is blocked by resolving the final path and
 * checking it is still inside `root`. Unknown extensions and directories return 404.
 */
function serveDir(root, { cache = 'no-cache' } = {}) {
  const base = path.resolve(root);
  return (req, res, relPath) => {
    let rel = relPath === '' || relPath.endsWith('/') ? `${relPath}index.html` : relPath;
    if (rel.includes('\0')) throw new HttpError(404, 'Not found');
    const full = path.resolve(base, rel);
    if (full !== base && !full.startsWith(base + path.sep)) throw new HttpError(404, 'Not found');
    const type = TYPES[path.extname(full).toLowerCase()];
    if (!type) throw new HttpError(404, 'Not found');
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    if (!stat.isFile()) throw new HttpError(404, 'Not found');
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': cache });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  };
}

/** Uploaded images: served only by ID, with the type recorded at upload time, never executed or sniffed. */
function serveMedia(images) {
  return (req, res) => {
    const img = images.find(req.params.id);
    if (!img) throw new HttpError(404, 'Not found');
    res.writeHead(200, {
      'Content-Type': img.mime,
      'Content-Length': img.size,
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: `"${img.sha256}"`,
    });
    if (req.method === 'HEAD') return res.end();
    const stream = images.openStream(img.id);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };
}

module.exports = { serveDir, serveMedia };
