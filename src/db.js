const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'passwords.db');

// Bump whenever a new table or column is added below. Each version block uses
// CREATE TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN guarded by a pragma read
// so existing v0.1/v0.2 databases upgrade in place. See docs/wifi-hotspot-design.md §8.
const SCHEMA_VERSION = 5;

// Add `column` (with `decl`, e.g. "BLOB" / "INTEGER") to `table` only if it is
// not already present. better-sqlite3 has no "ADD COLUMN IF NOT EXISTS", so we
// read PRAGMA table_info and skip the ALTER when the column exists. This keeps
// initDatabase() idempotent across restarts and lets a v3 db upgrade in place.
function addColumnIfMissing(db, table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

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

  // v4 — M3'-B biometric CHALLENGE/RESPONSE. Each paired phone gets a
  // persistent HMAC key (the phone is the TEE owner and generates it; we
  // receive it once inside the encrypted PAIR_OK frame). The two timestamps
  // are bookkeeping for the challenge UI / fallback lockout.
  //   device_hmac_key   — 32B raw, NULL for v3 rows until they re-ENROLL (§9)
  //   last_challenge_at  — unix ms of the most recent successful CHALLENGE
  //   last_fallback_at   — unix ms of the most recent 4-digit-PIN fallback
  // See docs/m3b-biometric-challenge-design.md §8.
  addColumnIfMissing(db, 'paired_devices', 'device_hmac_key', 'BLOB');
  addColumnIfMissing(db, 'paired_devices', 'last_challenge_at', 'INTEGER');
  addColumnIfMissing(db, 'paired_devices', 'last_fallback_at', 'INTEGER');

  // v5 — M3'-B fallback hardening (design §7 "方案 C"). The 4-digit-PIN path
  // gets its OWN key, separate from the bio-gated device_hmac_key:
  //   device_pin_key — 32B raw HMAC key for the NON-biometric fallback. The
  //                    phone keeps this in EncryptedSharedPreferences (no bio
  //                    gate) and hands it to us once in PAIR_OK; device_hmac_key
  //                    stays Keystore-only on the phone (never copied to ESP).
  // The PC decides biometric-vs-fallback by WHICH key verifies the RESPONSE,
  // not by trusting the phone's biometric_ok flag — so a controlled phone can't
  // claim a biometric pass it didn't make. NULL until the phone enrolls one.
  // See docs/m3b-biometric-challenge-design.md §7/§8.
  addColumnIfMissing(db, 'paired_devices', 'device_pin_key', 'BLOB');

  // Stamp version so downgrades can refuse early instead of mis-reading rows.
  const stamp = db.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)`);
  stamp.run('schema_version', String(SCHEMA_VERSION));

  return db;
}

module.exports = { initDatabase, DB_PATH, SCHEMA_VERSION, addColumnIfMissing };
