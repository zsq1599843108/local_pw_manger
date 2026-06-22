// gen-m3-pairing-vectors.js — generates m3_pairing_vectors.json for the JVM
// CryptoPairingTest.kt, covering rollingPin and fingerprintHex.
//
// Run: node scripts/gen-m3-pairing-vectors.js > android/app/src/test/resources/m3_pairing_vectors.json

'use strict';

const { webcrypto } = require('crypto');

// Same WebCrypto shim as test-m2-encrypted-channel.js — Node 24 uses
// {name:'X25519'} while secure.js uses {name:'ECDH', namedCurve:'X25519'}.
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

  // Deterministic pair_secret across vectors so the JVM test can reproduce.
  const secrets = [
    new Uint8Array(32).map((_, i) => i + 1),                      // 01..20
    new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xFF),         // pseudo-random
    new Uint8Array(32).map((_, i) => i === 0 ? 0xFF : i),         // edge: leading 0xFF
  ];
  const windows = [0n, 1n, 7n, 100n, 99999n, 9007199254740992n];  // last = 2^53, max safe JSON

  for (let si = 0; si < secrets.length; si++) {
    const secret = secrets[si];
    for (const w of windows) {
      const pin = await S.rollingPin(secret, w);
      vectors.push({
        label: `pair_secret #${si}, w=${w}`,
        pair_secret_hex: hex(secret),
        w: Number(w),                       // safe at 2^53
        pin,
      });
    }
  }

  // fingerprintHex vectors — derive from known pub bytes (no ECDH needed for the
  // hash itself; we just need 32-byte inputs).
  const pubBytes = [
    new Uint8Array(32).map((_, i) => i + 1),
    new Uint8Array(32).map((_, i) => 0xAA),                       // all-AA
    new Uint8Array(32),                                            // all-zero
  ];
  for (let i = 0; i < pubBytes.length; i++) {
    const fp = await S.fingerprintHex(pubBytes[i]);
    vectors.push({
      label: `fingerprint of pub #${i}`,
      fingerprint_of_pub_hex: hex(pubBytes[i]),
      fingerprint: fp,
    });
  }

  process.stdout.write(JSON.stringify(vectors, null, 2) + '\n');
})();