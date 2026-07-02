// test-m3a-routes.js — exercise the /api/lan/devices/* HTTP routes against an
// in-memory sqlite, without touching data/passwords.db.
//
// We don't pull in supertest (not in package.json); we just app.listen() on
// port 0 and use Node's global fetch (Node 18+).

'use strict';

const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { installLanDeviceRoutes } = require('../src/lan-device-routes');

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
  `);
  return db;
}

function fingerprintHex(pub) {
  return crypto.createHash('sha256').update(pub).digest('hex').toUpperCase();
}

function makeDevice(seed = 1) {
  const pubkey = Buffer.from(new Array(32).fill(seed).map((v, i) => (v + i) & 0xff));
  return { pubkey, fingerprint: fingerprintHex(pubkey) };
}

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else      { fail++; console.log('  ✗ ' + name); }
}

async function main() {
  const db = freshDb();
  const app = express();
  app.use(express.json());
  installLanDeviceRoutes(app, db);

  const srv = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;

  console.log('M3\'-A /api/lan/devices/* route tests:');

  const dev1 = makeDevice(0x10);
  const dev2 = makeDevice(0x20);

  // ---- POST /trust happy path ----
  let r = await fetch(`${base}/api/lan/devices/trust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fingerprint: dev1.fingerprint,
      pubkey_b64: dev1.pubkey.toString('base64'),
      label: 'My Mi 14 Pro',
    }),
  });
  let body = await r.json();
  ok('POST /trust returns 200', r.status === 200);
  ok('  ok=true', body.ok === true);
  ok('  status=trusted', body.status === 'trusted');
  ok('  label echoed back', body.label === 'My Mi 14 Pro');

  // ---- POST /trust idempotent (already_trusted) ----
  r = await fetch(`${base}/api/lan/devices/trust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fingerprint: dev1.fingerprint,
      pubkey_b64: dev1.pubkey.toString('base64'),
      label: 'renamed but ignored',
    }),
  });
  body = await r.json();
  ok('POST /trust same device -> 200', r.status === 200);
  ok('  status=already_trusted', body.status === 'already_trusted');
  ok('  label preserved from first trust', body.label === 'My Mi 14 Pro');

  // ---- POST /trust fingerprint mismatch ----
  r = await fetch(`${base}/api/lan/devices/trust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fingerprint: dev2.fingerprint,                // dev2 fingerprint
      pubkey_b64: dev1.pubkey.toString('base64'),   // but dev1 pubkey
      label: 'attacker',
    }),
  });
  body = await r.json();
  ok('POST /trust fingerprint!=hash(pubkey) -> 400', r.status === 400);
  ok('  error=fingerprint_mismatch', body.error === 'fingerprint_mismatch');

  // ---- POST /trust bad fingerprint format ----
  r = await fetch(`${base}/api/lan/devices/trust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fingerprint: 'not-hex',
      pubkey_b64: dev2.pubkey.toString('base64'),
      label: 'x',
    }),
  });
  body = await r.json();
  ok('POST /trust malformed fingerprint -> 400', r.status === 400);
  ok('  error=bad_fingerprint', body.error === 'bad_fingerprint');

  // ---- POST /trust bad pubkey ----
  r = await fetch(`${base}/api/lan/devices/trust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fingerprint: dev2.fingerprint,
      pubkey_b64: 'AAAA',  // 3 bytes -> not 32
      label: 'x',
    }),
  });
  body = await r.json();
  ok('POST /trust pubkey wrong length -> 400', r.status === 400);
  ok('  error=bad_pubkey', body.error === 'bad_pubkey');

  // ---- POST /trust empty label falls back to default ----
  r = await fetch(`${base}/api/lan/devices/trust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fingerprint: dev2.fingerprint,
      pubkey_b64: dev2.pubkey.toString('base64'),
      label: '',
    }),
  });
  body = await r.json();
  ok('POST /trust empty label -> 200', r.status === 200);
  ok('  default label applied', body.label === 'Unnamed device');

  // ---- (M3'-B) dev1 was trusted without a key -> stored NULL ----
  {
    const row = db.prepare(`SELECT device_hmac_key FROM paired_devices WHERE fingerprint=?`).get(dev1.fingerprint);
    ok('device trusted without key -> device_hmac_key NULL', row && row.device_hmac_key == null);
  }

  // ---- (M3'-B) POST /trust with a valid 32B device_hmac_key_b64 ----
  const dev3 = makeDevice(0x30);
  const hmacKey = Buffer.alloc(32, 0x5a);
  r = await fetch(`${base}/api/lan/devices/trust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fingerprint: dev3.fingerprint,
      pubkey_b64: dev3.pubkey.toString('base64'),
      label: 'Pixel 8',
      device_hmac_key_b64: hmacKey.toString('base64'),
    }),
  });
  body = await r.json();
  ok('POST /trust with hmac key -> 200 trusted', r.status === 200 && body.status === 'trusted');
  {
    const row = db.prepare(`SELECT device_hmac_key FROM paired_devices WHERE fingerprint=?`).get(dev3.fingerprint);
    ok('  device_hmac_key persisted 32 bytes', row && Buffer.compare(row.device_hmac_key, hmacKey) === 0);
  }

  // ---- (M3'-B) malformed device_hmac_key_b64 (wrong length) -> 400 ----
  const dev4 = makeDevice(0x40);
  r = await fetch(`${base}/api/lan/devices/trust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fingerprint: dev4.fingerprint,
      pubkey_b64: dev4.pubkey.toString('base64'),
      label: 'bad key',
      device_hmac_key_b64: Buffer.alloc(16).toString('base64'),  // 16B != 32B
    }),
  });
  body = await r.json();
  ok('POST /trust malformed hmac key -> 400', r.status === 400);
  ok('  error=bad_hmac_key', body.error === 'bad_hmac_key');
  ok('  malformed-key device was NOT persisted',
    !db.prepare(`SELECT 1 FROM paired_devices WHERE fingerprint=?`).get(dev4.fingerprint));

  // ---- (M3'-B) re-trust dev1 WITH a key back-fills the NULL ----
  const backfillKey = Buffer.alloc(32, 0x77);
  r = await fetch(`${base}/api/lan/devices/trust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fingerprint: dev1.fingerprint,
      pubkey_b64: dev1.pubkey.toString('base64'),
      label: 'ignored on re-trust',
      device_hmac_key_b64: backfillKey.toString('base64'),
    }),
  });
  body = await r.json();
  ok('re-trust dev1 with key -> already_trusted', r.status === 200 && body.status === 'already_trusted');
  {
    const row = db.prepare(`SELECT device_hmac_key FROM paired_devices WHERE fingerprint=?`).get(dev1.fingerprint);
    ok('  NULL key back-filled on re-trust', row && Buffer.compare(row.device_hmac_key, backfillKey) === 0);
  }

  // ---- (M3'-B) GET /devices surfaces has_hmac_key without leaking bytes ----
  r = await fetch(`${base}/api/lan/devices`);
  body = await r.json();
  {
    const d3 = body.devices.find((d) => d.fingerprint === dev3.fingerprint);
    ok('GET /devices: keyed device reports has_hmac_key=true', d3 && d3.has_hmac_key === true);
    ok('  no device_hmac_key bytes leaked', body.devices.every((d) => d.device_hmac_key === undefined));
  }

  // ---- GET /devices lists all trusted ----
  r = await fetch(`${base}/api/lan/devices`);
  body = await r.json();
  ok('GET /devices -> 200', r.status === 200);
  ok('  returns 3 devices', body.devices.length === 3);
  ok('  no pubkey leaked in list', body.devices.every((d) => d.pubkey === undefined));

  // ---- DELETE /devices/:fp removes ----
  r = await fetch(`${base}/api/lan/devices/${dev1.fingerprint}`, { method: 'DELETE' });
  body = await r.json();
  ok('DELETE /devices/:fp -> 200', r.status === 200);
  ok('  removed=1', body.removed === 1);

  r = await fetch(`${base}/api/lan/devices`);
  body = await r.json();
  ok('after DELETE, GET shows 2 devices', body.devices.length === 2);
  ok('  dev1 is gone', body.devices.every((d) => d.fingerprint !== dev1.fingerprint));

  // ---- DELETE missing fp is a no-op ----
  r = await fetch(`${base}/api/lan/devices/${dev1.fingerprint}`, { method: 'DELETE' });
  body = await r.json();
  ok('DELETE missing -> 200 removed=0', r.status === 200 && body.removed === 0);

  // ---- DELETE bad fingerprint format -> 400 ----
  r = await fetch(`${base}/api/lan/devices/not-hex`, { method: 'DELETE' });
  body = await r.json();
  ok('DELETE bad-format -> 400', r.status === 400);

  await new Promise((res) => srv.close(res));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
