// paired-devices.js — repository for the M3' TOFU-paired phone list.
//
// The DB schema (see db.js) keeps one row per trusted phone:
//   fingerprint  TEXT PK      SHA-256 hex(64) of the X25519 pubkey
//   label        TEXT         user-typed name ("My Mi 14 Pro")
//   pubkey       BLOB(32)     raw X25519 pubkey, used to verify subsequent
//                             handshakes against the stored fingerprint
//   trusted_at   INTEGER      unix ms when the user first confirmed pairing
//   last_seen    INTEGER      unix ms of most recent successful handshake
//
// This module intentionally exposes prepared-statement-shaped helpers rather
// than ORM-style objects: callers pass in the open `db` handle from
// `initDatabase()` so we don't keep a second connection.

'use strict';

const crypto = require('crypto');

/**
 * Compute SHA-256(pubkey) and return uppercase hex (64 chars). This is the
 * PK in the paired_devices table and the value users compare across devices
 * when confirming a TOFU pairing.
 *
 * Mirror of `fingerprintHex` in src/public/js/secure.js and Crypto.kt.
 */
function fingerprintHex(pubBytes) {
  const buf = Buffer.isBuffer(pubBytes) ? pubBytes : Buffer.from(pubBytes);
  return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
}

/**
 * Insert a new trusted device. Throws SqliteError(constraint) if the
 * fingerprint already exists — the caller decides whether to update label /
 * last_seen via touchLastSeen() instead.
 */
function trustDevice(db, { fingerprint, label, pubkey, trustedAt = Date.now() }) {
  const stmt = db.prepare(`
    INSERT INTO paired_devices (fingerprint, label, pubkey, trusted_at, last_seen)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(fingerprint, label, Buffer.from(pubkey), trustedAt, trustedAt);
}

/** Returns the row for a fingerprint, or undefined. */
function findByFingerprint(db, fingerprint) {
  return db.prepare(`SELECT * FROM paired_devices WHERE fingerprint = ?`).get(fingerprint);
}

/** Returns all paired devices, newest-trusted first. */
function listDevices(db) {
  return db.prepare(`SELECT * FROM paired_devices ORDER BY trusted_at DESC`).all();
}

/** Bump last_seen on a successful handshake. No-op if the row is missing. */
function touchLastSeen(db, fingerprint, now = Date.now()) {
  db.prepare(`UPDATE paired_devices SET last_seen = ? WHERE fingerprint = ?`)
    .run(now, fingerprint);
}

/** Untrust (user-revoke). Returns number of rows removed (0 or 1). */
function revoke(db, fingerprint) {
  return db.prepare(`DELETE FROM paired_devices WHERE fingerprint = ?`)
    .run(fingerprint).changes;
}

module.exports = {
  fingerprintHex,
  trustDevice,
  findByFingerprint,
  listDevices,
  touchLastSeen,
  revoke,
};
