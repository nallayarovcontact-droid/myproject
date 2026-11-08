'use strict';
/**
 * BMW Parts World — Node.js server (zero dependencies, Node 18+).
 *
 *  - Serves the storefront (/) and admin panel (/admin) from ./public
 *  - REST API for products, stored in data/products.json
 *  - Product photos saved to data/uploads/
 *  - Password-protected admin (HttpOnly session cookie)
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------- Config ----------
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'products.json');
const MAX_BODY_BYTES = 2.5 * 1024 * 1024; // JSON body incl. base64 image
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SECURE_COOKIE = process.env.NODE_ENV === 'production';
const CATEGORIES = ['Engine', 'Exterior', 'Interior', 'Wheels', 'Lighting', 'Brakes', 'Accessories'];

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
  console.warn(`\n[!] ADMIN_PASSWORD not set. Temporary admin password for this run: ${ADMIN_PASSWORD}\n`);
}

const SAMPLE = [
  { id: 's1', name: 'Sport Grille', category: 'Exterior', price: 189, models: '3 Series, M3', stock: 8, description: 'Demo listing. Confirm the correct OEM part number before purchase.', image: '' },
  { id: 's2', name: 'Performance Brake Rotor', category: 'Brakes', price: 249, models: 'M3, M4', stock: 4, description: 'Example product; fitment not verified.', image: '' },
  { id: 's3', name: 'LED Headlight Assembly', category: 'Lighting', price: 699, models: '5 Series', stock: 2, description: 'Example product; fitment not verified.', image: '' },
  { id: 's4', name: 'Alloy Wheel', category: 'Wheels', price: 479, models: 'X3, X5', stock: 6, description: 'Example product; fitment not verified.', image: '' },
  { id: 's5', name: 'Interior Trim Set', category: 'Interior', price: 129, models: '4 Series', stock: 10, description: 'Example product; fitment not verified.', image: '' },
  { id: 's6', name: 'Oil Filter Kit', category: 'Engine', price: 39, models: 'Various models', stock: 20, description: 'Example product; fitment not verified.', image: '' },
];

// ---------- Storage ----------
let products = [];
let writeQueue = Promise.resolve();

function loadProducts() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    products = Array.isArray(parsed) ? parsed : [...SAMPLE];
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read products.json, starting with sample data:', err.message);
    products = [...SAMPLE];
    fs.writeFileSync(DB_FILE, JSON.stringify(products, null, 2));
  }
}

// Serialised, atomic writes (write temp file, then rename).
function saveProducts() {
  const snapshot = JSON.stringify(products, null, 2);
  writeQueue = writeQueue.then(async () => {
    const tmp = DB_FILE + '.tmp';
    await fsp.writeFile(tmp, snapshot);
    await fsp.rename(tmp, DB_FILE);
  });
  return writeQueue;
}

// ---------- Images ----------
function detectImage(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

async function saveImage(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw httpError(400, 'Picture must be a PNG, JPEG or WebP image.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_IMAGE_BYTES) throw httpError(400, 'Please choose an image smaller than 1.5 MB.');
  const ext = detectImage(buf);
  if (!ext) throw httpError(400, 'File is not a valid PNG, JPEG or WebP image.');
  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  await fsp.writeFile(path.join(UPLOAD_DIR, name), buf);
  return `/uploads/${name}`;
}

async function deleteImage(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  const file = path.join(UPLOAD_DIR, path.basename(url));
  await fsp.unlink(file).catch(() => {});
}

// ---------- Validation ----------
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function cleanText(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function validateProduct(body) {
  const name = cleanText(body.name, 90);
  const price = Number(body.price);
  const stock = Number(body.stock);
  const category = body.category;
  if (!name) throw httpError(400, 'Product name is required.');
  if (!Number.isFinite(price) || price < 0 || price > 1_000_000) throw httpError(400, 'Price must be between 0 and 1,000,000.');
  if (!Number.isInteger(stock) || stock < 0 || stock > 100_000) throw httpError(400, 'Stock must be a whole number between 0 and 100,000.');
  if (!CATEGORIES.includes(category)) throw httpError(400, 'Unknown category.');
  return {
    name,
    price: Math.round(price * 100) / 100,
    category,
    models: cleanText(body.models, 200),
    stock,
    description: cleanText(body.description, 2000),
  };
}

// ---------- Sessions & auth ----------
const sessions = new Map(); // token -> expiry timestamp
const loginAttempts = new Map(); // ip -> { count, resetAt }

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const token = parseCookies(req).sid;
  const exp = token && sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}

function sessionCookie(token, maxAgeSec) {
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${SECURE_COOKIE ? '; Secure' : ''}`;
}

function passwordMatches(input) {
  const a = crypto.createHash('sha256').update(String(input)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function tooManyAttempts(ip) {
  const now = Date.now();
  let rec = loginAttempts.get(ip);
  if (!rec || rec.resetAt < now) { rec = { count: 0, resetAt: now + 15 * 60 * 1000 }; loginAttempts.set(ip, rec); }
  rec.count++;
  return rec.count > 10;
}

setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
  for (const [ip, rec] of loginAttempts) if (rec.resetAt < now) loginAttempts.delete(ip);
}, 10 * 60 * 1000).unref();

// ---------- HTTP helpers ----------
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
};

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) {
      return reject(httpError(415, 'Expected application/json.'));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(httpError(413, 'Request is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(httpError(400, 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

async function serveFile(res, baseDir, relPath, cacheControl = 'no-cache') {
  const filePath = path.resolve(baseDir, '.' + path.posix.normalize('/' + relPath));
  if (!filePath.startsWith(baseDir + path.sep)) return notFound(res);
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return notFound(res);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cacheControl,
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    notFound(res);
  }
}

function notFound(res) {
  res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

// ---------- API ----------
async function handleApi(req, res, pathname) {
  const method = req.method;

  if (pathname === '/api/products' && method === 'GET') {
    return sendJson(res, 200, products);
  }

  if (pathname === '/api/session' && method === 'GET') {
    return sendJson(res, 200, { authenticated: isAuthed(req) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (tooManyAttempts(ip)) return sendJson(res, 429, { error: 'Too many login attempts. Try again in 15 minutes.' });
    const body = await readJson(req);
    if (!passwordMatches(body.password || '')) return sendJson(res, 401, { error: 'Wrong password.' });
    loginAttempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    return sendJson(res, 200, { authenticated: true }, { 'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000) });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const token = parseCookies(req).sid;
    if (token) sessions.delete(token);
    return sendJson(res, 200, { authenticated: false }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  // ----- Admin-only product routes -----
  const match = /^\/api\/products(?:\/([A-Za-z0-9_-]+))?$/.exec(pathname);
  if (match && ['POST', 'PUT', 'DELETE'].includes(method)) {
    if (!isAuthed(req)) return sendJson(res, 401, { error: 'Please log in as admin.' });
    const id = match[1];

    if (method === 'POST' && !id) {
      const body = await readJson(req);
      const fields = validateProduct(body);
      const image = body.imageData ? await saveImage(body.imageData) : '';
      const product = { id: 'p' + Date.now() + crypto.randomBytes(3).toString('hex'), ...fields, image };
      products.unshift(product);
      await saveProducts();
      return sendJson(res, 201, product);
    }

    if (method === 'PUT' && id) {
      const index = products.findIndex((p) => p.id === id);
      if (index === -1) return sendJson(res, 404, { error: 'Product not found.' });
      const body = await readJson(req);
      const fields = validateProduct(body);
      const old = products[index];
      let image = old.image || '';
      if (body.imageData) {
        image = await saveImage(body.imageData);
        await deleteImage(old.image);
      } else if (body.removeImage) {
        await deleteImage(old.image);
        image = '';
      }
      products[index] = { ...old, ...fields, image };
      await saveProducts();
      return sendJson(res, 200, products[index]);
    }

    if (method === 'DELETE' && id) {
      const product = products.find((p) => p.id === id);
      if (!product) return sendJson(res, 404, { error: 'Product not found.' });
      products = products.filter((p) => p.id !== id);
      await saveProducts();
      await deleteImage(product.image);
      return sendJson(res, 200, { ok: true });
    }
  }

  return sendJson(res, 404, { error: 'Not found.' });
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return notFound(res);
  }

  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
    if (pathname.startsWith('/uploads/')) {
      return await serveFile(res, UPLOAD_DIR, pathname.slice('/uploads/'.length), 'public, max-age=31536000, immutable');
    }
    if (pathname === '/' || pathname === '/admin' || pathname === '/admin/') {
      return await serveFile(res, PUBLIC_DIR, 'index.html');
    }
    return await serveFile(res, PUBLIC_DIR, pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Server error.' : err.message });
    else res.destroy();
  }
});

loadProducts();
server.listen(PORT, HOST, () => {
  console.log(`BMW Parts World running at http://localhost:${PORT}  (admin: http://localhost:${PORT}/admin)`);
});
