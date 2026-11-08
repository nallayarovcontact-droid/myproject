'use strict';
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

function bool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return v === 'true' || v === '1';
}

const cookieSecure = bool(process.env.COOKIE_SECURE, isProd);

module.exports = Object.freeze({
  env,
  isProd,
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '127.0.0.1',
  // Only trust X-Forwarded-* when a reverse proxy (nginx, Caddy, a load balancer) sits in front.
  trustProxy: bool(process.env.TRUST_PROXY, false),
  tls: {
    keyFile: process.env.TLS_KEY_FILE || '',
    certFile: process.env.TLS_CERT_FILE || '',
  },
  // Extra origins allowed to call the API cross-origin. Empty = same-origin only (recommended).
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  dbFile: process.env.DB_FILE || path.join(root, 'data', 'app.db'),
  // Outside every directory that is served statically.
  uploadDir: process.env.UPLOAD_DIR || path.join(root, 'storage', 'uploads'),
  publicDir: path.join(root, 'public'),
  adminDir: path.join(root, 'admin-ui'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 5 * 1024 * 1024),
  maxJsonBytes: 100 * 1024,
  sessionTtlMs: Number(process.env.SESSION_TTL_HOURS || 8) * 3600 * 1000,
  cookieSecure,
  // __Host- prefix forces Secure, Path=/ and no Domain — only usable over HTTPS.
  sessionCookie: cookieSecure ? '__Host-sid' : 'sid',
  loginRateLimit: { max: Number(process.env.LOGIN_MAX_ATTEMPTS || 5), windowMs: 15 * 60 * 1000 },
});
