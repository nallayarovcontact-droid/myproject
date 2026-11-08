# Security & architecture fixes

Each item from the audit, in the requested format: **Risk → Fix → Code** (with the file to open).
Every fix has a matching test in `test/security.test.js` (`npm test`, 15 tests).

---

## 1. Admin routes without authentication / authorization

**Risk.** `admin/app.js` called the upload and product routes directly. Anyone who found a URL could
create, edit or delete products or upload files. Hiding the admin page doesn't protect anything,
because the API is what has to be locked down.
(The audit calls this "Broken *Object*-Level Authorization". The accurate OWASP term is **Broken
*Function*-Level Authorization** (API5). See `PROMPT-REVIEW.md`.)

**Fix.** Sessions are stored server-side. Every route under `/api/admin/*` and every admin UI file
under `/admin/*` runs a role check *before* the handler. All routes sit in one file, so you can
audit them in a single read.

```js
// src/middleware/auth.js
function requireRole(role) {
  return (req) => {
    if (!req.user) throw new HttpError(401, 'Authentication required');
    if (req.user.role !== role) throw new HttpError(403, 'Forbidden');
  };
}

// src/routes/index.js
r.post('/api/admin/products',          requireAdmin, products.create);
r.put('/api/admin/products/:id/image', requireAdmin, products.uploadImage);
r.add('*', '/api/admin/*',             requireAdmin);          // unknown admin URLs still need a session
r.get('/admin/*',                      requireAdminPage, ...); // the admin HTML/JS itself
```

## 2. Insecure file upload

**Risk.** Storing a file under its client-supplied name allows path traversal (`../../x`) and
overwrites. Accepting any type lets someone upload HTML or SVG and serve it from your domain,
which is **stored XSS** that steals admin sessions. No size limit means someone can fill the disk.

**Fix** (`src/services/imageService.js`, `src/controllers/productController.js`):
1. Allow only JPEG, PNG and WebP. The declared `Content-Type` is checked **and** the real type is
   read from the file's magic bytes. SVG is refused.
2. A 5 MB limit is enforced while streaming, so a 413 comes back before the body is fully read.
3. The file name is a server-generated `crypto.randomUUID()` with no extension. Nothing from the
   client ends up on disk. Files are written with `flag: 'wx'` (no overwrite) and mode `0640`.
4. Files are stored in `storage/uploads/`, **outside** `public/`. They are served only through
   `GET /media/:uuid`, using the MIME type recorded in the database plus `nosniff` and a
   `sandbox` CSP.

```js
const ALLOWED = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png':  (b) => b.subarray(0, 8).equals(PNG_SIGNATURE),
  'image/webp': (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};
if (sniff(buf) !== declared) throw new HttpError(415, 'File content does not match an allowed image type');
const id = crypto.randomUUID();
await fsp.writeFile(path.resolve(uploadDir, id), buf, { flag: 'wx', mode: 0o640 });
```

Optional next step: re-encode uploads with `sharp`. That strips EXIF and GPS data and neutralises
polyglot files.

## 3. HTTP instead of HTTPS, cookie flags

**Risk.** Over plain HTTP, session cookies and admin passwords travel in clear text.

**Fix** (`server.js`, `src/middleware/security.js`). There are two supported modes:
- **Recommended:** nginx or Caddy terminates TLS, and Node listens on `127.0.0.1` with
  `TRUST_PROXY=true`. Plain-HTTP requests get a 308 redirect to HTTPS.
- Node terminates TLS itself with `TLS_KEY_FILE` / `TLS_CERT_FILE` (TLS 1.2 minimum).

In production the server **refuses to start** if neither is configured. Cookies are `HttpOnly`,
`SameSite=Strict` and `Secure`, with the `__Host-` prefix. HSTS is sent once Secure cookies are on.

```js
serializeCookie('__Host-sid', token, { secure: true, httpOnly: true, sameSite: 'Strict', maxAgeSec: 8 * 3600 });
```

## 4. `products.json` as the database

**Risk.** Two admins saving at the same moment can lose writes or leave a half-written, corrupt
file. Every request reads the whole catalog, and there are no constraints, such as stopping a
negative price.

