// test-m3a-db.js — exercises src/paired-devices.js against a fresh in-memory
// sqlite, so we don't touch data/passwords.db.
//
// Covers:
//   1. schema_version is stamped at 3
//   2. trustDevice inserts and findByFingerprint round-trips pubkey bytes
//   3. duplicate fingerprint throws (constraint)
//   4. listDevices orders by trusted_at DESC
//   5. touchLastSeen updates only last_seen
//   6. revoke removes the row
//   7. fingerprintHex matches the JS/Kotlin spec (64 hex, uppercase)

'use strict';

const Database = require('better-sqlite3');
const {
  fingerprintHex, trustDevice, findByFingerprint,
  listDevices, touchLastSeen, revoke,
} = require('../src/paired-devices');
const { SCHEMA_VERSION } = require('../src/db');

// Replicate db.js init against ':memory:' so each run is hermetic.
function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE paired_devices (
      fingerprint TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      pubkey      BLOB NOT NULL,
      trusted_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL
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
  ok('schema_version stamped at 3', v && v.value === '3');
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
