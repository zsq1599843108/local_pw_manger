// lan-challenge.js — PC-side biometric CHALLENGE/RESPONSE logic (design §3/§4/§6).
//
// This module is the AUTHORITATIVE Node implementation of the challenge AAD +
// HMAC. Crypto.kt#buildChallengeAad and scripts/gen-m3b-challenge-vectors.js
// both reproduce these exact bytes — the gen script imports `buildChallengeAad`
// / `computeChallengeHmac` from here and self-checks them against the JVM
// cross-language vectors (B-6).
//
// Responsibilities:
//   - createChallenge(): mint { id, nonce, purpose } + the CHALLENGE frame the
//     browser forwards to the phone over the live SecureChannel.
//   - ChallengeVerifier: track pending challenges, then verify the phone's
//     RESPONSE — HMAC, freshness, replay, and the §7 fallback purpose policy.
//
// The device_hmac_key never leaves this process: the browser only ever sees a
// `has_hmac_key` boolean (see lan-device-routes.js) and forwards opaque frames.
// The real access-control point is here, on the PC.

'use strict';

const crypto = require('crypto');
const pairedDevices = require('./paired-devices');

// ---- canonical spec (mirror of Crypto.kt M3'-B section) ----

const CHAL_AAD_PREFIX = 'PassMan-CHAL-v1';   // 15 bytes
const CHAL_NONCE_SIZE = 32;
const CHAL_ID_HEX_LEN = 16;                  // 16 ascii hex chars → 16 bytes
const CHAL_AAD_LEN = 104;                    // 15 + 16 + 32 + 1 + 8 + 32

const PURPOSE_BYTE = Object.freeze({
  unlock: 0x01,
  sync_destructive: 0x02,
  export_plaintext: 0x03,
});

// Purposes a fallback (non-biometric) RESPONSE is allowed to satisfy. The 4-digit
// PIN path is a "soft door" (design §7) — it may unlock, but never authorise a
// destructive sync or a plaintext export.
const FALLBACK_ALLOWED_PURPOSES = Object.freeze(new Set(['unlock']));

// Freshness bound on the phone-chosen ts (design §6). The phone picks ts, the
// AAD binds it, and we reject anything older/newer than this to bound replay.
const TS_SKEW_MS = 30_000;

// How many recently-used challenge ids we remember to reject replays (design §6).
const REPLAY_WINDOW = 1000;

/**
 * AAD = prefix(15) || id_utf8(16) || nonce(32) || purpose(1) || ts_be(8) || fp_raw(32) = 104B
 * `fingerprintRaw` is the raw 32B SHA-256(pubkey) digest (hex-decode of the
 * paired_devices fingerprint), NOT the 64-char hex string.
 */
