package com.passman.pair

import com.google.crypto.tink.subtle.Hkdf
import com.google.crypto.tink.subtle.X25519
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.Arrays
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * M2' (ADR-002) — phone-side crypto for the LAN encrypted channel.
 *
 * Byte-for-byte mirror of src/public/js/secure.js so the two endpoints are
 * interoperable. Algorithm stack:
 *   X25519 ECDH → HKDF-SHA256(info="passman-lan-v1") → AES-256-GCM
 *
 * Wire frame (one WebSocket binary message):
 *   ┌──────────┬───────────────┬──────────────────────────┐
 *   │ IV (12)  │ frame_ctr (8) │ ciphertext || tag (N+16) │
 *   └──────────┴───────────────┴──────────────────────────┘
 *                  big-endian      AES-GCM tag is appended by Cipher.doFinal
 *   GCM AAD = "PassMan-LAN-v1" || frame_ctr(8)
 *
 * Why javax.crypto.Cipher and NOT Tink AesGcmJce: Tink's AesGcmJce.encrypt()
 * *internally* generates a 12-byte IV and **prepends it** to the returned
 * bytes (returns `iv || ct || tag`). We need an IV-external API so we can
 * control where the IV lives on the wire (it must come before frame_ctr).
 * Cipher.getInstance("AES/GCM/NoPadding") gives us exactly that.
 *
 * Hkdf and X25519 from Tink are fine — they're pure functions, no envelope.
 *
 * frame_ctr is monotonic per direction; the receiver rejects any frame whose
 * counter is not strictly greater than the last accepted one (replay defence,
 * design §5).
 *
 * Handshake rides WebSocket *text* frames as JSON; encrypted data rides
 * *binary* frames:
 *   PC  -> phone : { "t":"HELLO",   "pub":b64, "nonce":b64 }
 *   phone -> PC  : { "t":"WELCOME", "pub":b64, "nonce":b64 }
 */
object Crypto {

    private const val INFO = "passman-lan-v1"
    private const val AAD_PREFIX = "PassMan-LAN-v1"
    private const val IV_SIZE = 12
    private const val CTR_SIZE = 8
    private const val NONCE_SIZE = 16
    private const val KEY_SIZE = 32          // AES-256
    private const val TAG_BITS = 128         // 16-byte tag, matches WebCrypto default
    private const val TAG_SIZE = TAG_BITS / 8

