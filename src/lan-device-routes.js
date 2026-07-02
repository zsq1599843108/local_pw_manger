// lan-device-routes.js — Express routes for the M3'-A pairing persistence layer.
//
// Split out of server.js so we can mount the same routes onto a throwaway
// express() in tests, against an in-memory sqlite, and exercise the HTTP
// surface without spinning up the full app (and without scribbling on
// data/passwords.db).
//
// Endpoints:
//   POST /api/lan/devices/trust          { fingerprint, pubkey_b64, label, device_hmac_key_b64?, device_pin_key_b64? }
//   GET  /api/lan/devices
//   DELETE /api/lan/devices/:fingerprint
//
// The browser calls /trust after decrypting a PAIR_OK frame; the server is
// just a persistence target. The fingerprint MUST hash from the supplied
// pubkey or we reject — defends against a compromised page silently
// re-labelling an existing trusted device.
//
// M3'-B adds two optional 32B keys carried in the same PAIR_OK frame:
// `device_hmac_key_b64` (K_bio, bio-gated CHALLENGE) and `device_pin_key_b64`
// (K_pin, the §7 方案-C fallback key). Either may be omitted (back-filled later
// via ENROLL, design §9); a malformed value is rejected rather than dropped.

'use strict';

const pairedDevices = require('./paired-devices');

function looksLikeFingerprint(s) {
  return typeof s === 'string' && /^[0-9A-F]{64}$/.test(s);
}

function decodePubkey(b64) {
  if (typeof b64 !== 'string') return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    return buf.length === 32 ? buf : null;
  } catch (_) { return null; }
}

// Decode an optional 32B key (HMAC K_bio or PIN K_pin). Returns:
//   undefined  -> field absent (allowed; device pairs without that key)
//   Buffer(32) -> valid key
//   null       -> field present but malformed (caller must 400)
function decodeKey32(b64) {
  if (b64 === undefined || b64 === null) return undefined;
  if (typeof b64 !== 'string') return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    return buf.length === 32 ? buf : null;
  } catch (_) { return null; }
}

/**
 * Mount the three /api/lan/devices/* routes onto `app`, all using the supplied
 * better-sqlite3 `db` handle. Pure side-effect on app; returns nothing.
 */
function installLanDeviceRoutes(app, db) {
  app.post('/api/lan/devices/trust', (req, res) => {
    const { fingerprint, pubkey_b64, label, device_hmac_key_b64, device_pin_key_b64 } = req.body || {};
    if (!looksLikeFingerprint(fingerprint)) {
      return res.status(400).json({ ok: false, error: 'bad_fingerprint' });
    }
    const pubkey = decodePubkey(pubkey_b64);
    if (!pubkey) {
      return res.status(400).json({ ok: false, error: 'bad_pubkey' });
    }
    const hmacKey = decodeKey32(device_hmac_key_b64);
    if (hmacKey === null) {
      return res.status(400).json({ ok: false, error: 'bad_hmac_key' });
    }
    const pinKey = decodeKey32(device_pin_key_b64);
    if (pinKey === null) {
      return res.status(400).json({ ok: false, error: 'bad_pin_key' });
    }
    const computed = pairedDevices.fingerprintHex(pubkey);
    if (computed !== fingerprint) {
      return res.status(400).json({ ok: false, error: 'fingerprint_mismatch' });
    }
    const safeLabel = (typeof label === 'string' && label.length > 0 && label.length <= 64)
      ? label : 'Unnamed device';

    const existing = pairedDevices.findByFingerprint(db, fingerprint);
    if (existing) {
      if (!Buffer.from(existing.pubkey).equals(pubkey)) {
        // Same fingerprint, different pubkey — impossible barring a SHA-256
        // collision, but if it ever happens we refuse rather than overwrite.
        return res.status(409).json({ ok: false, error: 'pubkey_collision' });
      }
      pairedDevices.touchLastSeen(db, fingerprint);
      // Back-fill keys for a device trusted before it had them (§9). enroll*Key
      // only writes when the stored value is NULL — a re-pair that tries to swap
      // an existing key is silently ignored (treated as an attack by ENROLL),
      // not surfaced as an error.
      if (hmacKey && existing.device_hmac_key == null) {
        pairedDevices.enrollHmacKey(db, fingerprint, hmacKey);
      }
      if (pinKey && existing.device_pin_key == null) {
        pairedDevices.enrollPinKey(db, fingerprint, pinKey);
      }
      return res.json({ ok: true, status: 'already_trusted', fingerprint, label: existing.label });
    }
    try {
      pairedDevices.trustDevice(db, { fingerprint, label: safeLabel, pubkey, deviceHmacKey: hmacKey, devicePinKey: pinKey });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'db_error', detail: e.message });
    }
    res.json({ ok: true, status: 'trusted', fingerprint, label: safeLabel });
  });

  app.get('/api/lan/devices', (_req, res) => {
    const rows = pairedDevices.listDevices(db).map((r) => ({
      fingerprint: r.fingerprint,
      label: r.label,
      trusted_at: r.trusted_at,
      last_seen: r.last_seen,
      // Surface whether the device can do biometric CHALLENGE and/or the PIN
      // fallback without leaking key bytes. The challenge UI uses these to
      // decide which paths to offer.
      has_hmac_key: r.device_hmac_key != null,
      has_pin_key: r.device_pin_key != null,
      last_challenge_at: r.last_challenge_at ?? null,
      last_fallback_at: r.last_fallback_at ?? null,
    }));
    res.json({ ok: true, devices: rows });
  });

  app.delete('/api/lan/devices/:fingerprint', (req, res) => {
    const fp = req.params.fingerprint;
    if (!looksLikeFingerprint(fp)) {
      return res.status(400).json({ ok: false, error: 'bad_fingerprint' });
    }
    const removed = pairedDevices.revoke(db, fp);
    res.json({ ok: true, removed });
  });
}

module.exports = {
  installLanDeviceRoutes,
  // Exported for unit tests that want to assert validation pieces directly.
  _internal: { looksLikeFingerprint, decodePubkey, decodeKey32 },
};
