// gen-m3b-challenge-vectors.js — authoritative Node implementation of the
// M3'-B challenge AAD + HMAC (design §4), plus deterministic cross-language
// test vectors for the JVM CryptoChallengeTest (added in B-6).
//
// This file is the byte-level SPEC: Crypto.kt#buildChallengeAad and the PC-side
// verifier (B-4, src/lan-challenge.js) must reproduce these bytes exactly.
//
// Usage:
//   node scripts/gen-m3b-challenge-vectors.js            # self-check + print JSON to stdout
//   node scripts/gen-m3b-challenge-vectors.js > android/app/src/test/resources/m3b_challenge_vectors.json
//
// Self-checks run on every invocation and write to stderr; a failure exits 1 so
// the redirect target is never overwritten with a broken spec.

'use strict';

const crypto = require('crypto');

// ---- canonical spec (mirror of Crypto.kt M3'-B section) ----

const CHAL_AAD_PREFIX = 'PassMan-CHAL-v1';   // 15 bytes
const PURPOSE_BYTE = Object.freeze({
  unlock: 0x01,
  sync_destructive: 0x02,
  export_plaintext: 0x03,
});

/**
 * AAD = prefix(15) || id_utf8(16) || nonce(32) || purpose(1) || ts_be(8) || fp_raw(32) = 104B
 * `fingerprintRaw` is the raw 32B SHA-256(pubkey) digest (hex-decode of the
 * paired_devices fingerprint), NOT the 64-char hex string.
 */
function buildChallengeAad({ id, nonce, purpose, tsMs, fingerprintRaw }) {
  const idBytes = Buffer.from(id, 'utf8');
  if (idBytes.length !== 16) throw new Error(`id must be 16 ascii chars, got ${idBytes.length}`);
  if (nonce.length !== 32) throw new Error('nonce must be 32 bytes');
  if (fingerprintRaw.length !== 32) throw new Error('fingerprintRaw must be 32 bytes');
  const purposeByte = PURPOSE_BYTE[purpose];
  if (purposeByte === undefined) throw new Error(`unknown purpose: ${purpose}`);
  const ts = Buffer.alloc(8);
  ts.writeBigInt64BE(BigInt(tsMs));
  return Buffer.concat([
    Buffer.from(CHAL_AAD_PREFIX, 'utf8'),
    idBytes,
    Buffer.from(nonce),
    Buffer.from([purposeByte]),
    ts,
    Buffer.from(fingerprintRaw),
  ]);
}

/** HMAC-SHA256(device_hmac_key, AAD) -> 32B Buffer. */
function computeChallengeHmac(deviceHmacKey, aad) {
  return crypto.createHmac('sha256', deviceHmacKey).update(aad).digest();
}

// ---- deterministic inputs ----

function fill(n, fn) { return Buffer.from(Array.from({ length: n }, (_, i) => fn(i) & 0xff)); }
const hex = (b) => Buffer.from(b).toString('hex').toUpperCase();

// A few fixed 32B keys / nonces / fingerprints so the JVM test reproduces them.
const KEYS = [
  fill(32, (i) => i + 1),                 // 01..20
  fill(32, () => 0xAB),                    // all-AB
  fill(32, (i) => (i * 7 + 3)),            // pseudo-random
];
const NONCES = [
  fill(32, (i) => 0xFF - i),
  fill(32, () => 0x00),                    // all-zero nonce (edge)
];
const FINGERPRINTS = [
  crypto.createHash('sha256').update(fill(32, (i) => i)).digest(),   // realistic: hash of a pubkey
  fill(32, () => 0x5A),
];
const IDS = ['0123456789abcdef', 'ffffffffffffffff'];
const TIMESTAMPS = [0, 1, 1750000000000, 9007199254740991];          // incl. 0 and max-safe-int ms
const PURPOSES = ['unlock', 'sync_destructive', 'export_plaintext'];

// ---- build vectors ----

