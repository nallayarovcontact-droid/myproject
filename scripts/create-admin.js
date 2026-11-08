'use strict';
// Usage:  ADMIN_PASSWORD='long-random-passphrase' node scripts/create-admin.js <username> [admin|customer]
// Creates the user, or resets the password (and signs out all sessions) if it already exists.
const config = require('../src/config');
const { openDb } = require('../src/db');
const { hashPassword } = require('../src/services/passwordService');

async function main() {
  const [username, role = 'admin'] = process.argv.slice(2);
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
    throw new Error('Usage: ADMIN_PASSWORD=... node scripts/create-admin.js <username> [admin|customer]');
  }
  if (!['admin', 'customer'].includes(role)) throw new Error('role must be admin or customer');
  if (!password || password.length < 12) throw new Error('Set ADMIN_PASSWORD to at least 12 characters');

  const db = openDb(config.dbFile);
  const hash = await hashPassword(password);
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, role = ? WHERE id = ?').run(hash, role, existing.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
    console.log(`Updated ${role} "${username}" and revoked their sessions.`);
  } else {
    db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)').run(
      username,
      hash,
      role,
      Date.now()
    );
    console.log(`Created ${role} "${username}".`);
  }
  db.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
