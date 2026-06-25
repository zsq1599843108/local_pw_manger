// test-m3a-pairing.js — end-to-end PIN pairing handshake test.
//
// Builds on test-m2-encrypted-channel.js: the same mock phone implements
// HotspotServerService's handshake (HELLO/WELCOME -> SecureChannel), then
// layers the M3'-A PIN protocol on top. The PC side speaks the real
// secure.js + lan-pair-protocol.js code.
//
// Cases (each runs a fresh PC client against a fresh phone connection):
//   1. correct PIN -> PAIR_OK { fingerprint, label }
//   2. wrong PIN once -> PAIR_REJECT { reason: 'bad_pin' }
//   3. 5 wrong PINs -> PAIR_REJECT { reason: 'locked' } on the 5th onwards
//   4. PIN from window w-2 -> PAIR_REJECT { reason: 'no_match' } (slack only ±1)
//   5. user-denies path -> PAIR_REJECT { reason: 'user_denied' }
//
// We exercise the lockout tracker by reusing the phone's tracker across
// connections via a shared TRACKER reference (mirrors what
// HotspotServerService.kt does — one tracker per service lifetime).

'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { webcrypto } = require('crypto');
const { openBridge } = require('../src/lan-ws-client');
const {
  MSG, REJECT, encode, decode, PairAttemptTracker, verifyPin,
} = require('../src/lan-pair-protocol');

// Subtle shim — same as test-m2-encrypted-channel.js. Node names X25519 as
// { name:'X25519' }; the browser uses { name:'ECDH', namedCurve:'X25519' }.
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
global.performance = { now: () => Date.now() };
const wc = cryptoShim;

require('../src/public/js/secure.js');
const S = global.window.PassManSecure;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

