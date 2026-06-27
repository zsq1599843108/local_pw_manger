// Wi-Fi hotspot pairing UI logic for phone.html (M1' PoC + M2' encrypted channel + M3'-A pairing).
//
// Plain script (not a module) so the inline onclick="startLanProbe()" can
// call it. Uses fetch against /api/lan/probe; the Express handler proxies
// to the phone's Ktor server inside the hotspot LAN.
//
// M2' adds: after a successful probe, open /api/lan/socket (Node bridges to
// the phone's /socket), run the ECDH handshake over text frames, then send
// an encrypted PING and expect an encrypted PONG back.
//
// M3'-A adds: after the encrypted channel is live, prompt the user for the
// 6-digit rolling PIN shown on the phone screen, send a PAIR_REQUEST encrypted
// over the channel, and on PAIR_OK persist the device's fingerprint+pubkey to
// the PC via POST /api/lan/devices/trust.

(function () {
  const btn  = document.getElementById('lan-btn');
  const log  = document.getElementById('lan-log');
  const hostInput = document.getElementById('lan-host');
  const portInput = document.getElementById('lan-port');

  // Filled after probe succeeds so the "Open encrypted channel" path can
  // reuse the validated host/port without re-reading the inputs.
  let lastGood = null;

  function append(line) {
    if (!log) return;
    log.style.display = 'block';
    const stamp = new Date().toISOString().slice(11, 19);
    log.textContent += `[${stamp}] ${line}\n`;
    log.scrollTop = log.scrollHeight;
  }

  async function startLanProbe() {
    if (!btn) return;
    const host = (hostInput?.value || '192.168.43.1').trim();
    const port = Number(portInput?.value || 9876);

    btn.disabled = true;
    log.textContent = '';
    log.style.display = 'block';
    append(`→ POST /api/lan/probe { host: ${host}, port: ${port} }`);

    try {
      const t0 = performance.now();
      const resp = await fetch('/api/lan/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, port }),
      });
      const data = await resp.json();
      const t1 = performance.now();
      const dur = (t1 - t0).toFixed(0);

      if (data.ok) {
        append(`✓ pong in ${dur}ms — ${data.app} v${data.ver}, server uptime ${formatMs(data.uptimeMs)}`);
        append(`📡 phone clock skew vs PC: ${(data.time - Date.now()).toString().padStart(5)} ms`);
        lastGood = { host: data.host, port: data.port };
        append('▶ opening encrypted channel (M2\')…');
        await openEncryptedChannel(lastGood.host, lastGood.port);
      } else {
        append(`❌ probe failed [${data.code}]: ${data.error}`);
        if (data.hint) append(`💡 ${data.hint}`);
      }
    } catch (err) {
      append(`❌ ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
      console.error(err);
    } finally {
      btn.disabled = false;
    }
  }

  /**
   * M2' handshake + encrypted PING/PONG.
   *
   * Flow (text frames = JSON, binary = encrypted):
   *   1. PC generates X25519 keypair + 16B nonce, sends HELLO (text)
   *   2. phone replies WELCOME (text) with its pubkey + nonce
   *   3. both derive session_key; PC sends encrypted PING (binary)
   *   4. phone replies encrypted PONG (binary)
   *
   * We expect PONG within 3s, else the channel is considered dead.
   */
  async function openEncryptedChannel(host, port) {
    const S = window.PassManSecure;
    if (!S) { append('❌ secure.js failed to load'); return; }

    const url = `ws://${location.host}/api/lan/socket?host=${encodeURIComponent(host)}&port=${port}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    const { priv, pubBytes } = await S.generateKeypair();
    const noncePc = S.randomNonce();

    let channel = null;
    let pongTimer = null;
    let settled = false;

    const done = (ok, msg) => {
      if (settled) return;
      settled = true;
      if (pongTimer) clearTimeout(pongTimer);
      append((ok ? '✓ ' : '❌ ') + msg);
      // Leave the socket open on success so M3' can reuse it; close on failure.
      if (!ok) { try { ws.close(); } catch (_) {} }
    };

    ws.onopen = () => {
      append('↗ WS open to Node bridge; sending HELLO (X25519 pub + nonce)');
      ws.send(S.encodeHello(pubBytes, noncePc));
      // Safety net: if no PONG in 3s, fail.
      pongTimer = setTimeout(() => done(false, 'timed out waiting for encrypted PONG (3s)'), 3000);
    };

    ws.onmessage = async (ev) => {
      try {
        if (typeof ev.data === 'string') {
          // Handshake text frame.
          const { pubBytes: peerPub, noncePhone } = S.parseWelcome(ev.data);
          append('← WELCOME: phone pubkey received, deriving session_key');
          const peerKey = await S.importPeerPub(peerPub);
          const { aesKey, pairSecret } = await S.deriveSessionKey(priv, peerKey, noncePc, noncePhone);
          channel = new S.SecureChannel(aesKey);
          // Stash for the pairing step that follows the M2' PONG.
          openEncryptedChannel._lastChannel = channel;
          openEncryptedChannel._lastPairSecret = pairSecret;
          openEncryptedChannel._lastPeerPub = peerPub;
          openEncryptedChannel._lastWs = ws;
          // Send encrypted PING.
          const ping = new TextEncoder().encode(JSON.stringify({ t: 'PING', ts: Date.now() }));
          const frame = await channel.seal(ping);
          append('→ sending encrypted PING (' + frame.byteLength + 'B frame)');
          ws.send(frame);
        } else {
          // Binary encrypted frame.
          if (!channel) { done(false, 'got binary frame before handshake finished'); return; }
          const pt = await channel.open(new Uint8Array(ev.data));
          const msg = JSON.parse(new TextDecoder().decode(pt));
          if (msg.t === 'PONG') {
            const rtt = Date.now() - (msg.echoTs ?? msg.ts ?? Date.now());
            done(true, `encrypted PONG received — RTT ${rtt}ms, M2' channel live 🎉`);
            // M3'-A: proceed to PIN entry on the same live channel. We do this
            // here (not in done()) so a future caller of openEncryptedChannel
            // for other reasons doesn't auto-trigger pairing.
            await promptAndPair();
          } else if (msg.t === 'PAIR_OK' || msg.t === 'PAIR_REJECT') {
            // Re-route to the pairing handler — PAIR_* replies arrive on the
            // same onmessage. The pairing handler installs its own one-shot
            // resolver on openEncryptedChannel._pairReplyResolver.
            const resolver = openEncryptedChannel._pairReplyResolver;
            if (resolver) {
              openEncryptedChannel._pairReplyResolver = null;
              resolver(msg);
            } else {
              append(`(unexpected ${msg.t} with no awaiter — dropping)`);
            }
          } else if (msg.t === 'RESPONSE' || msg.t === 'FALLBACK_REQ') {
            // M3'-B: biometric CHALLENGE replies arrive on the same channel.
            // challenge-ui.js installs a one-shot resolver before sending the
            // CHALLENGE frame; route the reply there.
            const cResolver = openEncryptedChannel._challengeReplyResolver;
            if (cResolver) {
              openEncryptedChannel._challengeReplyResolver = null;
              cResolver(msg);
            } else {
              append(`(unexpected ${msg.t} with no awaiter — dropping)`);
            }
          } else {
            append(`(ignoring unexpected msg ${msg.t})`);
          }
        }
      } catch (err) {
        done(false, `channel error: ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
      }
    };

    ws.onerror = () => { /* close handler will report */ };
    ws.onclose = (ev) => {
      if (!settled) {
        let hint = '';
        try { hint = ev.reason ? ' — ' + ev.reason : ''; } catch (_) {}
        done(false, `WS closed (code ${ev.code})${hint}`);
      }
    };
  }

  function formatMs(ms) {
    if (ms == null) return '?';
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
  }

  // ---- M3'-A pairing flow on the already-live encrypted channel ----
  //
  // Prompts the user for the 6-digit PIN currently shown on the phone screen,
  // sends PAIR_REQUEST (encrypted), awaits PAIR_OK / PAIR_REJECT, and on
  // success posts the device fingerprint + pubkey to /api/lan/devices/trust
  // so the server persists the TOFU decision.
  async function promptAndPair() {
    const S = window.PassManSecure;
    const channel    = openEncryptedChannel._lastChannel;
    const pairSecret = openEncryptedChannel._lastPairSecret;
    const peerPub    = openEncryptedChannel._lastPeerPub;
    const ws         = openEncryptedChannel._lastWs;
    if (!channel || !pairSecret || !peerPub || !ws) {
      append('❌ pairing prereqs missing (channel/pairSecret/peerPub)');
      return;
    }

    const pin = window.prompt(
      'Enter the 6-digit PIN shown on the phone screen.\n' +
      '(The PIN refreshes every 30 seconds — type whichever value is on screen now.)'
    );
    if (!pin) { append('user cancelled PIN entry'); return; }
    if (!/^\d{6}$/.test(pin)) { append('❌ PIN must be exactly 6 digits'); return; }

    const w = S.pinWindow(Date.now());
    const req = new TextEncoder().encode(JSON.stringify({ t: 'PAIR_REQUEST', pin, w: Number(w) }));
    const frame = await channel.seal(req);

    // One-shot resolver for the next PAIR_* reply — the onmessage handler
    // (above) routes PAIR_OK / PAIR_REJECT here.
    const reply = await new Promise((resolve) => {
      openEncryptedChannel._pairReplyResolver = resolve;
      append(`→ PAIR_REQUEST sent (pin=••••, w=${w})`);
      ws.send(frame);
      // 30s ceiling — gives the user time to press TRUST on the phone.
      setTimeout(() => {
        if (openEncryptedChannel._pairReplyResolver === resolve) {
          openEncryptedChannel._pairReplyResolver = null;
          resolve({ t: 'PAIR_REJECT', reason: 'timeout' });
        }
      }, 30000);
    });

    if (reply.t !== 'PAIR_OK') {
      append(`❌ pairing rejected: ${reply.reason ?? '(no reason)'}`);
      return;
    }
    append(`✓ PAIR_OK from phone — fingerprint=${reply.fingerprint?.slice(0, 16)}…, label="${reply.label}"`);
    // Stash the fingerprint so challenge-ui.js can target this device on the
    // same live channel without re-deriving it.
    openEncryptedChannel._lastFingerprint = reply.fingerprint;

    // M3'-B: the phone may carry two keys in PAIR_OK — K_bio (device_hmac_key,
    // bio-gated CHALLENGE) and K_pin (device_pin_key, the §7 方案-C fallback
    // key). Validate each is exactly 32 bytes before forwarding; a malformed
    // value is dropped (logged) so the device just pairs without it and
    // back-fills later via ENROLL (design §9).
    const valid32B64 = (s) => {
      if (typeof s !== 'string') return false;
      try { return atob(s).length === 32; } catch (_) { return false; }
    };
    let hmacKeyB64;
    if (typeof reply.device_hmac_key_b64 === 'string') {
      if (valid32B64(reply.device_hmac_key_b64)) {
        hmacKeyB64 = reply.device_hmac_key_b64;
        append(`🔑 device HMAC key received (biometric_capable=${reply.biometric_capable === true})`);
      } else {
        append('⚠️ PAIR_OK device_hmac_key_b64 malformed — pairing without it');
      }
    } else {
      append('ℹ️ phone sent no HMAC key — biometric challenge unavailable until ENROLL');
    }
    let pinKeyB64;
    if (typeof reply.device_pin_key_b64 === 'string') {
      if (valid32B64(reply.device_pin_key_b64)) {
        pinKeyB64 = reply.device_pin_key_b64;
        append('🔑 device PIN-fallback key received');
      } else {
        append('⚠️ PAIR_OK device_pin_key_b64 malformed — pairing without fallback');
      }
    }

    // Sanity check: the fingerprint the phone signed had better match what we
    // compute from its X25519 pubkey ourselves. If not, something is very wrong
    // (channel hijack, server bug) and we refuse to persist.
    const localFp = await S.fingerprintHex(peerPub);
    if (localFp !== reply.fingerprint) {
      append(`❌ fingerprint mismatch: phone said ${reply.fingerprint?.slice(0, 16)}… but we derive ${localFp.slice(0, 16)}…`);
      return;
    }

    // Persist on the PC — server validates fingerprint matches pubkey again.
    try {
      const resp = await fetch('/api/lan/devices/trust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fingerprint: reply.fingerprint,
          pubkey_b64: btoa(String.fromCharCode(...peerPub)),
          label: reply.label,
          ...(hmacKeyB64 ? { device_hmac_key_b64: hmacKeyB64 } : {}),
          ...(pinKeyB64 ? { device_pin_key_b64: pinKeyB64 } : {}),
        }),
      });
      const j = await resp.json();
      if (j.ok) append(`💾 persisted: status=${j.status}, label="${j.label}"`);
      else      append(`❌ persistence failed: ${j.error}`);
    } catch (err) {
      append(`❌ trust POST failed: ${err?.message ?? err}`);
    }
  }

  window.startLanProbe = startLanProbe;

  // M3'-B: expose the live channel stash so challenge-ui.js can run a CHALLENGE
  // on the same connection that paired the device, and install its one-shot
  // resolver onto the openEncryptedChannel function the onmessage handler reads.
  window.PassManChannelStash = () => ({
    channel:     openEncryptedChannel._lastChannel || null,
    ws:          openEncryptedChannel._lastWs || null,
    peerPub:     openEncryptedChannel._lastPeerPub || null,
    fingerprint: openEncryptedChannel._lastFingerprint || null,
  });
  window.openEncryptedChannelStashSetChallengeResolver = (fn) => {
    openEncryptedChannel._challengeReplyResolver = fn;
  };
})();