function buildChallengeAad({ id, nonce, purpose, tsMs, fingerprintRaw }) {
  const idBytes = Buffer.from(id, 'utf8');
  if (idBytes.length !== CHAL_ID_HEX_LEN) {
    throw new Error(`id must be ${CHAL_ID_HEX_LEN} ascii chars, got ${idBytes.length}`);
  }
  if (nonce.length !== CHAL_NONCE_SIZE) throw new Error('nonce must be 32 bytes');
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

/**
 * Mint a fresh challenge. Returns the bits the verifier needs to remember plus
 * the wire `frame` the browser seals + forwards to the phone. `id` is 16 hex
 * chars (8 random bytes); `nonce` is 32 random bytes.
 *
 * Inject `randomBytes` / `now` in tests for determinism.
 */
function createChallenge({ purpose, randomBytes = crypto.randomBytes, now = Date.now }) {
  if (PURPOSE_BYTE[purpose] === undefined) throw new Error(`unknown purpose: ${purpose}`);
  const id = randomBytes(8).toString('hex');         // 16 hex chars
  const nonce = randomBytes(CHAL_NONCE_SIZE);
  return {
    id,
    nonce,
    purpose,
    createdAt: now(),
    frame: {
      t: 'CHALLENGE',
      id,
      purpose,
      nonce_b64: nonce.toString('base64'),
    },
  };
}

/**
 * Tracks outstanding challenges and verifies the RESPONSE the phone returns.
 *
 * A single verifier instance is shared across requests (one per server). It
 * keeps pending challenges keyed by id and a bounded set of consumed ids so a
 * captured RESPONSE can't be replayed within the freshness window.
 */
class ChallengeVerifier {
  constructor({ db, now = () => Date.now(), tsSkewMs = TS_SKEW_MS, replayWindow = REPLAY_WINDOW } = {}) {
    this._db = db;
    this._now = now;
    this._tsSkewMs = tsSkewMs;
    this._replayWindow = replayWindow;
    this._pending = new Map();    // id -> { fingerprint, nonce, purpose, createdAt }
    this._usedIds = [];           // recently consumed ids, oldest first
    this._usedSet = new Set();
  }

  /** Remember a freshly-minted challenge so a later RESPONSE can be matched. */
  register({ id, fingerprint, nonce, purpose, createdAt = this._now() }) {
    this._pending.set(id, { fingerprint, nonce: Buffer.from(nonce), purpose, createdAt });
  }

  _consume(id) {
    this._pending.delete(id);
    if (this._usedSet.has(id)) return;
    this._usedSet.add(id);
    this._usedIds.push(id);
    while (this._usedIds.length > this._replayWindow) {
      this._usedSet.delete(this._usedIds.shift());
    }
  }

  /**
   * Verify a phone RESPONSE (or FALLBACK_REQ / error envelope) for a pending id.
   *
   * `response` is the decrypted JSON the browser relayed:
   *   { t:'RESPONSE', id, hmac_b64, ts, biometric_ok }   (success)
   *   { t:'RESPONSE', id, error }                          (phone-side failure)
   *   { t:'FALLBACK_REQ', id, reason }                     (no biometrics → B-5)
   *
   * Returns { ok, reason, purpose, biometricOk, fallbackRequested }.
   * On any non-ok path the challenge id is consumed so it can't be retried.
   */
  verify(response) {
    const id = response && response.id;
    if (typeof id !== 'string' || !this._pending.has(id)) {
      return { ok: false, reason: 'unknown_challenge' };
    }
    const pending = this._pending.get(id);

    // Phone asked to start the PIN fallback — the biometric path isn't available
    // on this phone. The PIN handling itself lands in B-5; here we just surface
    // it so the UI can offer the fallback modal (design §7 step 2).
    if (response.t === 'FALLBACK_REQ') {
      this._consume(id);
      return { ok: false, reason: 'fallback_requested', fallbackRequested: true, purpose: pending.purpose };
    }

    // Phone-side error (unknown_purpose / bad_nonce / unknown_device /
    // key_invalidated / user_cancelled / bio_failed …). Pass it through.
    if (response.error) {
      this._consume(id);
      return { ok: false, reason: `phone_error:${response.error}` };
    }

    if (response.t !== 'RESPONSE') {
      this._consume(id);
      return { ok: false, reason: 'bad_response_type' };
    }

    const device = pairedDevices.findByFingerprint(this._db, pending.fingerprint);
    if (!device || device.device_hmac_key == null) {
      this._consume(id);
      return { ok: false, reason: 'no_hmac_key' };
    }

    const biometricOk = response.biometric_ok === true;

    // §7 soft-door policy: a fallback (non-biometric) RESPONSE may only unlock.
    if (!biometricOk && !FALLBACK_ALLOWED_PURPOSES.has(pending.purpose)) {
      this._consume(id);
      return { ok: false, reason: 'fallback_purpose_denied', purpose: pending.purpose, biometricOk };
    }

    // Freshness: the phone picks ts; reject anything outside ±skew.
    const ts = Number(response.ts);
    if (!Number.isFinite(ts) || Math.abs(ts - this._now()) > this._tsSkewMs) {
      this._consume(id);
      return { ok: false, reason: 'stale_ts', purpose: pending.purpose };
    }

    // Recompute the AAD from the STORED fingerprint (not anything the phone
    // sent) and the pending nonce/purpose, then constant-time compare the HMAC.
    let hmac;
    try {
      hmac = Buffer.from(response.hmac_b64, 'base64');
    } catch (_) {
      this._consume(id);
      return { ok: false, reason: 'bad_hmac', purpose: pending.purpose };
    }
    if (hmac.length !== 32) {
      this._consume(id);
      return { ok: false, reason: 'bad_hmac', purpose: pending.purpose };
    }

    const fingerprintRaw = Buffer.from(pending.fingerprint, 'hex');
    let expected;
    try {
      const aad = buildChallengeAad({
        id, nonce: pending.nonce, purpose: pending.purpose, tsMs: ts, fingerprintRaw,
      });
      expected = computeChallengeHmac(Buffer.from(device.device_hmac_key), aad);
    } catch (e) {
      this._consume(id);
      return { ok: false, reason: 'aad_error', purpose: pending.purpose };
    }

    if (!crypto.timingSafeEqual(hmac, expected)) {
      this._consume(id);
      return { ok: false, reason: 'hmac_mismatch', purpose: pending.purpose };
    }

    // Success. Consume the id (replay defence) and stamp the device row.
    this._consume(id);
    const stamp = this._now();
    if (biometricOk) pairedDevices.touchChallengeAt(this._db, pending.fingerprint, stamp);
    else             pairedDevices.touchFallbackAt(this._db, pending.fingerprint, stamp);

    return { ok: true, purpose: pending.purpose, biometricOk, fingerprint: pending.fingerprint };
  }
}

module.exports = {
  // canonical spec (single source of truth; gen-m3b-challenge-vectors imports these)
  buildChallengeAad,
  computeChallengeHmac,
  createChallenge,
  ChallengeVerifier,
  // constants
  CHAL_AAD_PREFIX,
  CHAL_NONCE_SIZE,
  CHAL_ID_HEX_LEN,
  CHAL_AAD_LEN,
  PURPOSE_BYTE,
  FALLBACK_ALLOWED_PURPOSES,
  TS_SKEW_MS,
  REPLAY_WINDOW,
};
