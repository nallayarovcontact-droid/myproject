'use strict';
const crypto = require('node:crypto');
const { openDb } = require('./db');
const { HttpError, sendJson } = require('./lib/http');
const { runChain } = require('./lib/router');
const { securityHeaders, httpsRedirect, cors, csrfGuard, clientIp } = require('./middleware/security');
const { loadSession } = require('./middleware/auth');
const { createSessionStore } = require('./services/sessionStore');
const { createImageService } = require('./services/imageService');
const { createProductModel } = require('./models/productModel');
const { createAuthController } = require('./controllers/authController');
const { createProductController } = require('./controllers/productController');
const { buildRouter } = require('./routes');

/**
 * Composition root: wires DB → models/services → controllers → routes.
 * Returns the request handler plus the pieces scripts and tests need.
 */
function createApp(config, { logger = console } = {}) {
  const db = openDb(config.dbFile);
  const sessions = createSessionStore(db, { ttlMs: config.sessionTtlMs });
  const images = createImageService(db, { uploadDir: config.uploadDir });
  const products = createProductModel(db);

  const auditStmt = db.prepare('INSERT INTO audit_log (user_id, action, target, ip, at) VALUES (?, ?, ?, ?, ?)');
  const audit = (req, action, target, userId) =>
    auditStmt.run(userId ?? req.user?.userId ?? null, action, target ?? null, req.ip ?? null, Date.now());

  const deps = { config, db, sessions, images, products, audit };
  const controllers = {
    auth: createAuthController(deps),
    products: createProductController(deps),
  };
  const router = buildRouter({ config, controllers, images });

  // Runs on every request, in this order.
  const global = [securityHeaders(config), httpsRedirect(config), cors(config), loadSession(deps), csrfGuard(config)];

  const purgeTimer = setInterval(() => sessions.purgeExpired(), 15 * 60 * 1000);
  purgeTimer.unref();

  async function handle(req, res) {
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);
    try {
      const url = new URL(req.url, 'http://localhost');
      req.pathname = url.pathname;
      req.query = url.searchParams;
      req.ip = clientIp(req, config.trustProxy);

      await runChain(global, req, res);
      if (res.writableEnded) return;

      const match = router.match(req.method, req.pathname);
      if (!match) throw new HttpError(404, 'Not found');
      if (match.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
      req.params = match.params;
      await runChain(match.handlers, req, res);
      if (!res.writableEnded && !res.headersSent) throw new HttpError(404, 'Not found');
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message, ...(err.details && { details: err.details }) });
      } else {
        // Log the detail server-side; never send stack traces or SQL errors to the client.
        logger.error(`[${requestId}] ${req.method} ${req.url}`, err);
        sendJson(res, 500, { error: 'Internal server error', requestId });
      }
    }
  }

  return {
    handle,
    db,
    close() {
      clearInterval(purgeTimer);
      db.close();
    },
  };
}

module.exports = { createApp };
