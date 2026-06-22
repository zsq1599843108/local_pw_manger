package com.passman.pair

import com.google.crypto.tink.subtle.AesGcmJce
import com.google.crypto.tink.subtle.Hkdf
import com.google.crypto.tink.subtle.X25519
import java.nio.ByteBuffer
import java.security.SecureRandom

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
 *                  big-endian      AesGcmJce appends the 16B tag
 *   GCM AAD = "PassMan-LAN-v1" || frame_ctr(8)
 *
 * frame_ctr is monotonic per direction; the receiver rejects any frame whose
 * counter is not strictly greater than the last accepted one (replay defence,
 * design §5).
 *
 * Handshake rides WebSocket *text* frames as JSON; encrypted data rides
 * *binary* frames:
 *   PC  -> phone : { "t":"HELLO",   "pub":b64, "nonce":b64 }
 *   phone -> PC  : { "t":"WELCOME", "pub":b64, "nonce":b64 }
 *
 * Why Tink subtles (not the higher-level Primitive API): the wire format is
 * fixed by the browser side (WebCrypto raw AES-GCM), and Tink's typed
 * primitives would impose their own keyset/encapsulation envelope. Subtles
 * give us the raw primitives matching WebCrypto exactly.
 */
object Crypto {

    private const val INFO = "passman-lan-v1"
    private const val AAD_PREFIX = "PassMan-LAN-v1"
    private const val IV_SIZE = 12
    private const val CTR_SIZE = 8
    private const val NONCE_SIZE = 16
    private const val KEY_SIZE = 32   // AES-256

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
     */
    class SecureChannel(private val key: ByteArray) {
        private val aead = AesGcmJce(key)
        private var sendCtr: Long = 0L
        private var lastRecvCtr: Long = -1L   // accept first frame at ctr 0

        @Volatile var closed: Boolean = false
            private set

        /** Encrypt plaintext -> wire frame. */
        @Synchronized
        fun seal(plaintext: ByteArray): ByteArray {
            val ctr = sendCtr++
            val iv = ByteArray(IV_SIZE).also { SecureRandom().nextBytes(it) }
            val ctrBytes = ctrToBytes(ctr)
            val aad = (AAD_PREFIX.toByteArray()) + ctrBytes
            val ct = aead.encrypt(plaintext, aad)   // returns ciphertext || tag(16)
            return iv + ctrBytes + ct
        }

        /** Decrypt a wire frame -> plaintext. Throws on auth/replay. */
        @Synchronized
        fun open(frame: ByteArray): ByteArray {
            require(frame.size >= IV_SIZE + CTR_SIZE + 16) {
                "frame too short: ${frame.size}"
            }
            val iv = frame.copyOfRange(0, IV_SIZE)
            val ctrBytes = frame.copyOfRange(IV_SIZE, IV_SIZE + CTR_SIZE)
            val ct = frame.copyOfRange(IV_SIZE + CTR_SIZE, frame.size)
            val ctr = bytesToCtr(ctrBytes)
            if (ctr <= lastRecvCtr) {
                throw ReplayException(ctr, lastRecvCtr)
            }
            val aad = (AAD_PREFIX.toByteArray()) + ctrBytes
            val pt = aead.decrypt(ct, aad)   // verifies tag, throws on mismatch
            lastRecvCtr = ctr
            return pt
        }

        fun close() { closed = true }
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