**Fix.** SQLite, built into Node 22 as `node:sqlite`, with WAL mode, transactions, `CHECK` and
`UNIQUE` constraints, and versioned migrations (`src/db/index.js`). All SQL is parameterized, and
data access lives only in `src/models/`. Moving to PostgreSQL later means changing that folder
only.
`scripts/migrate-json.js` imports the old file and photos in one transaction and runs every record
through the same validation as the API.

## 5. Session storage

**Risk.** In-memory sessions disappear on restart and can't be revoked.

**Fix** (`src/services/sessionStore.js`). Sessions live in the `sessions` table. The table stores
only a **SHA-256 of the token**, so a leaked backup can't be replayed. Each session has an
absolute expiry, a fresh token is issued on every login (stops session fixation), logout deletes
it server-side, and a password reset revokes all of that user's sessions. Redis is only worth
adding once you run several app instances.

## 6. Monolithic `server.js`

**Fix.** `server.js` is now about 50 lines: config, start, shutdown. Everything else is split:

```
src/
  app.js            composition root + global middleware + error handler
  config.js         all settings from env vars
  routes/           every URL → middleware chain → controller (one file, easy to audit)
  controllers/      auth, products, static/media
  middleware/       auth (session, RBAC), security (headers, CORS, CSRF, rate limit, HTTPS)
  services/         sessions, passwords (scrypt), images
  models/           SQL only
  validation/       input schemas
  db/               connection + migrations
```

## 7. Input validation and XSS / injection

**Risk.** Unvalidated input gets stored and later executed in someone else's browser (XSS), or
breaks queries.

**Fix.** Each threat gets its own control:
- **XSS → output encoding + CSP.** Both UIs render data with `textContent`, never `innerHTML`. The
  CSP is `script-src 'self'` and there are no inline scripts, so even a stored payload can't run.
  You can see this in the admin screenshot test: `<img src=x onerror=…>` shows as text.
- **SQL injection → parameterized queries.** Search `LIKE` wildcards are escaped.
- **Validation → integrity** (`src/validation/schemas.js`). This covers types, lengths, ranges, a
  SKU format, a maximum of two decimals in prices, and rejected control characters. **Unknown
  fields are rejected**, so a request can't set `id` or `image_id` (mass assignment).

No `express-validator` or `zod` is used, because this app doesn't use Express (see the prompt
review). If you move to Express, `zod` is a direct swap for `schemas.js`.

## 8. Public vs admin API separation

**Fix.** The public API is read-only: `GET /api/products`, `GET /api/products/:id`. It returns a
reduced shape with `inStock` instead of the stock count and no internal IDs. Every write lives
under `/api/admin/*`.
I didn't rename the public routes to `/api/public/*`. That would break existing storefront links
and adds no security.

## 9. CORS, plus the item the audit missed: CSRF

**CORS fix.** The default is deny. The storefront and admin share the API's origin, so they need
**no** CORS headers. Only origins listed in `ALLOWED_ORIGINS` get them. Preflights from anyone else
get a 403.

**CSRF (missing from both audits).** CORS doesn't stop a malicious site from auto-submitting a
form to `/api/admin/products/7` with DELETE-like effects, because the browser attaches the session
cookie. The fix here is that every state-changing request must carry
`Sec-Fetch-Site: same-origin` or a matching `Origin`. `SameSite=Strict` cookies are a second layer.

## 10. Also added (not in the audit)

| Area | What |
|---|---|
| Passwords | scrypt (N=2¹⁶), per-user salt, constant-time compare, and a dummy hash for unknown users so timing doesn't reveal valid usernames |
| Brute force | 5 failed logins per IP per 15 min → 429 (in-memory; use Redis for several instances) |
| Headers | CSP, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, COOP/CORP, no `X-Powered-By` |
| Errors | Clients get a generic 500 with a request ID; stack traces and SQL errors only go to the server log |
| Audit trail | `audit_log` table records logins, failed logins and every admin write, with user and IP |
| Slow clients | header, request and keep-alive timeouts |
| Open redirect | the login `?next=` only accepts same-site paths |

## Not covered

- Customer accounts, cart and checkout. None were in the diagram. Payment handling needs its own
  review (use a hosted payment page so card data never touches your server).
- Backups of `data/app.db` and `storage/uploads/`.
- Dependency scanning. Not needed today because there are zero runtime dependencies, but run
  `npm audit` in CI once you add any.
- MFA for admin accounts.