const vectors = [];
let n = 0;
for (let ki = 0; ki < KEYS.length; ki++) {
  // Vary the other axes without a full cartesian explosion: pick by index.
  const key = KEYS[ki];
  const nonce = NONCES[ki % NONCES.length];
  const fp = FINGERPRINTS[ki % FINGERPRINTS.length];
  const id = IDS[ki % IDS.length];
  for (const purpose of PURPOSES) {
    const tsMs = TIMESTAMPS[n % TIMESTAMPS.length];
    const aad = buildChallengeAad({ id, nonce, purpose, tsMs, fingerprintRaw: fp });
    const hmac = computeChallengeHmac(key, aad);
    vectors.push({
      label: `key#${ki} ${purpose} ts=${tsMs}`,
      device_hmac_key_hex: hex(key),
      id,
      nonce_hex: hex(nonce),
      purpose,
      ts_ms: tsMs,
      fingerprint_raw_hex: hex(fp),
      aad_hex: hex(aad),
      hmac_hex: hex(hmac),
    });
    n++;
  }
}

// ---- self-checks (stderr; exit 1 on failure) ----

let failed = 0;
function check(name, cond) {
  if (cond) { process.stderr.write(`  ✓ ${name}\n`); }
  else { process.stderr.write(`  ✗ ${name}\n`); failed++; }
}

process.stderr.write('M3\'-B challenge vector self-checks:\n');

// 1. AAD length is the fixed 104 bytes for every vector.
check('every AAD is 104 bytes', vectors.every((v) => Buffer.from(v.aad_hex, 'hex').length === 104));

// 2. HMAC is 32 bytes.
check('every HMAC is 32 bytes', vectors.every((v) => Buffer.from(v.hmac_hex, 'hex').length === 32));

// 3. Recomputing from stored inputs reproduces aad_hex + hmac_hex (no hidden state).
check('inputs deterministically reproduce aad+hmac', vectors.every((v) => {
  const aad = buildChallengeAad({
    id: v.id,
    nonce: Buffer.from(v.nonce_hex, 'hex'),
    purpose: v.purpose,
    tsMs: v.ts_ms,
    fingerprintRaw: Buffer.from(v.fingerprint_raw_hex, 'hex'),
  });
  const hmac = computeChallengeHmac(Buffer.from(v.device_hmac_key_hex, 'hex'), aad);
  return hex(aad) === v.aad_hex && hex(hmac) === v.hmac_hex;
}));

// 4. purpose byte appears at the documented offset (15 + 16 + 32 = 63).
check('purpose byte lands at offset 63', vectors.every((v) => {
  const aad = Buffer.from(v.aad_hex, 'hex');
  return aad[63] === PURPOSE_BYTE[v.purpose];
}));

// 5. ts is big-endian at offset 64.
check('ts is big-endian int64 at offset 64', (() => {
  const v = vectors.find((x) => x.ts_ms === 1750000000000);
  if (!v) return false;
  const aad = Buffer.from(v.aad_hex, 'hex');
  return aad.readBigInt64BE(64) === 1750000000000n;
})());

// 6. changing only the purpose changes the HMAC (cross-purpose replay defence).
check('purpose is bound into the HMAC', (() => {
  const fp = FINGERPRINTS[0], nonce = NONCES[0], key = KEYS[0], id = IDS[0], ts = 1;
  const a = computeChallengeHmac(key, buildChallengeAad({ id, nonce, purpose: 'unlock', tsMs: ts, fingerprintRaw: fp }));
  const b = computeChallengeHmac(key, buildChallengeAad({ id, nonce, purpose: 'export_plaintext', tsMs: ts, fingerprintRaw: fp }));
  return !a.equals(b);
})());

process.stderr.write(`\n${vectors.length - failed >= 0 ? '' : ''}${failed} self-check failures\n`);
if (failed) process.exit(1);

// ---- emit JSON to stdout ----
process.stdout.write(JSON.stringify(vectors, null, 2) + '\n');

module.exports = { buildChallengeAad, computeChallengeHmac, PURPOSE_BYTE, CHAL_AAD_PREFIX };
