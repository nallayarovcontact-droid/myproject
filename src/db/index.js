'use strict';
const fs = require('node:fs');
const path = require('node:path');
// node:sqlite ships with Node >= 22.5 (no flag needed from 22.13). Swap for `pg` when you move to PostgreSQL;
// the models only use parameterized SQL, so the change is contained in /models.
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  `CREATE TABLE users (
     id            INTEGER PRIMARY KEY,
     username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
     password_hash TEXT    NOT NULL,
     role          TEXT    NOT NULL CHECK (role IN ('admin', 'customer')),
     created_at    INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     token_hash  TEXT    PRIMARY KEY,           -- SHA-256 of the cookie value, never the raw token
     user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at  INTEGER NOT NULL,
     created_at  INTEGER NOT NULL,
     ip          TEXT,
     user_agent  TEXT
   );
   CREATE INDEX sessions_expires ON sessions(expires_at);
   CREATE TABLE images (
     id         TEXT    PRIMARY KEY,            -- random UUID, also the file name on disk
     mime       TEXT    NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
     size       INTEGER NOT NULL,
     sha256     TEXT    NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE products (
     id          INTEGER PRIMARY KEY,
     sku         TEXT    UNIQUE,
     name        TEXT    NOT NULL,
     description TEXT    NOT NULL DEFAULT '',
     category    TEXT    NOT NULL DEFAULT '',
     price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
     stock       INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
     image_id    TEXT    REFERENCES images(id) ON DELETE SET NULL,
     created_at  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL
   );
   CREATE INDEX products_name ON products(name);
   CREATE TABLE audit_log (
     id       INTEGER PRIMARY KEY,
     user_id  INTEGER,
     action   TEXT NOT NULL,
     target   TEXT,
     ip       TEXT,
     at       INTEGER NOT NULL
   );`,
];

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Run fn inside BEGIN IMMEDIATE / COMMIT; roll back on any error. */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, transaction };
