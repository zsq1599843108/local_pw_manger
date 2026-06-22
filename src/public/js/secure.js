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
 * Derive the 32-byte AES-256 session key from the ECDH shared secret.
 *   salt = noncePc(16) || noncePhone(16)
 *   info = "passman-lan-v1"
 */
async function deriveSessionKey(priv, peerPub, noncePc, noncePhone) {
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPub }, priv, 256));
  const salt = concat(noncePc, noncePhone);
  const baseKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const okm = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, baseKey, 256));
  return crypto.subtle.importKey('raw', okm, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
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

window.PassManSecure = {
  generateKeypair, importPeerPub, deriveSessionKey, SecureChannel,
  encodeHello, parseWelcome, randomNonce,
  b64encode, b64decode, concat,
  CTR_SIZE, IV_SIZE, TAG_SIZE,
};
