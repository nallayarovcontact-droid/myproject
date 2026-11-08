'use strict';
const { HttpError } = require('../lib/http');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function isHttps(req, trustProxy) {
  if (req.socket.encrypted) return true;
  return trustProxy && req.headers['x-forwarded-proto'] === 'https';
}

function selfOrigin(req, trustProxy) {
  const host = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
  return host ? `${isHttps(req, trustProxy) ? 'https' : 'http'}://${host}` : null;
}

/** Headers applied to every response. */
function securityHeaders(config) {
  return (req, res) => {
    res.setHeader(
      'Content-Security-Policy',
      // No inline script anywhere in the UI, so script-src 'self' is enough to block injected scripts.
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.cookieSecure) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    res.removeHeader('X-Powered-By');
  };
}

/** In production, bounce plain-HTTP requests (as seen through a proxy) to HTTPS. */
function httpsRedirect(config) {
  return (req, res) => {
    if (!config.isProd || isHttps(req, config.trustProxy)) return;
    const host = req.headers.host;
    if (!host) throw new HttpError(400, 'Missing Host header');
    res.writeHead(308, { Location: `https://${host}${req.url}` });
    res.end();
  };
}

/**
 * CORS: deny by default. The storefront and admin are served from the same origin as the API,
 * so no CORS headers are needed at all. Only origins listed in ALLOWED_ORIGINS get them.
 */
function cors(config) {
  const allowed = new Set(config.allowedOrigins);
  return (req, res) => {
    const origin = req.headers.origin;
    const ok = origin && allowed.has(origin);
    if (ok) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (!ok) throw new HttpError(403, 'Origin not allowed');
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      });
      res.end();
    }
  };
}

/**
 * CSRF protection for cookie-authenticated requests. CORS does NOT stop CSRF — a cross-site
 * <form> POST is sent without any CORS check. So every state-changing request must prove it came
 * from our own pages: browsers set Sec-Fetch-Site / Origin and pages cannot forge them.
 * (SameSite=Strict on the cookie is the second layer.)
 */
function csrfGuard(config) {
  const allowed = new Set(config.allowedOrigins);
  return (req) => {
    if (SAFE_METHODS.has(req.method)) return;
    const site = req.headers['sec-fetch-site'];
    if (site === 'same-origin') return;
    const origin = req.headers.origin;
    if (origin && (origin === selfOrigin(req, config.trustProxy) || allowed.has(origin))) return;
    throw new HttpError(403, 'Cross-site request blocked');
  };
}

/** Fixed-window in-memory limiter. Fine for one instance; use Redis for several. */
function rateLimiter({ max, windowMs, key }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();

  const limiter = (req, res) => {
    const k = key(req);
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(k, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.reset - now) / 1000));
      throw new HttpError(429, 'Too many attempts, try again later');
    }
  };
  limiter.reset = (req) => hits.delete(key(req));
  return limiter;
}

module.exports = { securityHeaders, httpsRedirect, cors, csrfGuard, rateLimiter, clientIp, isHttps };
