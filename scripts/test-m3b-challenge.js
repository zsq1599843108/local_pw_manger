// test-m3b-challenge.js — unit + route tests for the M3'-B PC-side biometric
// CHALLENGE/RESPONSE verifier (src/lan-challenge.js + lan-challenge-routes.js).
//
// No supertest: we drive the ChallengeVerifier directly with an injected clock
// for the freshness/replay paths, then smoke-test the HTTP routes against an
// app.listen(0) + global fetch (Node 18+), mirroring test-m3a-routes.js.
//
// The "phone" is simulated by signing the canonical AAD with the device's HMAC
// key via the same buildChallengeAad/computeChallengeHmac the production
// verifier uses — so a passing test proves PC<->phone byte agreement.

'use strict';

const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const {
  buildChallengeAad, computeChallengeHmac, createChallenge, ChallengeVerifier,
} = require('../src/lan-challenge');
const pairedDevices = require('../src/paired-devices');
const { installLanDeviceRoutes } = require('../src/lan-device-routes');
const { installLanChallengeRoutes } = require('../src/lan-challenge-routes');

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
      last_challenge_at INTEGER,
      last_fallback_at  INTEGER
    );
  `);
  return db;
}

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else      { fail++; console.log('  ✗ ' + name); }
}

// Insert a paired device with a known HMAC key; return its descriptor.
function seedDevice(db, { seed = 1, withKey = true } = {}) {
  const pubkey = Buffer.from(Array.from({ length: 32 }, (_, i) => (seed + i) & 0xff));
  const fingerprint = pairedDevices.fingerprintHex(pubkey);
  const key = withKey ? Buffer.from(Array.from({ length: 32 }, (_, i) => (seed * 3 + i) & 0xff)) : null;
  pairedDevices.trustDevice(db, {
    fingerprint, label: 'Test phone', pubkey, deviceHmacKey: key, trustedAt: 1_000_000,
  });
  return { pubkey, fingerprint, key };
}

// Simulate the phone signing a registered challenge → a RESPONSE envelope.
function phoneSign({ id, nonce, purpose, key, fingerprint, ts, biometricOk = true }) {
  const aad = buildChallengeAad({
    id, nonce, purpose, tsMs: ts, fingerprintRaw: Buffer.from(fingerprint, 'hex'),
  });
  const hmac = computeChallengeHmac(key, aad);
  return { t: 'RESPONSE', id, hmac_b64: hmac.toString('base64'), ts, biometric_ok: biometricOk };
}

function unitTests() {
  console.log('M3\'-B ChallengeVerifier unit tests:');

  // ---- happy path ----
  {
    const db = freshDb();
    const dev = seedDevice(db, { seed: 0x10 });
    let clock = 1_700_000_000_000;
    const v = new ChallengeVerifier({ db, now: () => clock });
    const ch = createChallenge({ purpose: 'unlock', now: () => clock });
    v.register({ id: ch.id, fingerprint: dev.fingerprint, nonce: ch.nonce, purpose: 'unlock', createdAt: clock });
    const resp = phoneSign({ id: ch.id, nonce: ch.nonce, purpose: 'unlock', key: dev.key, fingerprint: dev.fingerprint, ts: clock });
    const r = v.verify(resp);
    ok('happy path verifies', r.ok && r.purpose === 'unlock' && r.biometricOk === true);
    const row = pairedDevices.findByFingerprint(db, dev.fingerprint);
    ok('happy path stamps last_challenge_at', row.last_challenge_at === clock && row.last_fallback_at == null);
  }

  // ---- bad HMAC ----
  {
    const db = freshDb();
    const dev = seedDevice(db, { seed: 0x20 });
    const clock = 1_700_000_000_000;
    const v = new ChallengeVerifier({ db, now: () => clock });
    const ch = createChallenge({ purpose: 'unlock', now: () => clock });
    v.register({ id: ch.id, fingerprint: dev.fingerprint, nonce: ch.nonce, purpose: 'unlock', createdAt: clock });
    const resp = phoneSign({ id: ch.id, nonce: ch.nonce, purpose: 'unlock', key: Buffer.alloc(32, 0xEE), fingerprint: dev.fingerprint, ts: clock });
    const r = v.verify(resp);
    ok('wrong key → hmac_mismatch', !r.ok && r.reason === 'hmac_mismatch');
  }

  // ---- stale ts (outside ±30s) ----
  {
    const db = freshDb();
    const dev = seedDevice(db, { seed: 0x30 });
    let clock = 1_700_000_000_000;
    const v = new ChallengeVerifier({ db, now: () => clock });
    const ch = createChallenge({ purpose: 'unlock', now: () => clock });
    v.register({ id: ch.id, fingerprint: dev.fingerprint, nonce: ch.nonce, purpose: 'unlock', createdAt: clock });
    const staleTs = clock - 31_000;
    const resp = phoneSign({ id: ch.id, nonce: ch.nonce, purpose: 'unlock', key: dev.key, fingerprint: dev.fingerprint, ts: staleTs });
    const r = v.verify(resp);
    ok('ts 31s old → stale_ts', !r.ok && r.reason === 'stale_ts');
  }

  // ---- replay: same RESPONSE twice ----
  {
    const db = freshDb();
    const dev = seedDevice(db, { seed: 0x40 });
    const clock = 1_700_000_000_000;
    const v = new ChallengeVerifier({ db, now: () => clock });
    const ch = createChallenge({ purpose: 'unlock', now: () => clock });
    v.register({ id: ch.id, fingerprint: dev.fingerprint, nonce: ch.nonce, purpose: 'unlock', createdAt: clock });
    const resp = phoneSign({ id: ch.id, nonce: ch.nonce, purpose: 'unlock', key: dev.key, fingerprint: dev.fingerprint, ts: clock });
    const r1 = v.verify(resp);
    const r2 = v.verify(resp);
    ok('first verify ok, replay → unknown_challenge', r1.ok && !r2.ok && r2.reason === 'unknown_challenge');
  }

  // ---- fallback (biometric_ok=false) policy ----
  {
    const db = freshDb();
    const dev = seedDevice(db, { seed: 0x50 });
    const clock = 1_700_000_000_000;
    const v = new ChallengeVerifier({ db, now: () => clock });

    // unlock under fallback → allowed
    const chU = createChallenge({ purpose: 'unlock', now: () => clock });
    v.register({ id: chU.id, fingerprint: dev.fingerprint, nonce: chU.nonce, purpose: 'unlock', createdAt: clock });
    const rU = v.verify(phoneSign({ id: chU.id, nonce: chU.nonce, purpose: 'unlock', key: dev.key, fingerprint: dev.fingerprint, ts: clock, biometricOk: false }));
    ok('fallback unlock allowed', rU.ok && rU.biometricOk === false);
    ok('fallback stamps last_fallback_at', pairedDevices.findByFingerprint(db, dev.fingerprint).last_fallback_at === clock);

    // export_plaintext under fallback → denied
    const chE = createChallenge({ purpose: 'export_plaintext', now: () => clock });
    v.register({ id: chE.id, fingerprint: dev.fingerprint, nonce: chE.nonce, purpose: 'export_plaintext', createdAt: clock });
    const rE = v.verify(phoneSign({ id: chE.id, nonce: chE.nonce, purpose: 'export_plaintext', key: dev.key, fingerprint: dev.fingerprint, ts: clock, biometricOk: false }));
    ok('fallback export_plaintext denied', !rE.ok && rE.reason === 'fallback_purpose_denied');

    // sync_destructive WITH biometric → allowed (only the fallback path is gated)
    const chS = createChallenge({ purpose: 'sync_destructive', now: () => clock });
    v.register({ id: chS.id, fingerprint: dev.fingerprint, nonce: chS.nonce, purpose: 'sync_destructive', createdAt: clock });
    const rS = v.verify(phoneSign({ id: chS.id, nonce: chS.nonce, purpose: 'sync_destructive', key: dev.key, fingerprint: dev.fingerprint, ts: clock, biometricOk: true }));
    ok('biometric sync_destructive allowed', rS.ok);
  }

  // ---- phone error + FALLBACK_REQ envelopes ----
  {
    const db = freshDb();
    const dev = seedDevice(db, { seed: 0x60 });
    const clock = 1_700_000_000_000;
    const v = new ChallengeVerifier({ db, now: () => clock });

    const chErr = createChallenge({ purpose: 'unlock', now: () => clock });
    v.register({ id: chErr.id, fingerprint: dev.fingerprint, nonce: chErr.nonce, purpose: 'unlock', createdAt: clock });
    const rErr = v.verify({ t: 'RESPONSE', id: chErr.id, error: 'key_invalidated' });
    ok('phone error passes through', !rErr.ok && rErr.reason === 'phone_error:key_invalidated');

    const chFb = createChallenge({ purpose: 'unlock', now: () => clock });
    v.register({ id: chFb.id, fingerprint: dev.fingerprint, nonce: chFb.nonce, purpose: 'unlock', createdAt: clock });
    const rFb = v.verify({ t: 'FALLBACK_REQ', id: chFb.id, reason: 'bio_unavailable' });
    ok('FALLBACK_REQ surfaces fallback_requested', !rFb.ok && rFb.fallbackRequested === true);
    // FALLBACK_REQ must NOT consume the challenge: the phone sends a RESPONSE
    // after the user types the fallback PIN, reusing the same id/nonce (§7).
    const rResume = v.verify(phoneSign({ id: chFb.id, nonce: chFb.nonce, purpose: 'unlock', key: dev.key, fingerprint: dev.fingerprint, ts: clock, biometricOk: false }));
    ok('fallback RESPONSE after FALLBACK_REQ verifies', rResume.ok && rResume.biometricOk === false);
    // …and now it IS consumed (replay defence still holds for the resumed path).
    const rReplay = v.verify(phoneSign({ id: chFb.id, nonce: chFb.nonce, purpose: 'unlock', key: dev.key, fingerprint: dev.fingerprint, ts: clock, biometricOk: false }));
    ok('resumed fallback id consumed after RESPONSE', !rReplay.ok && rReplay.reason === 'unknown_challenge');
  }

  // ---- cancel(): user declined the fallback modal ----
  {
    const db = freshDb();
    const dev = seedDevice(db, { seed: 0x65 });
    const clock = 1_700_000_000_000;
    const v = new ChallengeVerifier({ db, now: () => clock });
    const ch = createChallenge({ purpose: 'unlock', now: () => clock });
    v.register({ id: ch.id, fingerprint: dev.fingerprint, nonce: ch.nonce, purpose: 'unlock', createdAt: clock });
    v.verify({ t: 'FALLBACK_REQ', id: ch.id, reason: 'bio_unavailable' });
    v.cancel(ch.id);
    const r = v.verify(phoneSign({ id: ch.id, nonce: ch.nonce, purpose: 'unlock', key: dev.key, fingerprint: dev.fingerprint, ts: clock, biometricOk: false }));
    ok('cancel() drops pending → RESPONSE rejected', !r.ok && r.reason === 'unknown_challenge');
    ok('cancel() of unknown id is a no-op', (v.cancel('ffffffffffffffff'), true));
  }

  // ---- pending TTL prune: a stale challenge is reclaimed ----
  {
    const db = freshDb();
    const dev = seedDevice(db, { seed: 0x68 });
    let clock = 1_700_000_000_000;
    const v = new ChallengeVerifier({ db, now: () => clock, pendingTtlMs: 150_000 });
    const stale = createChallenge({ purpose: 'unlock', now: () => clock });
    v.register({ id: stale.id, fingerprint: dev.fingerprint, nonce: stale.nonce, purpose: 'unlock', createdAt: clock });
    // Advance past the TTL, then register a fresh challenge → prune evicts the stale one.
    clock += 150_001;
    const fresh = createChallenge({ purpose: 'unlock', now: () => clock });
    v.register({ id: fresh.id, fingerprint: dev.fingerprint, nonce: fresh.nonce, purpose: 'unlock', createdAt: clock });
    const r = v.verify(phoneSign({ id: stale.id, nonce: stale.nonce, purpose: 'unlock', key: dev.key, fingerprint: dev.fingerprint, ts: clock, biometricOk: false }));
    ok('stale pending pruned → unknown_challenge', !r.ok && r.reason === 'unknown_challenge');
  }

  // ---- unknown challenge id ----
  {
    const db = freshDb();
    seedDevice(db, { seed: 0x70 });
    const v = new ChallengeVerifier({ db });
    const r = v.verify({ t: 'RESPONSE', id: 'deadbeefdeadbeef', hmac_b64: 'AAAA', ts: Date.now(), biometric_ok: true });
    ok('unregistered id → unknown_challenge', !r.ok && r.reason === 'unknown_challenge');
  }

  // ---- AAD byte cross-check (matches Crypto.kt / vectors) ----
  {
    const aad = buildChallengeAad({
      id: '0123456789abcdef',
      nonce: Buffer.alloc(32, 0),
      purpose: 'unlock',
      tsMs: 1750000000000,
      fingerprintRaw: Buffer.alloc(32, 0x5a),
    });
    ok('AAD is 104 bytes', aad.length === 104);
    ok('AAD prefix is PassMan-CHAL-v1', aad.slice(0, 15).toString('utf8') === 'PassMan-CHAL-v1');
    ok('purpose byte at offset 63', aad[63] === 0x01);
    ok('ts big-endian at offset 64', aad.readBigInt64BE(64) === 1750000000000n);
  }
}

async function routeTests() {
  console.log('M3\'-B /api/lan/challenge/* route tests:');
  const db = freshDb();
  const dev = seedDevice(db, { seed: 0x80 });
  const noKeyDev = seedDevice(db, { seed: 0x90, withKey: false });

  const app = express();
  app.use(express.json());
  installLanDeviceRoutes(app, db);
  const verifier = installLanChallengeRoutes(app, db);

  const srv = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (path, body) =>
    (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

  // create + verify happy path over HTTP
  let r = await post('/api/lan/challenge/create', { fingerprint: dev.fingerprint, purpose: 'unlock' });
  let j = await r.json();
  ok('POST /create ok', r.status === 200 && j.ok && j.frame && j.frame.t === 'CHALLENGE');
  const nonce = Buffer.from(j.frame.nonce_b64, 'base64');
  const resp = phoneSign({ id: j.id, nonce, purpose: 'unlock', key: dev.key, fingerprint: dev.fingerprint, ts: Date.now() });
  r = await post('/api/lan/challenge/verify', { response: resp });
  j = await r.json();
  ok('POST /verify ok', j.ok === true && j.purpose === 'unlock' && j.biometric_ok === true);

  // create for device with no key → 409
  r = await post('/api/lan/challenge/create', { fingerprint: noKeyDev.fingerprint, purpose: 'unlock' });
  ok('create no_hmac_key → 409', r.status === 409 && (await r.json()).error === 'no_hmac_key');

  // create for unknown device → 404
  r = await post('/api/lan/challenge/create', { fingerprint: 'A'.repeat(64), purpose: 'unlock' });
  ok('create unknown_device → 404', r.status === 404);

  // create bad purpose → 400
  r = await post('/api/lan/challenge/create', { fingerprint: dev.fingerprint, purpose: 'nope' });
  ok('create bad_purpose → 400', r.status === 400);

  // verify a stale RESPONSE over HTTP
  r = await post('/api/lan/challenge/create', { fingerprint: dev.fingerprint, purpose: 'unlock' });
  j = await r.json();
  const staleNonce = Buffer.from(j.frame.nonce_b64, 'base64');
  const staleResp = phoneSign({ id: j.id, nonce: staleNonce, purpose: 'unlock', key: dev.key, fingerprint: dev.fingerprint, ts: Date.now() - 60_000 });
  r = await post('/api/lan/challenge/verify', { response: staleResp });
  j = await r.json();
  ok('verify stale → reason stale_ts', j.ok === false && j.reason === 'stale_ts');

  // fallback resume over HTTP: create → FALLBACK_REQ keeps it pending → the
  // post-PIN RESPONSE (biometric_ok:false) verifies on the same shared verifier.
  r = await post('/api/lan/challenge/create', { fingerprint: dev.fingerprint, purpose: 'unlock' });
  j = await r.json();
  const fbId = j.id;
  const fbNonce = Buffer.from(j.frame.nonce_b64, 'base64');
  r = await post('/api/lan/challenge/verify', { response: { t: 'FALLBACK_REQ', id: fbId, reason: 'bio_unavailable' } });
  j = await r.json();
  ok('HTTP FALLBACK_REQ → fallback_requested', j.ok === false && j.fallback_requested === true);
  const fbResp = phoneSign({ id: fbId, nonce: fbNonce, purpose: 'unlock', key: dev.key, fingerprint: dev.fingerprint, ts: Date.now(), biometricOk: false });
  r = await post('/api/lan/challenge/verify', { response: fbResp });
  j = await r.json();
  ok('HTTP fallback RESPONSE verifies', j.ok === true && j.biometric_ok === false);

  // /cancel drops a pending challenge so a later RESPONSE is rejected.
  r = await post('/api/lan/challenge/create', { fingerprint: dev.fingerprint, purpose: 'unlock' });
  j = await r.json();
  const cancelId = j.id;
  const cancelNonce = Buffer.from(j.frame.nonce_b64, 'base64');
  r = await post('/api/lan/challenge/cancel', { id: cancelId });
  ok('POST /cancel ok', r.status === 200 && (await r.json()).ok === true);
  const afterCancel = phoneSign({ id: cancelId, nonce: cancelNonce, purpose: 'unlock', key: dev.key, fingerprint: dev.fingerprint, ts: Date.now() });
  r = await post('/api/lan/challenge/verify', { response: afterCancel });
  j = await r.json();
  ok('verify after cancel → unknown_challenge', j.ok === false && j.reason === 'unknown_challenge');

  await new Promise((res) => srv.close(res));
  db.close();
}

async function main() {
  unitTests();
  await routeTests();
  console.log(`\n${pass} passed, ${fail} failed`);
  // Set exitCode and let the event loop drain — calling process.exit() while
  // better-sqlite3 / server handles are still closing trips a libuv assertion
  // on Windows (UV_HANDLE_CLOSING).
  process.exitCode = fail ? 1 : 0;
}

main();
