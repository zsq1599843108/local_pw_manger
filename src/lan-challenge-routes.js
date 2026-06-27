// lan-challenge-routes.js — Express routes for the M3'-B biometric
// CHALLENGE/RESPONSE flow (design §3/§6). Split out of server.js so tests can
// mount it onto a throwaway express() + in-memory sqlite.
//
// The browser never sees the device_hmac_key. It asks us to MINT a challenge,
// forwards the opaque CHALLENGE frame to the phone over the live SecureChannel,
// then hands the phone's RESPONSE back to us to VERIFY. All HMAC/freshness/
// replay/purpose decisions happen here (ChallengeVerifier).
//
// Endpoints:
//   POST /api/lan/challenge/create  { fingerprint, purpose }
//        -> { ok, id, frame } where frame is { t:'CHALLENGE', id, purpose, nonce_b64 }
//   POST /api/lan/challenge/verify  { response }
//        -> { ok, purpose, biometric_ok }  on success
//        -> { ok:false, reason, fallback_requested? }  otherwise
//   POST /api/lan/challenge/cancel  { id }
//        -> { ok:true }  (abandon a pending challenge; user declined fallback)

'use strict';

const pairedDevices = require('./paired-devices');
const { createChallenge, ChallengeVerifier, PURPOSE_BYTE } = require('./lan-challenge');

function looksLikeFingerprint(s) {
  return typeof s === 'string' && /^[0-9A-F]{64}$/.test(s);
}

/**
 * Mount the two /api/lan/challenge/* routes onto `app`. A single shared
 * ChallengeVerifier instance holds pending challenges + the replay window for
 * the process lifetime. Returns the verifier so callers/tests can inspect it.
 */
function installLanChallengeRoutes(app, db, { verifier } = {}) {
  const v = verifier || new ChallengeVerifier({ db });

  app.post('/api/lan/challenge/create', (req, res) => {
    const { fingerprint, purpose } = req.body || {};
    if (!looksLikeFingerprint(fingerprint)) {
      return res.status(400).json({ ok: false, error: 'bad_fingerprint' });
    }
    if (PURPOSE_BYTE[purpose] === undefined) {
      return res.status(400).json({ ok: false, error: 'bad_purpose' });
    }
    const device = pairedDevices.findByFingerprint(db, fingerprint);
    if (!device) {
      return res.status(404).json({ ok: false, error: 'unknown_device' });
    }
    if (device.device_hmac_key == null) {
      // Paired before it had a biometric key (§9) — no challenge possible until
      // the phone back-fills via ENROLL_HMAC.
      return res.status(409).json({ ok: false, error: 'no_hmac_key' });
    }

    const ch = createChallenge({ purpose });
    v.register({ id: ch.id, fingerprint, nonce: ch.nonce, purpose, createdAt: ch.createdAt });
    res.json({ ok: true, id: ch.id, frame: ch.frame });
  });

  app.post('/api/lan/challenge/verify', (req, res) => {
    const { response } = req.body || {};
    if (!response || typeof response !== 'object') {
      return res.status(400).json({ ok: false, error: 'bad_response' });
    }
    const result = v.verify(response);
    if (result.ok) {
      return res.json({
        ok: true,
        purpose: result.purpose,
        biometric_ok: result.biometricOk,
        fingerprint: result.fingerprint,
      });
    }
    return res.json({
      ok: false,
      reason: result.reason,
      ...(result.fallbackRequested ? { fallback_requested: true } : {}),
      ...(result.purpose ? { purpose: result.purpose } : {}),
    });
  });

  // Abandon a pending challenge — the browser calls this when the user declines
  // the fallback-PIN modal (design §7 step 2). Consuming the id stops a late
  // RESPONSE for it from being honoured. Idempotent: unknown ids are a no-op.
  app.post('/api/lan/challenge/cancel', (req, res) => {
    const { id } = req.body || {};
    v.cancel(id);
    res.json({ ok: true });
  });

  return v;
}

module.exports = { installLanChallengeRoutes, _internal: { looksLikeFingerprint } };
