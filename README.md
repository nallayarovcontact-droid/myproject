# BMW Parts World: secured refactor

The storefront, admin and API from the original diagram, rebuilt to fix the audit findings.
It has **zero runtime dependencies** and needs Node ≥ 22.13 (`node:sqlite` is built in).

- What was fixed and why: [`docs/SECURITY-REVIEW.md`](docs/SECURITY-REVIEW.md)
- Where the audit prompt was wrong or incomplete: [`docs/PROMPT-REVIEW.md`](docs/PROMPT-REVIEW.md)

## Quick start

```bash
cp .env.example .env            # optional; defaults work for local dev
ADMIN_PASSWORD='choose-a-long-passphrase' npm run create-admin -- admin
npm run migrate-json -- ../old-site/products.json ../old-site/uploads   # import the old catalog + photos
npm start                        # http://127.0.0.1:3000  ·  admin at /admin/
npm test                         # 15 security tests
```

Node prints an `ExperimentalWarning` for `node:sqlite`. That's expected.

## Layout

```
server.js                 start/stop only
src/app.js                wiring, global middleware, error handler
src/routes/index.js       every URL and its access rule (read this first)
src/controllers/          auth, products, static files, media
src/middleware/           auth/RBAC, headers, CORS, CSRF, rate limit, HTTPS redirect
src/services/             sessions, password hashing, image uploads
src/models/               SQL (parameterized)
src/validation/           input schemas
src/db/                   SQLite connection + migrations
public/                   storefront + login page (public)
admin-ui/                 admin UI (served only to admins at /admin/)
storage/uploads/          uploaded images (NOT web-served; via /media/:id)
data/                     app.db
scripts/                  create-admin, migrate-json
```

## API

| Method | Path | Access |
|---|---|---|
| GET | `/api/products?q=&limit=&offset=` | public |
| GET | `/api/products/:id` | public |
| POST | `/api/auth/login` · `/api/auth/logout` | public (rate-limited) |
| GET | `/api/auth/me` | public |
| GET/POST | `/api/admin/products` | admin |
| PATCH/DELETE | `/api/admin/products/:id` | admin |
| PUT | `/api/admin/products/:id/image` (raw image body) | admin |
| GET | `/media/:uuid` | public |

## Production

Run behind nginx or Caddy for TLS, with `NODE_ENV=production TRUST_PROXY=true`. Alternatively, set
`TLS_KEY_FILE` / `TLS_CERT_FILE` to let Node terminate TLS. In production the server refuses to
start without one of the two. Back up `data/` and `storage/uploads/`.

### Moving to PostgreSQL later
Only `src/db/` and `src/models/` touch SQL. Swap `node:sqlite` for `pg` there and convert the
migration. The rest of the app doesn't change.
