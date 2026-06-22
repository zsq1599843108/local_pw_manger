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
     * Derive the 32-byte AES key from the ECDH shared secret.
     *   salt = noncePc(16) || noncePhone(16)
     *   info = "passman-lan-v1"
     */
    fun deriveSessionKey(
        myPriv: ByteArray, peerPub: ByteArray,
        noncePc: ByteArray, noncePhone: ByteArray,
    ): ByteArray {
        val shared = X25519.computeSharedSecret(myPriv, peerPub)
        val salt = noncePc + noncePhone
        return Hkdf.computeHkdf("SHA256", shared, salt, INFO.toByteArray(), KEY_SIZE)
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
}
