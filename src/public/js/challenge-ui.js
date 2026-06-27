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

  // Seal `obj`, install the one-shot reply resolver, send over the live channel,
  // and resolve with the phone's next RESPONSE / FALLBACK_REQ. Resolves to a
  // synthetic { error:'pc_timeout' } envelope after 60s so a silent phone can't
  // hang the flow — the PC still enforces real freshness on ts at verify time.
  async function sealSendAwait(ctx, obj, id) {
    const sealed = await ctx.channel.seal(
      new TextEncoder().encode(JSON.stringify(obj))
    );
    return new Promise((resolve) => {
      window.openEncryptedChannelStashSetChallengeResolver(resolve);
      ctx.ws.send(sealed);
      setTimeout(() => resolve({ t: 'RESPONSE', id, error: 'pc_timeout' }), 60000);
    });
  }

  // POST a phone reply to the PC verifier. Returns the parsed JSON result.
  async function postVerify(reply) {
    const resp = await fetch('/api/lan/challenge/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: reply }),
    });
    return resp.json();
  }

  // The §7 "soft door" gate: the user must MANUALLY confirm the fallback before
  // the PC will send FALLBACK_PIN. A tiny modal (built in JS so phone.html stays
  // untouched) resolves true on allow, false on deny/backdrop. Returns a Promise.
  function confirmFallback(purpose) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;' +
        'align-items:center;justify-content:center;z-index:9999';
      const box = document.createElement('div');
      box.style.cssText =
        'background:#fff;color:#222;max-width:340px;padding:20px;border-radius:10px;' +
        'font:14px/1.5 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.3)';
      box.innerHTML =
        '<h3 style="margin:0 0 8px">Fingerprint unavailable</h3>' +
        '<p style="margin:0 0 16px">This phone can’t use its fingerprint right now. ' +
        'Allow a 4-digit PIN on the phone instead?<br>' +
        '<small style="color:#888">PIN only unlocks — it can’t authorise destructive sync or plaintext export.</small></p>';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
      const deny = document.createElement('button');
      deny.textContent = 'Cancel';
      deny.style.cssText = 'padding:6px 14px';
      const allow = document.createElement('button');
      allow.textContent = 'Allow PIN';
      allow.style.cssText = 'padding:6px 14px;background:#2563eb;color:#fff;border:0;border-radius:6px';
      let done = false;
      const close = (val) => { if (done) return; done = true; overlay.remove(); resolve(val); };
      deny.onclick = () => close(false);
      allow.onclick = () => close(true);
      overlay.onclick = (e) => { if (e.target === overlay) close(false); };
      row.append(deny, allow);
      box.appendChild(row);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    });
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

    // 2. Forward the opaque frame to the phone and await the RESPONSE /
    //    FALLBACK_REQ that lan-pair.js routes to our one-shot resolver.
    let reply;
    try {
      append('→ CHALLENGE frame sent; awaiting biometric on phone…');
      reply = await sealSendAwait(ctx, frame, id);
    } catch (err) {
      append(`❌ challenge send error: ${err?.message ?? err}`);
      return null;
    }

    // 3. Verify with the PC. A FALLBACK_REQ leaves the challenge pending so the
    //    post-PIN RESPONSE can reuse it (see lan-challenge.js).
    let j;
    try {
      j = await postVerify(reply);
    } catch (err) {
      append(`❌ challenge verify error: ${err?.message ?? err}`);
      return null;
    }
    if (j.ok) {
      append(`✓ challenge OK — purpose=${j.purpose}, biometric=${j.biometric_ok}`);
      return j;
    }
    if (!j.fallback_requested) {
      append(`❌ challenge rejected: ${j.reason}`);
      return j;
    }

    // 4. Fallback PIN path (§7). The user must explicitly allow it; on deny we
    //    tell the PC to drop the pending challenge.
    const allow = await confirmFallback(j.purpose || purpose);
    if (!allow) {
      append('ℹ️ fallback declined by user');
      try {
        await fetch('/api/lan/challenge/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
      } catch (_) { /* best-effort; TTL prune reclaims it anyway */ }
      return { ok: false, reason: 'fallback_declined' };
    }

    // 5. Tell the phone to prompt for its 4-digit PIN; await the RESPONSE it
    //    sends after a local PIN match (biometric_ok:false), then verify.
    let pinReply;
    try {
      append('→ FALLBACK_PIN sent; enter the 4-digit PIN on the phone…');
      pinReply = await sealSendAwait(ctx, { t: 'FALLBACK_PIN', id }, id);
    } catch (err) {
      append(`❌ fallback send error: ${err?.message ?? err}`);
      return null;
    }
    try {
      const jf = await postVerify(pinReply);
      if (jf.ok) {
        append(`✓ fallback OK — purpose=${jf.purpose}, biometric=${jf.biometric_ok}`);
      } else {
        append(`❌ fallback rejected: ${jf.reason}`);
      }
      return jf;
    } catch (err) {
      append(`❌ fallback verify error: ${err?.message ?? err}`);
      return null;
    }
  }

  window.PassManChallenge = { runChallenge };
})();