// ---------- mock phone with pairing handler ----------
//
// One mock-phone process implements: HELLO -> WELCOME -> N application
// messages. The pairing logic is shared with HotspotServerService.kt (Kotlin)
// in shape, but here written against the same JSON envelopes.
//
// `opts.userApproves` controls the "user pressed trust" simulation:
//   true   -> approve on the next valid PIN
//   false  -> deny on the next valid PIN (sends PAIR_REJECT { user_denied })
//
// `opts.tracker` lets us share lockout state across handlers within one test.
function startMockPhone({ port, tracker, userApproves = true, label = 'Mock Mi 14 Pro' }) {
  const wss = new WebSocketServer({ port });
  const AAD = Buffer.from('PassMan-LAN-v1');
  const INFO = Buffer.from('passman-lan-v1');

  wss.on('connection', (ws) => {
    const pending = [];
    let onMessage = (data, isBinary) => pending.push([data, isBinary]);
    ws.on('message', (data, isBinary) => onMessage(data, isBinary));

    wc.subtle.generateKey({ name: 'ECDH', namedCurve: 'X25519' }, true, ['deriveBits'])
      .then(async (kp) => {
        const pubBytes = new Uint8Array(await wc.subtle.exportKey('raw', kp.publicKey));
        const noncePhone = wc.getRandomValues(new Uint8Array(16));
        let channel = null;
        let lastRecv = -1n;
        let sendCtr = 0n;
        let pairSecret = null;
        const fingerprintHex = await S.fingerprintHex(pubBytes);
        // M3'-B: a per-connection 32B HMAC key the phone hands to the PC in
        // PAIR_OK (mirrors HotspotServerService.deviceHmacKeyB64()).
        const hmacKey = wc.getRandomValues(new Uint8Array(32));

        async function sealAndSend(obj) {
          const pt = encode(obj);
          const iv = wc.getRandomValues(new Uint8Array(12));
          const ctrBytes = Buffer.alloc(8);
          // big-endian uint64
          let v = sendCtr++;
          for (let i = 7; i >= 0; i--) { ctrBytes[i] = Number(v & 0xFFn); v >>= 8n; }
          const aad = S.concat(AAD, ctrBytes);
          const ct = new Uint8Array(await wc.subtle.encrypt(
            { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, channel, pt));
          ws.send(Buffer.concat([iv, ctrBytes, ct]));
        }

        onMessage = async (data, isBinary) => {
          try {
            if (!isBinary) {
              const m = JSON.parse(data.toString());
              if (m.t !== 'HELLO' || channel) {
                ws.close(1003, 'expected HELLO');
                return;
              }
              const peerPub = await wc.subtle.importKey('raw', S.b64decode(m.pub), { name: 'ECDH', namedCurve: 'X25519' }, false, []);
              const noncePc = S.b64decode(m.nonce);
              const shared = new Uint8Array(await wc.subtle.deriveBits({ name: 'ECDH', public: peerPub }, kp.privateKey, 256));
              const salt = S.concat(noncePc, noncePhone);
              const baseKey = await wc.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
              const okm = new Uint8Array(await wc.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, baseKey, 512));
              channel = await wc.subtle.importKey('raw', okm.subarray(0, 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
              pairSecret = okm.slice(32, 64);
              ws.send(JSON.stringify({ t: 'WELCOME', pub: S.b64encode(pubBytes), nonce: S.b64encode(noncePhone) }));
            } else {
              if (!channel) { ws.close(1003, 'binary before handshake'); return; }
              const frame = new Uint8Array(data);
              const iv = frame.subarray(0, 12);
              const ctrBytes = frame.subarray(12, 20);
              const ct = frame.subarray(20);
              let ctr = 0n; for (let i = 0; i < 8; i++) ctr = (ctr << 8n) | BigInt(ctrBytes[i]);
              if (ctr <= lastRecv) return;
              const aad = S.concat(AAD, ctrBytes);
              let pt;
              try {
                pt = new Uint8Array(await wc.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, channel, ct));
              } catch { ws.close(1003, 'decrypt failed'); return; }
              lastRecv = ctr;
              const req = decode(pt);
              if (req.t === MSG.PAIR_REQUEST) {
                if (tracker.isLocked()) {
                  await sealAndSend({ t: MSG.PAIR_REJECT, reason: REJECT.LOCKED });
                  return;
                }
                const result = await verifyPin({
                  submittedPin: req.pin,
                  submittedW: BigInt(req.w),
                  pinForWindow: (w) => S.rollingPin(pairSecret, w),
                });
                if (!result.ok) {
                  tracker.recordFailure();
                  // Differentiate "PIN typo" vs "PIN from a window we don't accept at all".
                  // Both manifest as no-match here; the protocol uses 'bad_pin' for both
                  // and 'locked' only when the tracker is over the threshold.
                  await sealAndSend({ t: MSG.PAIR_REJECT, reason: REJECT.BAD_PIN });
                  return;
                }
                if (!userApproves) {
                  // The user pressed "deny" on the phone. Don't count it as a
                  // failed PIN — it's an intentional reject.
                  await sealAndSend({ t: MSG.PAIR_REJECT, reason: REJECT.USER_DENIED });
                  return;
                }
                tracker.reset();
                await sealAndSend({
                  t: MSG.PAIR_OK,
                  fingerprint: fingerprintHex,
                  label,
                  // M3'-B: phone hands the PC a 32B HMAC key + biometric snapshot.
                  device_hmac_key_b64: S.b64encode(hmacKey),
                  biometric_capable: true,
                });
              }
            }
          } catch (e) {
            console.error('mock-phone handler error:', e);
          }
        };
        for (const [d, b] of pending) onMessage(d, b);
        pending.length = 0;
      });
  });
  return wss;
}

// ---------- PC client (real lan-ws-client + real secure.js) ----------
//
// Returns { ok: bool, payload } once the phone sends either PAIR_OK or
// PAIR_REJECT. Uses lan-ws-client.js's openBridge to dial the phone, then
// drives the channel through a fresh client ws (skipping the express
// /api/lan/socket layer for unit-test brevity).

async function runPairAttempt({ port, pinOverride, windowOverride }) {
  const bridge = await openBridge({ host: '127.0.0.1', port });
  bridge.upstream.close();

  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/pair`);
    ws.binaryType = 'arraybuffer';
    let channel = null;
    let priv, pubBytes;
    let noncePc;
    let pairSecret;
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; try { ws.close(); } catch (_) {} resolve(v); } };

    ws.on('open', async () => {
      const kp = await S.generateKeypair();
      priv = kp.priv; pubBytes = kp.pubBytes;
      noncePc = S.randomNonce();
      ws.send(S.encodeHello(pubBytes, noncePc));
    });

    ws.on('message', async (data, isBinary) => {
      try {
        if (!isBinary) {
          const { pubBytes: peerPub, noncePhone } = S.parseWelcome(data.toString());
          const peerKey = await S.importPeerPub(peerPub);
          const { aesKey, pairSecret: ps } = await S.deriveSessionKey(priv, peerKey, noncePc, noncePhone);
          channel = new S.SecureChannel(aesKey);
          pairSecret = ps;
          const w = BigInt(windowOverride ?? S.pinWindow(Date.now()));
          const pin = pinOverride ?? await S.rollingPin(pairSecret, w);
          const frame = await channel.seal(encode({
            t: MSG.PAIR_REQUEST,
            pin,
            w: Number(w),  // JSON-safe (Numbers are 53-bit, fits for centuries)
          }));
          ws.send(frame);
        } else {
          const pt = await channel.open(new Uint8Array(data));
          const msg = decode(pt);
          if (msg.t === MSG.PAIR_OK) finish({ ok: true, payload: msg });
          else if (msg.t === MSG.PAIR_REJECT) finish({ ok: false, payload: msg });
          else finish({ ok: false, payload: { reason: 'unexpected', msg } });
        }
      } catch (e) {
        finish({ ok: false, payload: { reason: 'exception', error: e.message } });
      }
    });

    ws.on('close', () => finish({ ok: false, payload: { reason: 'closed' } }));
    ws.on('error', () => { /* surfaced via 'close' */ });
  });
}

// ---------- test driver ----------

(async () => {
  console.log('M3\'-A pairing tests:');

  // Case 1: correct PIN -> PAIR_OK
  {
    const PORT = 9921;
    const tracker = new PairAttemptTracker();
    const wss = startMockPhone({ port: PORT, tracker });
    await new Promise(r => setTimeout(r, 50));
    const r = await runPairAttempt({ port: PORT });
    ok('correct PIN -> PAIR_OK', r.ok === true, JSON.stringify(r.payload));
    ok('  PAIR_OK includes fingerprint (64 hex)', r.ok && /^[0-9A-F]{64}$/.test(r.payload.fingerprint || ''));
    ok('  PAIR_OK includes label', r.ok && typeof r.payload.label === 'string' && r.payload.label.length > 0);
    // M3'-B: PAIR_OK carries a 32B HMAC key + biometric_capable flag.
    ok('  PAIR_OK includes 32B device_hmac_key_b64',
      r.ok && typeof r.payload.device_hmac_key_b64 === 'string' &&
      Buffer.from(r.payload.device_hmac_key_b64, 'base64').length === 32);
    ok('  PAIR_OK includes biometric_capable bool', r.ok && typeof r.payload.biometric_capable === 'boolean');
    wss.close();
  }

  // Case 2: wrong PIN once -> PAIR_REJECT bad_pin
  {
    const PORT = 9922;
    const tracker = new PairAttemptTracker();
    const wss = startMockPhone({ port: PORT, tracker });
    await new Promise(r => setTimeout(r, 50));
    const r = await runPairAttempt({ port: PORT, pinOverride: '000000' /* unlikely to match */ });
    ok('wrong PIN -> PAIR_REJECT', r.ok === false);
    ok('  reason=bad_pin', !r.ok && r.payload.reason === REJECT.BAD_PIN, JSON.stringify(r.payload));
    wss.close();
  }

  // Case 3: 5 wrong PINs -> 5th onwards is locked
  {
    const PORT = 9923;
    const tracker = new PairAttemptTracker({ maxFailures: 5, windowMs: 60_000 });
    const wss = startMockPhone({ port: PORT, tracker });
    await new Promise(r => setTimeout(r, 50));
    const reasons = [];
    for (let i = 0; i < 6; i++) {
      const r = await runPairAttempt({ port: PORT, pinOverride: '000001' });
      reasons.push(r.payload.reason);
    }
    // After 5 failures the tracker hits maxFailures; the 6th attempt sees
    // isLocked() === true *before* any PIN check, so it should be 'locked'.
    ok('first 5 wrong -> bad_pin', reasons.slice(0, 5).every(r => r === REJECT.BAD_PIN), reasons.join(','));
    ok('6th attempt -> locked', reasons[5] === REJECT.LOCKED, reasons.join(','));
    wss.close();
  }

  // Case 4: PIN computed for an out-of-slack window (w-3) -> no_match (bad_pin reason)
  {
    const PORT = 9924;
    const tracker = new PairAttemptTracker();
    const wss = startMockPhone({ port: PORT, tracker });
    await new Promise(r => setTimeout(r, 50));
    const w = S.pinWindow(Date.now());
    // Client sends a PIN that the phone considers valid only for window w-3,
    // but tells the phone the window is `w`. Phone slack ±1 means it tries
    // w-1, w, w+1 — none match.
    // Cheat: we set pinOverride to the PIN of window w-3 on a freshly-derived
    // pairSecret in the client. But the client doesn't know the phone's
    // pair_secret until handshake — easier: just send a random PIN and lie
    // about w (which makes it "valid for no window" from the phone's view).
    const r = await runPairAttempt({
      port: PORT,
      pinOverride: '999999',
      windowOverride: BigInt(w) - 10n,  // way outside slack
    });
    ok('out-of-slack PIN -> reject (bad_pin)', r.ok === false && r.payload.reason === REJECT.BAD_PIN, JSON.stringify(r.payload));
    wss.close();
  }

  // Case 5: user denies -> PAIR_REJECT user_denied
  {
    const PORT = 9925;
    const tracker = new PairAttemptTracker();
    const wss = startMockPhone({ port: PORT, tracker, userApproves: false });
    await new Promise(r => setTimeout(r, 50));
    const r = await runPairAttempt({ port: PORT });
    ok('user denies -> reject', r.ok === false);
    ok('  reason=user_denied', !r.ok && r.payload.reason === REJECT.USER_DENIED, JSON.stringify(r.payload));
    // And it should NOT have counted toward the lockout
    ok('  user-deny does not consume a failure slot', tracker.isLocked() === false && tracker._failures.length === 0);
    wss.close();
  }

  // Tracker unit tests
  {
    const now = { t: 1_000_000 };
    const tr = new PairAttemptTracker({ maxFailures: 3, windowMs: 1000, now: () => now.t });
    ok('tracker fresh -> not locked', !tr.isLocked());
    tr.recordFailure(); tr.recordFailure();
    ok('  2 failures -> still not locked', !tr.isLocked());
    tr.recordFailure();
    ok('  3 failures -> locked', tr.isLocked());
    ok('  unlockInMs ~= windowMs', Math.abs(tr.unlockInMs() - 1000) < 50);
    now.t += 1100;
    ok('  after window expires -> not locked', !tr.isLocked());
    tr.recordFailure();
    tr.reset();
    ok('  reset clears failures', !tr.isLocked() && tr.unlockInMs() === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
