// test-m3a-db.js — exercises src/paired-devices.js against a fresh in-memory
// sqlite, so we don't touch data/passwords.db.
//
// Covers:
//   1. schema_version is stamped at 5
//   2. trustDevice inserts and findByFingerprint round-trips pubkey bytes
//   3. duplicate fingerprint throws (constraint)
//   4. listDevices orders by trusted_at DESC
//   5. touchLastSeen updates only last_seen
//   6. revoke removes the row
//   7. fingerprintHex matches the JS/Kotlin spec (64 hex, uppercase)
//   8. (M3'-B) device_hmac_key round-trips; enrollHmacKey back-fills NULL only
//   9. (M3'-B) addColumnIfMissing upgrades a v3 table in place, idempotently

'use strict';

const Database = require('better-sqlite3');
const {
  fingerprintHex, trustDevice, findByFingerprint,
  listDevices, touchLastSeen, touchChallengeAt, touchFallbackAt,
  enrollHmacKey, revoke,
} = require('../src/paired-devices');
const { SCHEMA_VERSION, addColumnIfMissing } = require('../src/db');

// Replicate db.js init against ':memory:' so each run is hermetic. Mirrors the
// v4 shape (paired_devices + the three M3'-B columns).
function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE paired_devices (
      fingerprint TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      pubkey      BLOB NOT NULL,
      trusted_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL,
      device_hmac_key   BLOB,
      device_pin_key    BLOB,
      last_challenge_at INTEGER,
      last_fallback_at  INTEGER
    );
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  db.prepare(`INSERT INTO schema_meta VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
  return db;
}

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}`); fail++; }
}

console.log('M3\'-A paired_devices repo tests:');

// 1. schema stamp
{
  const db = freshDb();
  const v = db.prepare(`SELECT value FROM schema_meta WHERE key='schema_version'`).get();
  ok('schema_version stamped at 5', v && v.value === '5');
}

