'use strict';
const crypto = require('node:crypto');

// Sessions live in the database, so they survive restarts and can be revoked.
// Only a SHA-256 of the token is stored: a leaked DB backup does not hand out live sessions.
// For several app instances behind a load balancer, keep this table in the shared DB (Postgres)
// or move it to Redis — the interface below stays the same.

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSessionStore(db, { ttlMs }) {
  const stmts = {
    insert: db.prepare(
      'INSERT INTO sessions (token_hash, user_id, expires_at, created_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    lookup: db.prepare(
      `SELECT s.user_id, s.expires_at, u.username, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`
    ),
    remove: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    removeForUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  };

  return {
    /** Always issues a brand-new token (prevents session fixation). Returns the raw token for the cookie. */
    create(userId, { ip, userAgent }) {
      const token = crypto.randomBytes(32).toString('base64url');
      const now = Date.now();
      stmts.insert.run(sha256(token), userId, now + ttlMs, now, ip ?? null, (userAgent || '').slice(0, 256));
      return token;
    },
    get(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
      const hash = sha256(token);
      const row = stmts.lookup.get(hash);
      if (!row) return null;
      if (row.expires_at <= Date.now()) {
        stmts.remove.run(hash);
        return null;
      }
      return { userId: row.user_id, username: row.username, role: row.role };
    },
    destroy(token) {
      if (typeof token === 'string') stmts.remove.run(sha256(token));
    },
    destroyAllForUser(userId) {
      stmts.removeForUser.run(userId);
    },
    purgeExpired() {
      return stmts.purge.run(Date.now()).changes;
    },
  };
}

module.exports = { createSessionStore };
