// secure.js — browser-side crypto for the LAN encrypted channel (M2', ADR-002).
//
// Algorithm stack mirrors android/.../Crypto.kt exactly so the two sides are
// byte-compatible:
//   X25519 ECDH → HKDF-SHA256(info="passman-lan-v1") → AES-256-GCM
//
// Wire frame (one WebSocket binary message):
//   ┌──────────┬───────────────┬──────────────────────────┐
//   │ IV (12)  │ frame_ctr (8) │ ciphertext || tag (N+16) │
//   └──────────┴───────────────┴──────────────────────────┘
//                  big-endian      AES-GCM tag is appended by WebCrypto
//   GCM AAD = "PassMan-LAN-v1" || frame_ctr(8)
//
// frame_ctr is monotonic per direction (send counter and receive counter are
// independent). The receiver rejects any frame whose counter is not strictly
// greater than the last accepted one — this is the replay defence from
// design §5.
//
// Handshake (before encrypted frames) rides on WebSocket *text* frames as
// JSON; encrypted data rides on *binary* frames, so the two never collide:
//   PC  -> phone : { "t":"HELLO",   "pub":b64, "nonce":b64 }
//   phone -> PC  : { "t":"WELCOME", "pub":b64, "nonce":b64 }
// Both sides then derive session_key and switch to binary encrypted frames.

'use strict';

const INFO = new TextEncoder().encode('passman-lan-v1');
const AAD_PREFIX = new TextEncoder().encode('PassMan-LAN-v1');
const IV_SIZE = 12;
const CTR_SIZE = 8;
const TAG_SIZE = 16;

// ---------- byte helpers ----------

function concat(...parts) {
  let len = 0;
  for (const p of parts) len += p.byteLength;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
}

function ctrToBytes(ctr) {
  // 8-byte big-endian. ctr is BigInt.
  const b = new Uint8Array(CTR_SIZE);
  for (let i = 0; i < CTR_SIZE; i++) b[CTR_SIZE - 1 - i] = Number((ctr >> BigInt(8 * i)) & 0xFFn);
  return b;
}

function bytesToCtr(b) {
  let v = 0n;
  for (let i = 0; i < CTR_SIZE; i++) v = (v << 8n) | BigInt(b[i]);
  return v;
}

function b64encode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------- key exchange ----------

/**
 * Generate an X25519 keypair. Returns { priv (CryptoKey), pubBytes (Uint8Array, 32B) }.
 *
 * X25519 in WebCrypto SubtleCrypto shipped in Chrome 113 / Edge 113, so the
 * Win11 Chrome 130 target is fine. P-256 fallback is NOT wired up — if a
 * future browser target lacks X25519, swap the namedCurve here and in Crypto.kt.
 */
async function generateKeypair() {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'X25519' }, true, ['deriveBits']);
  const pubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { priv: kp.privateKey, pubBytes };
}

async function importPeerPub(pubBytes) {
  return crypto.subtle.importKey(
    'raw', pubBytes, { name: 'ECDH', namedCurve: 'X25519' }, false, []);
}

/**
 * Derive the 32-byte AES-256 session key and a 32-byte raw "pair_secret"
 * from the ECDH shared secret. We derive both in one HKDF expansion (info
 * fixed at "passman-lan-v1", out = 64 bytes) so the two values are linked
 * to the same handshake but live in separate domains.
 *
 *   salt = noncePc(16) || noncePhone(16)
 *   info = "passman-lan-v1"
 *
 * Returns { aesKey: CryptoKey, pairSecret: Uint8Array(32) }. `aesKey` is
 * non-extractable; `pairSecret` is raw bytes and feeds rollingPin() during
 * the M3' pairing handshake.
 */
async function deriveSessionKey(priv, peerPub, noncePc, noncePhone) {
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPub }, priv, 256));
  const salt = concat(noncePc, noncePhone);
  const baseKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const okm = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, baseKey, 512));
  const aesRaw = okm.subarray(0, 32);
  const pairSecret = okm.slice(32, 64);   // .slice copies into its own buffer
  const aesKey = await crypto.subtle.importKey(
    'raw', aesRaw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { aesKey, pairSecret };
}

// ---------- encrypted channel ----------

class ReplayError extends Error {
  constructor(ctr, lastCtr) {
    super(`replay/bad ctr: got ${ctr}, last accepted ${lastCtr}`);
    this.name = 'ReplayError';
    this.ctr = ctr;
  }
}

/**
 * Holds the session key and the two independent monotonic counters.
 * One SecureChannel per WebSocket connection.
 */
class SecureChannel {
  constructor(key) {
    this.key = key;
    this.sendCtr = 0n;
    this.lastRecvCtr = -1n;   // accept first frame at ctr 0
  }

