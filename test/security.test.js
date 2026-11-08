'use strict';
// Run: npm test   (uses Node's built-in test runner; no dependencies)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-test-'));
const root = path.resolve(__dirname, '..');
const config = Object.freeze({
  ...require('../src/config'),
  isProd: false,
  cookieSecure: false,
  sessionCookie: 'sid',
  dbFile: path.join(tmp, 'test.db'),
  uploadDir: path.join(tmp, 'uploads'),
  publicDir: path.join(root, 'public'),
  adminDir: path.join(root, 'admin-ui'),
  maxUploadBytes: 64 * 1024,
  allowedOrigins: ['https://partner.example'],
  loginRateLimit: { max: 5, windowMs: 60_000 },
});

const { createApp } = require('../src/app');
const { hashPassword } = require('../src/services/passwordService');

let app, server, base, origin;
let adminCookie, customerCookie;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

function request(method, urlPath, { headers = {}, body, cookie, sameOrigin = true } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    if (sameOrigin && !['GET', 'HEAD'].includes(method) && !h.Origin) h.Origin = origin;
    let payload = body;
    if (body && !Buffer.isBuffer(body) && typeof body === 'object') {
      payload = JSON.stringify(body);
      h['Content-Type'] ??= 'application/json';
    }
    if (payload) h['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request(base + urlPath, { method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json;
        try {
          json = JSON.parse(buf.toString());
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, buf, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function login(username, password) {
  const r = await request('POST', '/api/auth/login', { body: { username, password } });
  return { ...r, cookie: r.headers['set-cookie']?.[0]?.split(';')[0] };
}

before(async () => {
  app = createApp(config, { logger: { error() {} } });
  const insert = app.db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)');
  insert.run('admin', await hashPassword('correct horse battery'), 'admin', Date.now());
  insert.run('shopper', await hashPassword('shopper password 1'), 'customer', Date.now());
  server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  origin = base;
  adminCookie = (await login('admin', 'correct horse battery')).cookie;
  customerCookie = (await login('shopper', 'shopper password 1')).cookie;
});

after(() => {
  server.close();
  app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- 1. Authentication / RBAC ----------

test('admin API rejects anonymous requests (401) and non-admins (403)', async () => {
  assert.equal((await request('GET', '/api/admin/products')).status, 401);
  assert.equal((await request('GET', '/api/admin/products', { cookie: customerCookie })).status, 403);
  assert.equal((await request('POST', '/api/admin/products', { cookie: customerCookie, body: { name: 'x', price: 1 } })).status, 403);
  assert.equal((await request('GET', '/api/admin/products', { cookie: adminCookie })).status, 200);
});

test('unknown /api/admin routes are still behind the role check', async () => {
  assert.equal((await request('GET', '/api/admin/does-not-exist')).status, 401);
  assert.equal((await request('GET', '/api/admin/does-not-exist', { cookie: adminCookie })).status, 404);
});

test('admin UI files require an admin session', async () => {
  const anon = await request('GET', '/admin/');
  assert.equal(anon.status, 302);
  assert.match(anon.headers.location, /^\/login\.html/);
  assert.equal((await request('GET', '/admin/app.js')).status, 302);
  assert.equal((await request('GET', '/admin/', { cookie: customerCookie })).status, 403);
  const ok = await request('GET', '/admin/', { cookie: adminCookie });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['cache-control'], /no-store/);
});

test('session cookie is HttpOnly + SameSite=Strict and logout revokes it server-side', async () => {
  const r = await login('admin', 'correct horse battery');
  const raw = r.headers['set-cookie'][0];
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Strict/);
  assert.equal((await request('GET', '/api/admin/products', { cookie: r.cookie })).status, 200);
  await request('POST', '/api/auth/logout', { cookie: r.cookie });
  assert.equal((await request('GET', '/api/admin/products', { cookie: r.cookie })).status, 401);
});

test('wrong password gives a generic 401 and login is rate limited', async () => {
  const bad = await login('admin', 'wrong');
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error, 'Invalid username or password');
  const ghost = await login('nobody', 'wrong');
  assert.equal(ghost.json.error, bad.json.error);
  let last;
  for (let i = 0; i < 6; i++) last = await login('admin', 'wrong');
  assert.equal(last.status, 429);
});

// ---------- 2. CSRF / CORS ----------

test('state-changing requests from another site are blocked (CSRF)', async () => {
  const noOrigin = await request('POST', '/api/admin/products', { cookie: adminCookie, body: { name: 'x', price: 1 }, sameOrigin: false });
  assert.equal(noOrigin.status, 403);
  const evil = await request('POST', '/api/admin/products', {
    cookie: adminCookie,
    body: { name: 'x', price: 1 },
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(evil.status, 403);
});

test('CORS: only allow-listed origins get CORS headers', async () => {
  const evil = await request('GET', '/api/products', { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
  const partner = await request('GET', '/api/products', { headers: { Origin: 'https://partner.example' } });
  assert.equal(partner.headers['access-control-allow-origin'], 'https://partner.example');
  assert.equal((await request('OPTIONS', '/api/products', { headers: { Origin: 'https://evil.example' } })).status, 403);
});

// ---------- 3. Validation ----------

test('product input is validated and unknown fields are rejected', async () => {
  const cases = [
    { name: '', price: 10 },
    { name: 'Brake pad', price: -1 },
    { name: 'Brake pad', price: 1.234 },
    { name: 'Brake pad', price: '10' },
    { name: 'Brake pad', price: 10, id: 999 },
    { name: 'Brake pad', price: 10, image_id: '../../etc/passwd' },
    { name: 'x'.repeat(201), price: 10 },
  ];
  for (const body of cases) {
    const r = await request('POST', '/api/admin/products', { cookie: adminCookie, body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('search input is length-limited and LIKE wildcards are treated literally', async () => {
  assert.equal((await request('GET', `/api/products?q=${'a'.repeat(101)}`)).status, 400);
  assert.equal((await request('GET', '/api/products?limit=1000')).status, 400);
  const r = await request('GET', `/api/products?q=${encodeURIComponent("%' OR 1=1 --")}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 0);
});

test('CRUD works for admins and public output hides admin-only fields', async () => {
  const created = await request('POST', '/api/admin/products', {
    cookie: adminCookie,
    body: { name: 'Oil filter <script>alert(1)</script>', sku: '11-42-7-953-129', price: 12.5, stock: 3, category: 'Engine' },
  });
  assert.equal(created.status, 201);
  const id = created.json.id;
  const pub = await request('GET', `/api/products/${id}`);
  assert.equal(pub.json.price, 12.5);
  assert.equal(pub.json.stock, undefined);
  assert.equal(pub.json.inStock, true);
  const dup = await request('POST', '/api/admin/products', { cookie: adminCookie, body: { name: 'dup', sku: '11-42-7-953-129', price: 1 } });
  assert.equal(dup.status, 409);
  const upd = await request('PATCH', `/api/admin/products/${id}`, { cookie: adminCookie, body: { stock: 0 } });
  assert.equal(upd.json.stock, 0);
  assert.equal((await request('DELETE', `/api/admin/products/${id}`, { cookie: adminCookie })).status, 204);
  assert.equal((await request('GET', `/api/products/${id}`)).status, 404);
});

// ---------- 4. File uploads ----------

test('uploads: valid PNG is stored under a random name and served safely', async () => {
  const p = await request('POST', '/api/admin/products', { cookie: adminCookie, body: { name: 'Mirror', price: 80 } });
  const up = await request('PUT', `/api/admin/products/${p.json.id}/image`, {
    cookie: adminCookie,
    body: PNG,
    headers: { 'Content-Type': 'image/png' },
  });
  assert.equal(up.status, 201);
  assert.match(up.json.imageId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(fs.readdirSync(config.uploadDir), [up.json.imageId]); // no client file name, no extension
  const media = await request('GET', up.json.imageUrl);
  assert.equal(media.status, 200);
  assert.equal(media.headers['content-type'], 'image/png');
  assert.equal(media.headers['x-content-type-options'], 'nosniff');
  assert.match(media.headers['content-security-policy'], /sandbox/);
  assert.ok(media.buf.equals(PNG));
});

test('uploads: disguised, disallowed, oversized and anonymous uploads are rejected', async () => {
  const p = await request('POST', '/api/admin/products', { cookie: adminCookie, body: { name: 'Hood', price: 300 } });
  const url = `/api/admin/products/${p.json.id}/image`;
  const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  const cases = [
    [html, 'image/png', 415], // lies about its type
    [svg, 'image/svg+xml', 415], // SVG not allowed
    [Buffer.from('#!/bin/sh\nrm -rf /'), 'application/x-sh', 415],
    [Buffer.concat([PNG, Buffer.alloc(70 * 1024)]), 'image/png', 413], // over the 64 KB test limit
  ];
  for (const [body, type, status] of cases) {
    const r = await request('PUT', url, { cookie: adminCookie, body, headers: { 'Content-Type': type } });
    assert.equal(r.status, status, type);
  }
  assert.equal((await request('PUT', url, { body: PNG, headers: { 'Content-Type': 'image/png' } })).status, 401);
});

test('media and static paths cannot be used for path traversal', async () => {
  for (const p of [
    '/media/..%2f..%2fpackage.json',
    '/media/../../server.js',
    '/..%2f..%2fserver.js',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/..%2fadmin-ui%2fapp.js',
    '/..%2fdata%2ftest.db',
  ]) {
    const r = await request('GET', p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
  }
});

// ---------- 5. Headers / errors ----------

test('security headers are present on every response', async () => {
  const r = await request('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['x-powered-by'], undefined);
});

test('malformed JSON and wrong content type give clean 4xx errors', async () => {
  const bad = await request('POST', '/api/admin/products', {
    cookie: adminCookie,
    body: Buffer.from('{"name":'),
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(bad.status, 400);
  const form = await request('POST', '/api/admin/products', {
    cookie: adminCookie,
    body: Buffer.from('name=x&price=1'),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(form.status, 415);
});
