# Review of the audit prompt

Most of the audit is right: the four big problems (no admin auth, unsafe uploads, JSON-file
storage, one giant `server.js`) are real and are the right priorities. These are the places where
I disagree or where it would mislead whoever (or whatever model) follows it.

## Where I disagree

1. **"Broken Object-Level Authorization" is the wrong name.** BOLA (OWASP API1) means a logged-in
   user can reach *someone else's* object by changing an ID, for example `/orders/123` → `/orders/124`.
   Your flaw is that admin *functions* have no role check at all, which is **Broken Function-Level
   Authorization** (API5) or, more broadly, Broken Access Control (A01). The name matters, because
   a fix aimed at BOLA (ownership checks per object) would not close the hole you actually have.

2. **"Prevent RCE / so users cannot execute uploaded scripts" overstates the upload risk on Node.**
   Node doesn't execute files it serves the way PHP does, so an uploaded `.js` or `.php` won't run.
   The real risk is **stored XSS**: someone uploads HTML or SVG, it's served from your domain, and
   it steals the admin's session. RCE only becomes possible if you later pass uploads to a vulnerable
   image library, which is why re-encoding with `sharp` is listed as an optional step. Storing files
   outside the web root is still correct, but `nosniff`, a fixed `Content-Type` and banning SVG are
   what actually close the hole.

3. **"Input sanitization prevents XSS" points at the wrong control.** XSS is fixed at **output**:
   render with `textContent` (or a templating engine that escapes) and add a CSP. Injection is fixed
   by **parameterized queries**. Input validation is about data quality. "Sanitizing" input (stripping
   `<`, `>` and so on) mangles real data, such as a part described as `<5mm`, and is easy to bypass.

4. **CORS is treated as a security control, and CSRF is missing completely.** CORS only controls
   which other sites can *read* your API's responses. It does nothing to stop another site from
   *sending* a cookie-authenticated POST or DELETE to your admin API. That attack is CSRF, and with
   cookie sessions it's one of the most important things to fix. Neither audit mentions it. Since
   your storefront and admin are same-origin, the correct CORS setting is simply "none".

5. **It assumes Express, but your diagram shows a plain Node `http` server.** `express-validator`
   and `multer`-style advice only works after migrating to Express, and the prompt never says
   whether that migration is wanted. I kept it framework-free (zero dependencies, same
   `node:http` base) so the change stays a refactor rather than a rewrite. Express is fine if you
   prefer it, but that should be a deliberate decision.

6. **Redis for sessions and Postgres or MongoDB for storage are oversized for this app.** A single-server
   parts catalog is well served by SQLite: it's ACID, has no extra server to run, and is built into
   Node 22. Redis is only worth it once you run several app instances. Also, MongoDB is a strange
   pick if ACID is the stated reason, and your other project already standardises on PostgreSQL.

7. **"`/api/public/*`" renames working routes for no security gain.** What matters is that admin
   routes are grouped and guarded. Moving public routes just breaks existing links.

## What's missing from the prompt

- **The code itself.** Both audits are based on a *diagram*, so any answer to this prompt is a
  generic template, not a fix for your app. Attach `server.js`, `products.json` (a few records),
  and both `app.js` files.
- **Password storage and login brute-force protection.** If there's an admin login, how are
  passwords hashed?
- **Security headers** (CSP above all), **error handling** (no stack traces to clients), and **audit logging**.
- **Data migration.** Moving from `products.json` to a database needs a migration path for the
  existing products and photos.
- **How to verify.** Ask for tests that prove each fix, not only code snippets.

## Problems with the prompt's structure

- **Two overlapping prompts pasted together.** Admin auth, uploads, the database and the monolith
  each appear twice with slightly different wording, so the model has to guess which version wins.
- **The output format works against the goal.** "Risk / Fix / Snippet" for twelve items produces
  twelve disconnected snippets that don't fit together, and you still have to integrate them. For a
  refactor, ask for working code plus a short per-issue explanation.
- **"Act as an expert…" adds little.** Concrete context (stack, Node version, deployment, single or
  multiple servers, who the admins are) improves the answer far more than a role does.

## Improved prompt

```
I have a Node.js (v22, plain `http` module, no framework) parts-catalog site:
- Storefront: public/index.html + app.js (product list + search)
- Admin: admin/index.html + app.js (create/edit/delete products, upload photos)
- server.js does routing, API, uploads, validation and sessions in one file
- Products are stored in products.json, photos in an uploads/ folder
- Runs on one server; 1–3 admins; no customer accounts or payments yet.

Attached: server.js, admin/app.js, public/app.js, and 5 sample records from products.json.

Refactor it to be production-safe. Keep it framework-free unless you think a framework is clearly
worth it — if so, say why first. Specifically:
1. Server-side admin authentication + role checks on every admin API route and admin page.
2. Safe image uploads (type whitelist checked by magic bytes, size limit, random names,
   stored outside the web root, served with safe headers).
3. HTTPS-ready config, secure session cookies, CSRF protection, strict CORS.
4. Replace products.json with a real database (SQLite is fine) and give me a migration script
   for the existing data and photos.
5. Split server.js into routes / controllers / middleware / services / models.
6. Input validation, output encoding and a CSP for XSS, parameterized queries.

Deliver: the full refactored project, automated tests that prove each fix, and a short note per
item explaining the risk and what changed. Point out anything in this request you think is wrong.
```
