'use strict';
const { HttpError, parseCookies, redirect } = require('../lib/http');

/** Attach req.user (or null) from the session cookie. Runs on every request. */
function loadSession({ sessions, config }) {
  return (req) => {
    const token = parseCookies(req.headers.cookie)[config.sessionCookie];
    req.sessionToken = token || null;
    req.user = token ? sessions.get(token) : null;
  };
}

function requireAuth(req) {
  if (!req.user) throw new HttpError(401, 'Authentication required');
}

/**
 * Role check, enforced on the server for every admin API call and every admin page.
 * Hiding buttons in the UI is not access control; this is.
 */
function requireRole(role) {
  return (req) => {
    if (!req.user) throw new HttpError(401, 'Authentication required');
    if (req.user.role !== role) throw new HttpError(403, 'Forbidden');
  };
}

/** Same check for HTML pages: send unauthenticated visitors to the login page instead of a JSON error. */
function requireAdminPage(req, res) {
  if (!req.user) return redirect(res, `/login.html?next=${encodeURIComponent('/admin/')}`);
  if (req.user.role !== 'admin') throw new HttpError(403, 'Forbidden');
}

module.exports = { loadSession, requireAuth, requireRole, requireAdmin: requireRole('admin'), requireAdminPage };
