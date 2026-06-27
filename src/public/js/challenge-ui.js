// challenge-ui.js — browser glue for the M3'-B biometric CHALLENGE flow.
//
// Plain script (not a module), like lan-pair.js. Reuses the live SecureChannel
// that lan-pair.js stashed on openEncryptedChannel._lastChannel/_lastWs after a
// successful pairing — the same connection that enrolled the phone's biometric
// HMAC key (M3'-A mints an ephemeral keypair per connection, so the key is only
// findable on this connection until persistent identity lands in M4').
//
// Flow (design §3/§6):
//   1. POST /api/lan/challenge/create { fingerprint, purpose } → { id, frame }.
//      The PC mints the nonce/id and remembers them; the device_hmac_key never
//      leaves the PC.
//   2. seal(frame) → send over the channel; the phone runs a BiometricPrompt and
//      replies RESPONSE { hmac_b64, ts, biometric_ok } or FALLBACK_REQ / error.
//   3. POST /api/lan/challenge/verify { response } → the PC checks the HMAC,
//      freshness, replay window, and the §7 fallback purpose policy.
//
// Exposed as window.PassManChallenge.runChallenge(purpose, fingerprint?).

(function () {
  // The pairing flow logs into #lan-log; reuse it so challenge output is visible.
  function append(line) {
    const log = document.getElementById('lan-log');
    if (!log) { console.log('[challenge]', line); return; }
    log.style.display = 'block';
    const stamp = new Date().toISOString().slice(11, 19);
    log.textContent += `[${stamp}] ${line}\n`;
    log.scrollTop = log.scrollHeight;
  }

  // Pull the channel/ws/peerPub/fingerprint that lan-pair.js stashed after
  // pairing, via the accessor it exposes on window.
  function liveContext() {
    return (window.PassManChannelStash && window.PassManChannelStash()) || null;
  }

  /**
   * Run one biometric challenge for `purpose` (unlock | sync_destructive |
   * export_plaintext). Returns the verify result object, or null on transport
   * failure. `fingerprint` defaults to the just-paired device's fingerprint.
   */
  async function runChallenge(purpose, fingerprint) {
    const S = window.PassManSecure;
    const ctx = liveContext();
    if (!S || !ctx || !ctx.channel || !ctx.ws) {
      append('❌ no live encrypted channel — pair via Wi-Fi first');
      return null;
    }
    const fp = fingerprint || ctx.fingerprint;
    if (!fp) { append('❌ no device fingerprint for challenge'); return null; }

    // 1. Ask the PC to mint a challenge.
    let id, frame;
    try {
      const resp = await fetch('/api/lan/challenge/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint: fp, purpose }),
      });
      const j = await resp.json();
      if (!j.ok) { append(`❌ challenge create failed: ${j.error}`); return j; }
      id = j.id; frame = j.frame;
      append(`→ CHALLENGE minted id=${id} purpose=${purpose}`);
    } catch (err) {
      append(`❌ challenge create error: ${err?.message ?? err}`);
      return null;
    }

    // 2. Forward the opaque frame to the phone over the live channel and await
    //    the RESPONSE / FALLBACK_REQ that lan-pair.js routes to our resolver.
    let reply;
    try {
      const sealed = await ctx.channel.seal(
        new TextEncoder().encode(JSON.stringify(frame))
      );
      reply = await new Promise((resolve) => {
        window.openEncryptedChannelStashSetChallengeResolver(resolve);
        append('→ CHALLENGE frame sent; awaiting biometric on phone…');
        ctx.ws.send(sealed);
        // 60s ceiling: the phone gives the BiometricPrompt headroom, but the
        // PC still enforces the real ±30s freshness on ts.
        setTimeout(() => resolve({ t: 'RESPONSE', id, error: 'pc_timeout' }), 60000);
      });
    } catch (err) {
      append(`❌ challenge send error: ${err?.message ?? err}`);
      return null;
    }

    // 3. Hand the phone's reply back to the PC for verification.
    try {
      const resp = await fetch('/api/lan/challenge/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: reply }),
      });
      const j = await resp.json();
      if (j.ok) {
        append(`✓ challenge OK — purpose=${j.purpose}, biometric=${j.biometric_ok}`);
      } else if (j.fallback_requested) {
        append('ℹ️ phone has no biometrics — fallback PIN path (B-5) required');
      } else {
        append(`❌ challenge rejected: ${j.reason}`);
      }
      return j;
    } catch (err) {
      append(`❌ challenge verify error: ${err?.message ?? err}`);
      return null;
    }
  }

  window.PassManChallenge = { runChallenge };
})();
