// gen-m2-interop-vectors.js — generates m2_interop_vectors.json for the JVM
// CryptoInteropTest.kt. Uses Node WebCrypto + secure.js to produce known
// ciphertexts + frames, then writes them out as hex/json.
//
// Run: node scripts/gen-m2-interop-vectors.js > android/app/src/test/resources/m2_interop_vectors.json
//
// Each vector has:
//   label — name for debug
//   key_hex — 32-byte AES key
//   iv_hex — 12-byte GCM IV
//   ctr_hex — 8-byte frame counter (big-endian)
//   plaintext_b64 — original message (to match after decrypt)
//   ct_tag_hex — the ciphertext||tag portion (what javax.crypto.Cipher.doFinal returns)
//   frame_hex — full wire frame: iv(12) || ctr(8) || ct||tag

'use strict';

const { webcrypto } = require('crypto');
const rawSubtle = webcrypto.subtle;
function normAlg(alg, key) {
  if (!alg) return alg;
  if (alg.name === 'ECDH' && (alg.namedCurve === 'X25519' ||
      (key && key.algorithm && key.algorithm.name === 'X25519'))) {
    const { name, namedCurve, ...rest } = alg;
    return { name: 'X25519', ...rest };
  }
  return alg;
}
const subtleShim = new Proxy(rawSubtle, {
  get(target, prop) {
    const v = target[prop];
    if (typeof v !== 'function') return v;
    return function (...args) {
      if (prop === 'generateKey') args[0] = normAlg(args[0]);
      else if (prop === 'importKey') args[2] = normAlg(args[2]);
      else if (prop === 'deriveBits') args[0] = normAlg(args[0], args[1]);
      else if (prop === 'deriveKey') args[0] = normAlg(args[0], args[1]);
      return v.apply(target, args);
    };
  },
});
const cryptoShim = new Proxy(webcrypto, {
  get(t, p) {
    if (p === 'subtle') return subtleShim;
    const v = t[p];
    return typeof v === 'function' ? v.bind(t) : v;
  },
});
Object.defineProperty(global, 'crypto', { value: cryptoShim, configurable: true, writable: true });
global.window = { crypto: cryptoShim };
global.TextEncoder = require('util').TextEncoder;
global.TextDecoder = require('util').TextDecoder;
global.atob = (s) => Buffer.from(s, 'base64').toString('binary');
global.btoa = (s) => Buffer.from(s, 'binary').toString('base64');

require('../src/public/js/secure.js');
const S = global.window.PassManSecure;

function hex(b) {
  return Array.from(new Uint8Array(b)).map(bb => bb.toString(16).padStart(2, '0')).join('').toUpperCase();
}

(async () => {
  const vectors = [];

  // Vector 1: PING (encrypted channel test, ctr=0)
  {
    const key = new Uint8Array(32);
    for (let i = 0; i < 32; i++) key[i] = i + 1;
    const plaintext = new TextEncoder().encode(JSON.stringify({ t: 'PING', ts: 1719060000000 }));
    const ch = new S.SecureChannel(await webcrypto.subtle.importKey(
      'raw', key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
    // We need to capture the iv+ctr from the first seal call.
    const frame = await ch.seal(plaintext);
    const iv = frame.subarray(0, 12);
    const ctrBytes = frame.subarray(12, 20);
    const ctTag = frame.subarray(20);
    vectors.push({
      label: 'PING at ctr=0',
      key_hex: hex(key),
      iv_hex: hex(iv),
      ctr_hex: hex(ctrBytes),
      plaintext_b64: Buffer.from(plaintext).toString('base64'),
      ct_tag_hex: hex(ctTag),
      frame_hex: hex(frame),
    });
  }

  // Vector 2: PONG (phone->PC, ctr=0 on phone)
  {
    const key = new Uint8Array(32);
    for (let i = 0; i < 32; i++) key[i] = i + 2;
    // Reverse the key pattern so it's different from vector 1
    const plaintext = new TextEncoder().encode(JSON.stringify({ t: 'PONG', ts: 1719060001000, echoTs: 1719060000000 }));
    const ch = new S.SecureChannel(await webcrypto.subtle.importKey(
      'raw', key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
    const frame = await ch.seal(plaintext);
    const iv = frame.subarray(0, 12);
    const ctrBytes = frame.subarray(12, 20);
    const ctTag = frame.subarray(20);
    vectors.push({
      label: 'PONG at ctr=0',
      key_hex: hex(key),
      iv_hex: hex(iv),
      ctr_hex: hex(ctrBytes),
      plaintext_b64: Buffer.from(plaintext).toString('base64'),
      ct_tag_hex: hex(ctTag),
      frame_hex: hex(frame),
    });
  }

  // Vector 3: HELLO_CONTENT  (longer message, ctr=7)
  {
    const key = new Uint8Array(32);
    for (let i = 0; i < 32; i++) key[i] = i + 3;
    const plaintext = new TextEncoder().encode('{"t":"HELLO","pub":"MiC1f2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7Q8R9S0T","nonce":"U1V2W3R4Y5T6U7V8"}');
    const ch = new S.SecureChannel(await webcrypto.subtle.importKey(
      'raw', key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
    // Call seal 7 times so ctr=7 for the output frame.
    for (let i = 0; i < 7; i++) await ch.seal(new Uint8Array([i]));
    const frame = await ch.seal(plaintext);
    const iv = frame.subarray(0, 12);
    const ctrBytes = frame.subarray(12, 20);
    const ctTag = frame.subarray(20);
    vectors.push({
      label: 'HELLO_CONTENT at ctr=7',
      key_hex: hex(key),
      iv_hex: hex(iv),
      ctr_hex: hex(ctrBytes),
      plaintext_b64: Buffer.from(plaintext).toString('base64'),
      ct_tag_hex: hex(ctTag),
      frame_hex: hex(frame),
    });
  }

  process.stdout.write(JSON.stringify(vectors, null, 2) + '\n');
})();