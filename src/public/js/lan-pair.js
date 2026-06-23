// Wi-Fi hotspot pairing UI logic for phone.html (M1' PoC + M2' encrypted channel).
//
// Plain script (not a module) so the inline onclick="startLanProbe()" can
// call it. Uses fetch against /api/lan/probe; the Express handler proxies
// to the phone's Ktor server inside the hotspot LAN.
//
// M2' adds: after a successful probe, open /api/lan/socket (Node bridges to
// the phone's /socket), run the ECDH handshake over text frames, then send
// an encrypted PING and expect an encrypted PONG back.

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
          const { aesKey } = await S.deriveSessionKey(priv, peerKey, noncePc, noncePhone);
          channel = new S.SecureChannel(aesKey);
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
          } else {
            done(false, 'unexpected message type: ' + msg.t);
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

  window.startLanProbe = startLanProbe;
})();