// 7. fingerprintHex shape — do this first so we have a known fp for later cases.
const samplePub = Buffer.from(
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');
const expectedFp = require('crypto').createHash('sha256').update(samplePub).digest('hex').toUpperCase();
{
  const fp = fingerprintHex(samplePub);
  ok('fingerprintHex returns 64-char uppercase hex', fp.length === 64 && fp === fp.toUpperCase());
  ok('fingerprintHex matches Node crypto sha256', fp === expectedFp);
}

// 2. trust + round-trip
{
  const db = freshDb();
  const fp = fingerprintHex(samplePub);
  trustDevice(db, { fingerprint: fp, label: 'Mi 14 Pro', pubkey: samplePub, trustedAt: 1_000 });
  const row = findByFingerprint(db, fp);
  ok('trustDevice + findByFingerprint round-trip', !!row && row.label === 'Mi 14 Pro');
  ok('pubkey bytes round-trip exactly', row && Buffer.compare(row.pubkey, samplePub) === 0);
  ok('trusted_at and last_seen both stamped', row && row.trusted_at === 1_000 && row.last_seen === 1_000);
}

// 3. duplicate fingerprint → constraint
{
  const db = freshDb();
  const fp = fingerprintHex(samplePub);
  trustDevice(db, { fingerprint: fp, label: 'A', pubkey: samplePub });
  let threw = false;
  try { trustDevice(db, { fingerprint: fp, label: 'B', pubkey: samplePub }); }
  catch (e) { threw = /UNIQUE|constraint/i.test(e.message); }
  ok('duplicate fingerprint throws constraint', threw);
}

// 4. listDevices ordering
{
  const db = freshDb();
  trustDevice(db, { fingerprint: 'AA'.repeat(32), label: 'old', pubkey: samplePub, trustedAt: 100 });
  trustDevice(db, { fingerprint: 'BB'.repeat(32), label: 'new', pubkey: samplePub, trustedAt: 999 });
  const rows = listDevices(db);
  ok('listDevices returns 2 rows', rows.length === 2);
  ok('listDevices is trusted_at DESC', rows[0].label === 'new' && rows[1].label === 'old');
}

// 5. touchLastSeen
{
  const db = freshDb();
  const fp = fingerprintHex(samplePub);
  trustDevice(db, { fingerprint: fp, label: 'x', pubkey: samplePub, trustedAt: 100 });
  touchLastSeen(db, fp, 555);
  const row = findByFingerprint(db, fp);
  ok('touchLastSeen advances only last_seen', row.trusted_at === 100 && row.last_seen === 555);
}

// 6. revoke
{
  const db = freshDb();
  const fp = fingerprintHex(samplePub);
  trustDevice(db, { fingerprint: fp, label: 'x', pubkey: samplePub });
  const removed = revoke(db, fp);
  ok('revoke removes 1 row', removed === 1);
  ok('row gone after revoke', !findByFingerprint(db, fp));
  ok('revoke missing fp is a no-op', revoke(db, 'CC'.repeat(32)) === 0);
}

// 8. (M3'-B) device_hmac_key round-trip + enroll/touch helpers
{
  const db = freshDb();
  const fp = fingerprintHex(samplePub);
  const hmacKey = Buffer.alloc(32, 0xAB);

  // 8a. trustDevice carries the key when supplied
  trustDevice(db, { fingerprint: fp, label: 'with key', pubkey: samplePub, deviceHmacKey: hmacKey, trustedAt: 1 });
  let row = findByFingerprint(db, fp);
  ok('device_hmac_key persists 32 bytes', row && Buffer.compare(row.device_hmac_key, hmacKey) === 0);

  // 8b. trustDevice without a key leaves it NULL (older / no-biometrics phone)
  const fp2 = 'DD'.repeat(32);
  trustDevice(db, { fingerprint: fp2, label: 'no key', pubkey: samplePub, trustedAt: 2 });
  row = findByFingerprint(db, fp2);
  ok('omitted device_hmac_key stays NULL', row && row.device_hmac_key == null);

  // 8c. enrollHmacKey back-fills a NULL key, returns true
  const newKey = Buffer.alloc(32, 0xCD);
  ok('enrollHmacKey back-fills NULL -> true', enrollHmacKey(db, fp2, newKey) === true);
  row = findByFingerprint(db, fp2);
  ok('back-filled key matches', row && Buffer.compare(row.device_hmac_key, newKey) === 0);

  // 8d. enrollHmacKey refuses to swap an existing key (treated as attack §9)
  ok('enrollHmacKey on existing key -> false', enrollHmacKey(db, fp, Buffer.alloc(32, 0xEE)) === false);
  row = findByFingerprint(db, fp);
  ok('existing key left unchanged', row && Buffer.compare(row.device_hmac_key, hmacKey) === 0);

  // 8e. enrollHmacKey on a missing device -> false
  ok('enrollHmacKey on missing fp -> false', enrollHmacKey(db, 'EE'.repeat(32), newKey) === false);

  // 8f. touchChallengeAt / touchFallbackAt update only their own column
  touchChallengeAt(db, fp, 777);
  touchFallbackAt(db, fp, 888);
  row = findByFingerprint(db, fp);
  ok('touchChallengeAt sets last_challenge_at', row.last_challenge_at === 777);
  ok('touchFallbackAt sets last_fallback_at', row.last_fallback_at === 888);
}

// 9. (M3'-B) v3 -> v4 migration: addColumnIfMissing is idempotent
{
  const db = new Database(':memory:');
  // v3-shaped table (no M3'-B columns)
  db.exec(`
    CREATE TABLE paired_devices (
      fingerprint TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      pubkey      BLOB NOT NULL,
      trusted_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL
    );
  `);
  // Seed a v3 row so we can prove the upgrade is non-destructive.
  db.prepare(`INSERT INTO paired_devices VALUES (?,?,?,?,?)`)
    .run('FF'.repeat(32), 'legacy', samplePub, 10, 20);

  const before = db.prepare(`PRAGMA table_info(paired_devices)`).all().length;
  addColumnIfMissing(db, 'paired_devices', 'device_hmac_key', 'BLOB');
  addColumnIfMissing(db, 'paired_devices', 'last_challenge_at', 'INTEGER');
  addColumnIfMissing(db, 'paired_devices', 'last_fallback_at', 'INTEGER');
  const after = db.prepare(`PRAGMA table_info(paired_devices)`).all();

  ok('migration adds exactly 3 columns', after.length === before + 3);
  ok('migration leaves new columns NULL on v3 rows',
    (() => { const r = db.prepare(`SELECT * FROM paired_devices`).get();
             return r.device_hmac_key == null && r.last_challenge_at == null && r.last_fallback_at == null; })());
  ok('migration preserves v3 data', (() => {
    const r = db.prepare(`SELECT * FROM paired_devices`).get();
    return r.label === 'legacy' && r.trusted_at === 10 && r.last_seen === 20;
  })());

  // Idempotent: running again is a no-op (no error, no extra columns).
  let threw = false;
  try {
    addColumnIfMissing(db, 'paired_devices', 'device_hmac_key', 'BLOB');
    addColumnIfMissing(db, 'paired_devices', 'last_challenge_at', 'INTEGER');
    addColumnIfMissing(db, 'paired_devices', 'last_fallback_at', 'INTEGER');
  } catch (_) { threw = true; }
  const afterTwice = db.prepare(`PRAGMA table_info(paired_devices)`).all().length;
  ok('re-running migration does not throw', !threw);
  ok('re-running migration adds no columns', afterTwice === after.length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