  /** Encrypt plaintext (Uint8Array) -> wire frame (Uint8Array). */
  async seal(plaintext) {
    const ctr = this.sendCtr++;
    const iv = crypto.getRandomValues(new Uint8Array(IV_SIZE));
    const ctrBytes = ctrToBytes(ctr);
    const aad = concat(AAD_PREFIX, ctrBytes);
    // WebCrypto AES-GCM returns ciphertext || tag(16).
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, this.key, plaintext));
    return concat(iv, ctrBytes, ct);
  }

  /** Decrypt a wire frame (Uint8Array) -> plaintext (Uint8Array). Throws on auth/replay. */
  async open(frame) {
    if (frame.byteLength < IV_SIZE + CTR_SIZE + TAG_SIZE) {
      throw new Error(`frame too short: ${frame.byteLength}`);
    }
    const iv = frame.subarray(0, IV_SIZE);
    const ctrBytes = frame.subarray(IV_SIZE, IV_SIZE + CTR_SIZE);
    const ct = frame.subarray(IV_SIZE + CTR_SIZE);
    const ctr = bytesToCtr(ctrBytes);
    if (ctr <= this.lastRecvCtr) throw new ReplayError(ctr, this.lastRecvCtr);
    const aad = concat(AAD_PREFIX, ctrBytes);
    const pt = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, this.key, ct));
    this.lastRecvCtr = ctr;
    return pt;
  }
}

// ---------- handshake helpers ----------

/** Build the PC's HELLO text frame (JSON string). */
function encodeHello(pubBytes, noncePc) {
  return JSON.stringify({ t: 'HELLO', pub: b64encode(pubBytes), nonce: b64encode(noncePc) });
}

/** Parse the phone's WELCOME text frame. Returns { pubBytes, noncePhone }. */
function parseWelcome(json) {
  const m = JSON.parse(json);
  if (m.t !== 'WELCOME' || !m.pub || !m.nonce) throw new Error('bad WELCOME: ' + json);
  return { pubBytes: b64decode(m.pub), noncePhone: b64decode(m.nonce) };
}

/** Random 16-byte nonce. */
function randomNonce() {
  return crypto.getRandomValues(new Uint8Array(16));
}

// ---------- M3'-A rolling pairing PIN ----------
//
// Goal: shrink the attack window for the pairing handshake. A static PIN is
// brute-forceable indefinitely; we instead derive PIN_t = HKDF(pair_secret,
// floor(now/30s)) % 1_000_000, so an attacker has at most one 30s window per
// session. On top of that, the phone limits to 5 wrong attempts per 60s.
//
// `pair_secret` is the second 32 bytes of the HKDF expansion done in
// deriveSessionKey() — same handshake, separate domain from the AES key.
// info = "passman-pair-pin-v1" so the PIN domain is separated from any other
// future use of pair_secret.

const PIN_INFO = new TextEncoder().encode('passman-pair-pin-v1');
const PIN_WINDOW_MS = 30_000;

function pinWindow(nowMs) {
  return Math.floor(nowMs / PIN_WINDOW_MS);
}

/**
 * Derive the rolling 6-digit PIN for window `w` from pair_secret.
 * Both sides compute the same value when they agree on `w`.
 * Returns a zero-padded 6-character string.
 */
async function rollingPin(pairSecret, w) {
  const w8 = new Uint8Array(8);
  let v = BigInt(w);
  for (let i = 7; i >= 0; i--) { w8[i] = Number(v & 0xFFn); v >>= 8n; }
  const baseKey = await crypto.subtle.importKey('raw', pairSecret, 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: w8, info: PIN_INFO }, baseKey, 32));
  // Big-endian 32-bit -> uint32 -> % 1e6, zero-pad to 6 digits.
  const u32 = ((bits[0] << 24) | (bits[1] << 16) | (bits[2] << 8) | bits[3]) >>> 0;
  return String(u32 % 1_000_000).padStart(6, '0');
}

/**
 * SHA-256(pubkey) as 64-char uppercase hex. Used as the TOFU identity for a
 * trusted phone (PK in paired_devices). For display, callers usually slice
 * the first 32 chars and group as XXXX-XXXX-XXXX-XXXX so the user can read
 * the same string off both screens.
 *
 * Byte-for-byte mirror of fingerprintHex in src/paired-devices.js and
 * Crypto.kt.fingerprintHex.
 */
async function fingerprintHex(pubBytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', pubBytes));
  let s = '';
  for (const b of digest) s += b.toString(16).padStart(2, '0');
  return s.toUpperCase();
}

/** Pretty-print 32 hex chars as "XXXX XXXX XXXX XXXX XXXX XXXX XXXX XXXX" (4-block). */
function fingerprintShort(fpHex) {
  const head = fpHex.slice(0, 32);
  return head.replace(/(.{4})/g, '$1 ').trim();
}

window.PassManSecure = {
  generateKeypair, importPeerPub, deriveSessionKey, SecureChannel,
  encodeHello, parseWelcome, randomNonce,
  fingerprintHex, fingerprintShort,
  rollingPin, pinWindow, PIN_WINDOW_MS,
  b64encode, b64decode, concat,
  CTR_SIZE, IV_SIZE, TAG_SIZE,
};
