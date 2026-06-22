const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'passwords.db');

// Bump whenever a new table or column is added below. Each version block uses
// CREATE TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN guarded by a pragma read
// so existing v0.1/v0.2 databases upgrade in place. See docs/wifi-hotspot-design.md §8.
const SCHEMA_VERSION = 3;

function initDatabase() {
  const fs = require('fs');
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(DB_PATH);

  db.pragma('journal_mode = WAL');

  // v1 — baseline (v0.1 schema).
  db.exec(`
    CREATE TABLE IF NOT EXISTS master_keys (
      id INTEGER PRIMARY KEY,
      salt BLOB NOT NULL,
      verify_hash BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS passwords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      username TEXT,
      password_encrypted BLOB NOT NULL,
      iv BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      url TEXT,
      notes TEXT,
      category TEXT DEFAULT 'default',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // v3 — paired_devices for M3' LAN pairing (TOFU on phone's X25519 pubkey).
  // fingerprint is SHA-256(pubkey) hex(64) — full digest, not truncated, so
  // the index is collision-safe even if we later display only the first 32
  // chars to users. label is what the user types in to name the phone.
  // pubkey is the raw 32B X25519 public key (the one shown to the user via
  // fingerprintHex() in secure.js/Crypto.kt).
  db.exec(`
    CREATE TABLE IF NOT EXISTS paired_devices (
      fingerprint TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      pubkey      BLOB NOT NULL,
      trusted_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Stamp version so downgrades can refuse early instead of mis-reading rows.
  const stamp = db.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)`);
  stamp.run('schema_version', String(SCHEMA_VERSION));

  return db;
}

module.exports = { initDatabase, DB_PATH, SCHEMA_VERSION };
