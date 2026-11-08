'use strict';
const { HttpError, readJson, sendJson, serializeCookie } = require('../lib/http');
const { validateLogin } = require('../validation/schemas');
const { verifyPassword, getDummyHash } = require('../services/passwordService');
const { rateLimiter } = require('../middleware/security');

function createAuthController({ db, sessions, audit, config }) {
  const findUser = db.prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?');
  const loginLimiter = rateLimiter({ ...config.loginRateLimit, key: (req) => `login:${req.ip}` });

  const cookie = (value, maxAgeSec) =>
    serializeCookie(config.sessionCookie, value, { maxAgeSec, secure: config.cookieSecure, sameSite: 'Strict' });

  return {
    loginLimiter,

    async login(req, res) {
      const { username, password } = validateLogin(await readJson(req, config.maxJsonBytes));
      const user = findUser.get(username);
      // Always run one scrypt verification so timing does not reveal whether the username exists.
      const ok = await verifyPassword(password, user ? user.password_hash : await getDummyHash());
      if (!user || !ok) {
        audit(req, 'login.failed', username);
        throw new HttpError(401, 'Invalid username or password');
      }
      loginLimiter.reset(req);
      if (req.sessionToken) sessions.destroy(req.sessionToken); // rotate: never reuse a pre-login session
      const token = sessions.create(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
      audit(req, 'login.success', username, user.id);
      sendJson(
        res,
        200,
        { user: { username: user.username, role: user.role } },
        { 'Set-Cookie': cookie(token, Math.floor(config.sessionTtlMs / 1000)) }
      );
    },

    logout(req, res) {
      if (req.sessionToken) sessions.destroy(req.sessionToken);
      if (req.user) audit(req, 'logout', req.user.username);
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
    },

    me(req, res) {
      sendJson(res, 200, { user: req.user ? { username: req.user.username, role: req.user.role } : null });
    },
  };
}

module.exports = { createAuthController };
