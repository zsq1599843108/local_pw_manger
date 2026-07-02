package com.passman.pair

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.SecureRandom

/**
 * M3'-B B-5 (方案 C) — EncryptedSharedPreferences wrapper for the fallback-PIN
 * secrets (design §8).
 *
 * Stores, per phone identity:
 *   device_pin_key           32B raw K_pin (the no-bio-gate HMAC key; ≠ K_bio)
 *   fallback_pin.hash        32B PBKDF2-HMAC-SHA256(pin, salt, iters)
 *   fallback_pin.salt        16B
 *   fallback_pin.iterations  int (stored so we can raise it later without
 *                            invalidating already-set PINs)
 *   fallback_lockout.failures  long[] failure timestamps (FallbackPinTracker)
 *
 * Why ESP and not Keystore: K_pin must be reachable when fingerprints are
 * unavailable (that's its entire purpose), so it cannot sit behind a bio gate.
 * ESP is TEE-backed at rest but unlocked by the app's own master key — no
 * biometric requirement. K_bio, by contrast, NEVER appears here (it stays
 * AndroidKeyStore-only; writing it to ESP would let a rooted phone compute a
 * K_bio HMAC without a fingerprint, dismantling the bio gate — design §7).
 *
 * Persistence across service restarts is mandatory for the lockout: a restart
 * must NOT hand an attacker fresh tries (design §8). K_pin persistence is
 * forward-looking for M4' (persistent phone identity); within M3'-A's
 * ephemeral-keypair model a reconnect changes the fingerprint anyway, but
 * keeping K_pin stable avoids needless churn when M4' lands.
 *
 * Android-only: ESP + KeyStore master key require a device; the pure-JVM crypto
 * (PBKDF2, HMAC, tracker) is covered by FallbackPinTest. This class is
 * exercised on-device in B-6.
 */
class FallbackSecretStore(private val context: Context) {

    private val prefs: SharedPreferences by lazy { createPrefs(context) }

    private fun createPrefs(ctx: Context): SharedPreferences {
        val masterKey = MasterKey.Builder(ctx)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            ctx,
            FILENAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    /**
     * Return the stored K_pin, minting+persisting a fresh 32B key on first call.
     * Idempotent: a second pairing reuses the same K_pin so the PC's stored copy
     * stays valid (a silent K_pin rotation would force a re-pair, design §9).
     */
    @Synchronized
    fun getOrCreatePinKey(): ByteArray {
        val existing = prefs.getString(KEY_PIN_KEY, null)?.let { b64Decode(it) }
        if (existing != null && existing.size == Crypto.KEY_SIZE) return existing
        val fresh = ByteArray(Crypto.KEY_SIZE).also { SecureRandom().nextBytes(it) }
        prefs.edit().putString(KEY_PIN_KEY, b64Encode(fresh)).apply()
        return fresh
    }

    /** Stored K_pin, or null if none has been minted yet. */
    @Synchronized
    fun loadPinKey(): ByteArray? =
        prefs.getString(KEY_PIN_KEY, null)?.let { b64Decode(it) }
            ?.takeIf { it.size == Crypto.KEY_SIZE }

    /** True iff a fallback PIN has been set (hash + salt both present). */
    @Synchronized
    fun hasFallbackPin(): Boolean =
        prefs.contains(KEY_PIN_HASH) && prefs.contains(KEY_PIN_SALT)

    /**
     * Set the 4-digit fallback PIN: fresh salt, PBKDF2 hash, persist. Overwrites
     * any prior PIN. Wipes the lockout (a freshly-set PIN is a fresh start).
     */
    @Synchronized
    fun setFallbackPin(pin: String) {
        val salt = Crypto.randomFallbackSalt()
        val hash = Crypto.hashFallbackPin(pin, salt)
        prefs.edit()
            .putString(KEY_PIN_HASH, b64Encode(hash))
            .putString(KEY_PIN_SALT, b64Encode(salt))
            .putInt(KEY_PIN_ITERS, Crypto.FALLBACK_PIN_ITERATIONS)
            .remove(KEY_LOCKOUT)         // reset lockout on (re)setting PIN
            .apply()
    }

    /**
     * Verify a submitted PIN against the stored hash. Returns one of:
     *   VERIFIED  — match; the tracker is reset (correct PIN clears the slate)
     *   REJECTED  — mismatch; a failure is recorded and the lockout persisted
     *   LOCKED    — the tracker is currently locked (3 fails / 24h, §7); no PIN
     *               check is performed, so a locked channel can't be probed
     *   NOT_SET   — no fallback PIN has been configured yet
     *
     * The caller (HotspotServerService) maps VERIFIED → sign with K_pin,
     * REJECTED/LOCKED → RESPONSE error, NOT_SET → RESPONSE error.
     */
    @Synchronized
    fun verifyFallbackPin(pin: String, tracker: Crypto.FallbackPinTracker): PinCheck {
        if (!hasFallbackPin()) return PinCheck.NOT_SET
        if (tracker.isLocked()) {
            persistLockout(tracker)
            return PinCheck.LOCKED
        }
        val salt = b64Decode(prefs.getString(KEY_PIN_SALT, null) ?: return PinCheck.NOT_SET)
        val expected = b64Decode(prefs.getString(KEY_PIN_HASH, null) ?: return PinCheck.NOT_SET)
        val iters = prefs.getInt(KEY_PIN_ITERS, Crypto.FALLBACK_PIN_ITERATIONS)
        val ok = Crypto.verifyFallbackPin(pin, salt, expected, iters)
        if (ok) {
            tracker.reset()
        } else {
            tracker.recordFailure()
        }
        persistLockout(tracker)
        return if (ok) PinCheck.VERIFIED else PinCheck.REJECTED
    }

    /** Persist the tracker's failure timestamps so a restart preserves lockout. */
    @Synchronized
    fun persistLockout(tracker: Crypto.FallbackPinTracker) {
        val snap = tracker.snapshot()
        val encoded = snap.joinToString(",") { it.toString() }
        prefs.edit().putString(KEY_LOCKOUT, encoded).apply()
    }

    /** Reload failure timestamps into the tracker (call once on service start). */
    @Synchronized
    fun restoreLockout(tracker: Crypto.FallbackPinTracker) {
        val s = prefs.getString(KEY_LOCKOUT, null) ?: return
        if (s.isBlank()) return
        val ts = s.split(",").mapNotNull { it.trim().toLongOrNull() }.toLongArray()
        if (ts.isNotEmpty()) tracker.restore(ts)
    }

    enum class PinCheck { VERIFIED, REJECTED, LOCKED, NOT_SET }

    private fun b64Encode(b: ByteArray): String = Base64.encodeToString(b, Base64.NO_WRAP)
    private fun b64Decode(s: String): ByteArray = Base64.decode(s, Base64.NO_WRAP)

    companion object {
        private const val FILENAME = "passman_fallback"
        private const val KEY_PIN_KEY = "device_pin_key"
        private const val KEY_PIN_HASH = "fallback_pin.hash"
        private const val KEY_PIN_SALT = "fallback_pin.salt"
        private const val KEY_PIN_ITERS = "fallback_pin.iterations"
        private const val KEY_LOCKOUT = "fallback_lockout.failures"
    }
}
