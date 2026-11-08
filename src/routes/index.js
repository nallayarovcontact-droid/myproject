'use strict';
const { Router } = require('../lib/router');
const { requireAdmin, requireAdminPage } = require('../middleware/auth');
const { serveDir, serveMedia } = require('../controllers/staticController');

/**
 * All routes in one place so access rules are easy to audit:
 *   /api/products/*        public, read-only
 *   /api/auth/*            login / logout / me
 *   /api/admin/*           requireAdmin on EVERY route
 *   /admin/*               admin UI files, requireAdminPage on EVERY route
 *   /media/:id             uploaded images, by random ID only
 *   everything else        public storefront files
 */
function buildRouter({ config, controllers, images }) {
  const { auth, products } = controllers;
  const r = new Router();

  // ---- public API ----
  r.get('/api/products', products.listPublic);
  r.get('/api/products/:id', products.getPublic);

  // ---- auth ----
  r.post('/api/auth/login', auth.loginLimiter, auth.login);
  r.post('/api/auth/logout', auth.logout);
  r.get('/api/auth/me', auth.me);

  // ---- admin API (role check first in every chain) ----
  r.get('/api/admin/products', requireAdmin, products.listAdmin);
  r.post('/api/admin/products', requireAdmin, products.create);
  r.patch('/api/admin/products/:id', requireAdmin, products.update);
  r.delete('/api/admin/products/:id', requireAdmin, products.remove);
  r.put('/api/admin/products/:id/image', requireAdmin, products.uploadImage);

  // Anything else under /api/admin is still checked before returning 404, so the route list is not probeable.
  r.add('*', '/api/admin/*', requireAdmin);

  // ---- admin UI (HTML/JS only reachable with an admin session) ----
  const adminFiles = serveDir(config.adminDir, { cache: 'no-store' });
  r.get('/admin/*', requireAdminPage, (req, res) => {
    if (req.pathname === '/admin') {
      res.writeHead(301, { Location: '/admin/' });
      return res.end();
    }
    return adminFiles(req, res, relPath(req));
  });

  // ---- uploaded media ----
  r.get('/media/:id', serveMedia(images));

  // ---- storefront ----
  const publicFiles = serveDir(config.publicDir);
  r.get('/*', (req, res) => publicFiles(req, res, relPath(req)));

  return r;
}

/** Wildcard part of the path, keeping a trailing slash so "dir/" maps to "dir/index.html". */
function relPath(req) {
  const w = req.params.wildcard;
  return w && req.pathname.endsWith('/') ? `${w}/` : w;
}

module.exports = { buildRouter };