    /** X25519 private key (32B). Keep in memory only; persist via Tink AEAD in M4'. */
    data class Keypair(val privateKey: ByteArray, val publicKey: ByteArray) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Keypair) return false
            return privateKey.contentEquals(other.privateKey) &&
                    publicKey.contentEquals(other.publicKey)
        }
        override fun hashCode(): Int = 31 * privateKey.contentHashCode() + publicKey.contentHashCode()
    }

    fun generateKeypair(): Keypair {
        val priv = X25519.generatePrivateKey()
        val pub = X25519.publicFromPrivate(priv)
        return Keypair(priv, pub)
    }

    fun randomNonce(): ByteArray = ByteArray(NONCE_SIZE).also { SecureRandom().nextBytes(it) }

    /**
     * Derive the 32-byte AES key and a 32-byte raw pair_secret from the ECDH
     * shared secret in one HKDF expansion. The pair_secret feeds the M3'
     * rolling PIN — see rollingPin().
     *
     *   salt = noncePc(16) || noncePhone(16)
     *   info = "passman-lan-v1", out = 64 bytes
     *
     * Mirrors src/public/js/secure.js#deriveSessionKey byte-for-byte.
     */
    data class DerivedSecrets(val aesKey: ByteArray, val pairSecret: ByteArray)

    fun deriveSessionKey(
        myPriv: ByteArray, peerPub: ByteArray,
        noncePc: ByteArray, noncePhone: ByteArray,
    ): DerivedSecrets {
        val shared = X25519.computeSharedSecret(myPriv, peerPub)
        val salt = noncePc + noncePhone
        val okm = Hkdf.computeHkdf("SHA256", shared, salt, INFO.toByteArray(), KEY_SIZE * 2)
        return DerivedSecrets(
            aesKey = okm.copyOfRange(0, KEY_SIZE),
            pairSecret = okm.copyOfRange(KEY_SIZE, KEY_SIZE * 2),
        )
    }

    // ---------- M3'-A rolling pairing PIN ----------
    //
    // Mirror of secure.js#rollingPin: PIN_t = HKDF(pair_secret, window=floor(now/30s),
    // info="passman-pair-pin-v1", 4 bytes) → big-endian u32 % 1_000_000, padded to 6.

    private const val PIN_INFO = "passman-pair-pin-v1"
    const val PIN_WINDOW_MS = 30_000L

    fun pinWindow(nowMs: Long): Long = nowMs / PIN_WINDOW_MS

    fun rollingPin(pairSecret: ByteArray, w: Long): String {
        val salt = ByteBuffer.allocate(8).putLong(w).array()
        val bits = Hkdf.computeHkdf("SHA256", pairSecret, salt, PIN_INFO.toByteArray(), 4)
        val u32 = ((bits[0].toLong() and 0xFF) shl 24) or
                  ((bits[1].toLong() and 0xFF) shl 16) or
                  ((bits[2].toLong() and 0xFF) shl 8) or
                  (bits[3].toLong() and 0xFF)
        return (u32 % 1_000_000L).toString().padStart(6, '0')
    }

    /**
     * One SecureChannel per WebSocket connection. Holds the session key and
     * two independent monotonic counters (send / recv).
     *
     * Construction copies `key` into an internal byte array and a SecretKeySpec
     * so close() can zero the bytes we own. The caller is still responsible
     * for clearing their own `key` reference if it came from elsewhere.
     */
    class SecureChannel(key: ByteArray) {
        // Field-level SecureRandom (was per-call new) — avoids the per-seal
        // allocation reviewer flagged. Thread-safe in JCE.
        private val rng = SecureRandom()

        // Owned copy so we can wipe on close().
        private val keyBytes: ByteArray = key.copyOf()
        private val keySpec: SecretKeySpec = SecretKeySpec(keyBytes, "AES")

        private var sendCtr: Long = 0L
        private var lastRecvCtr: Long = -1L   // accept first frame at ctr 0

        @Volatile var closed: Boolean = false
            private set

        /** Encrypt plaintext -> wire frame. */
        @Synchronized
        fun seal(plaintext: ByteArray): ByteArray {
            check(!closed) { "SecureChannel is closed" }
            val ctr = sendCtr++
            val iv = ByteArray(IV_SIZE).also { rng.nextBytes(it) }
            val ctrBytes = ctrToBytes(ctr)
            val aad = AAD_PREFIX.toByteArray() + ctrBytes
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.ENCRYPT_MODE, keySpec, GCMParameterSpec(TAG_BITS, iv))
                updateAAD(aad)
            }
            val ctAndTag = cipher.doFinal(plaintext)   // ciphertext || tag(16)
            // Frame layout: iv(12) || ctr(8) || ct||tag.
            val out = ByteArray(IV_SIZE + CTR_SIZE + ctAndTag.size)
            System.arraycopy(iv, 0, out, 0, IV_SIZE)
            System.arraycopy(ctrBytes, 0, out, IV_SIZE, CTR_SIZE)
            System.arraycopy(ctAndTag, 0, out, IV_SIZE + CTR_SIZE, ctAndTag.size)
            return out
        }

        /** Decrypt a wire frame -> plaintext. Throws on auth/replay. */
        @Synchronized
        fun open(frame: ByteArray): ByteArray {
            check(!closed) { "SecureChannel is closed" }
            require(frame.size >= IV_SIZE + CTR_SIZE + TAG_SIZE) {
                "frame too short: ${frame.size}"
            }
            val iv = frame.copyOfRange(0, IV_SIZE)
            val ctrBytes = frame.copyOfRange(IV_SIZE, IV_SIZE + CTR_SIZE)
            val ctAndTag = frame.copyOfRange(IV_SIZE + CTR_SIZE, frame.size)
            val ctr = bytesToCtr(ctrBytes)
            if (ctr <= lastRecvCtr) {
                throw ReplayException(ctr, lastRecvCtr)
            }
            val aad = AAD_PREFIX.toByteArray() + ctrBytes
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, keySpec, GCMParameterSpec(TAG_BITS, iv))
                updateAAD(aad)
            }
            val pt = cipher.doFinal(ctAndTag)   // throws AEADBadTagException on auth fail
            lastRecvCtr = ctr
            return pt
        }

        /** Zero the key bytes and mark closed. Subsequent seal/open throw. */
        fun close() {
            closed = true
            Arrays.fill(keyBytes, 0.toByte())
            // keySpec wraps keyBytes by reference (Sun JCE behaviour), so the
            // wipe propagates. Per docs we don't strictly own keySpec internals
            // across vendors, but zeroing our backing array is best we can do.
        }
    }

    class ReplayException(val got: Long, val lastAccepted: Long) :
        SecurityException("replay/bad ctr: got $got, last accepted $lastAccepted")

    // ---------- byte helpers ----------

    private fun ctrToBytes(ctr: Long): ByteArray {
        // 8-byte big-endian.
        val bb = ByteBuffer.allocate(CTR_SIZE)
        bb.putLong(ctr)
        return bb.array()
    }

    private fun bytesToCtr(b: ByteArray): Long {
        val bb = ByteBuffer.wrap(b)
        return bb.long
    }

    // ---------- b64 (URL-safe not needed; standard alphabet matches JS btoa) ----------

    private val ENC = android.util.Base64.NO_WRAP

    fun b64encode(bytes: ByteArray): String = android.util.Base64.encodeToString(bytes, ENC)
    fun b64decode(str: String): ByteArray = android.util.Base64.decode(str, ENC)

    // ---------- TOFU fingerprint ----------

    /**
     * SHA-256(pubkey) as 64-char uppercase hex. Byte-for-byte mirror of
     * fingerprintHex in src/public/js/secure.js and src/paired-devices.js.
     * Used as the trusted-device identity at the application layer.
     */
    fun fingerprintHex(pub: ByteArray): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(pub)
        return buildString(digest.size * 2) {
            for (b in digest) {
                val v = b.toInt() and 0xFF
                append(HEX[v ushr 4])
                append(HEX[v and 0xF])
            }
        }
    }

    /** "XXXX XXXX XXXX XXXX XXXX XXXX XXXX XXXX" — first 32 hex chars in 4-blocks. */
    fun fingerprintShort(fpHex: String): String {
        val head = fpHex.take(32)
        return head.chunked(4).joinToString(" ")
    }

    private val HEX = charArrayOf(
        '0','1','2','3','4','5','6','7','8','9','A','B','C','D','E','F'
    )

    // ---------- M3'-A: PIN verification + lockout tracker ----------
    //
    // Byte-for-byte mirror of src/lan-pair-protocol.js#PairAttemptTracker.
    // Sliding window: maxFailures within windowMs → locked for the rest of
    // the window. Service restart resets (in-memory by design — an attacker
    // can't restart the service remotely).
    //
    // Thread safety: HotspotServerService uses ONE tracker shared across
    // every WS /socket connection (service field), and Ktor delivers frames
    // for one connection on one coroutine. Different connections may race;
    // hence @Synchronized.
    class PairAttemptTracker(
        val maxFailures: Int = 5,
        val windowMs: Long = 60_000L,
        private val clock: () -> Long = { System.currentTimeMillis() },
    ) {
        // ArrayList holds unix-ms timestamps of failures, oldest first.
        private val failures = ArrayList<Long>(8)

        @Synchronized
        fun isLocked(): Boolean {
            prune()
            return failures.size >= maxFailures
        }

        @Synchronized
        fun recordFailure() {
            failures.add(clock())
            prune()
        }

        @Synchronized
        fun reset() { failures.clear() }

        @Synchronized
        fun unlockInMs(): Long {
            prune()
            if (failures.size < maxFailures) return 0L
            // The oldest failure that still counts toward the lockout is at
            // index (size - maxFailures). It expires at +windowMs.
            val earliestRelevant = failures[failures.size - maxFailures]
            return maxOf(0L, earliestRelevant + windowMs - clock())
        }

        private fun prune() {
            val cutoff = clock() - windowMs
            // Drop from front while older than the window.
            while (failures.isNotEmpty() && failures[0] < cutoff) failures.removeAt(0)
        }
    }

    /**
     * Verify a submitted PIN against the rolling-PIN function for windows
     * w-skew..w+skew. Returns the matched window number, or null on no match.
     *
     * Mirrors src/lan-pair-protocol.js#verifyPin. The ±1 slack tolerates
     * ~45s of clock drift between consumer devices.
     */
    fun verifyPin(
        submittedPin: String,
        submittedW: Long,
        pairSecret: ByteArray,
        skew: Int = 1,
    ): Long? {
        for (off in -skew..skew) {
            val w = submittedW + off
            val expected = rollingPin(pairSecret, w)
            // Constant-time compare to limit timing-side-channel even though
            // the PIN is short-lived; 6 chars is fast either way but the
            // habit is cheap.
            if (constantTimeEquals(expected, submittedPin)) return w
        }
        return null
    }

    private fun constantTimeEquals(a: String, b: String): Boolean {
        if (a.length != b.length) return false
        var diff = 0
        for (i in a.indices) diff = diff or (a[i].code xor b[i].code)
        return diff == 0
    }
}
