package com.passman.pair

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Base64
import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.ApplicationEngine
import io.ktor.server.engine.embeddedServer
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.websocket.DefaultWebSocketServerSession
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.readBytes
import io.ktor.websocket.readText
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * M1' (ADR-002) — foreground service running a Ktor CIO server on :9876.
 *
 * Lifecycle:
 *   onStartCommand(START)  → startForeground(notif) + launch Ktor
 *   onStartCommand(STOP)   → ktor.stop() + stopForeground + stopSelf
 *
 * The service exposes one route in M1':  GET /ping → JSON metadata.
 * Subsequent milestones add /pair (M3') and /socket WebSocket (M2').
 *
 * Why CIO over Netty: ~1.5MB lighter on APK, no servlet baggage, simpler DEX
 * config. CIO is fully sufficient for the LAN traffic we need.
 *
 * Service binds to 0.0.0.0 — anyone on the same network sees the port. The
 * only "network" anyone reaches us on is the Wi-Fi hotspot, so that's the
 * pairing partner. Mobile data interface is also bound but unreachable from
 * outside the carrier NAT. M5' will tighten this to bind specifically to the
 * AP interface (wlan1 / ap0).
 */
class HotspotServerService : Service() {

    companion object {
        private const val TAG = "PassManHotspot"
        const val PORT = 9876
        const val APP_NAME = "passman"
        const val APP_VERSION = "0.3"

        const val ACTION_START = "com.passman.pair.action.START"
        const val ACTION_STOP  = "com.passman.pair.action.STOP"
        private const val NOTIF_CHANNEL_ID = "passman.hotspot"
        private const val NOTIF_ID = 0xC0DE  // 49374 — recognisable in logcat

        fun startServer(ctx: Context) {
            val intent = Intent(ctx, HotspotServerService::class.java).setAction(ACTION_START)
            ctx.startForegroundService(intent)
        }

        fun stopServer(ctx: Context) {
            val intent = Intent(ctx, HotspotServerService::class.java).setAction(ACTION_STOP)
            ctx.startService(intent)
        }

        // Activity polls this to render status. Volatile because it's set by
        // the Ktor coroutine thread and read by the UI thread.
        @Volatile var lastError: String? = null
        @Volatile var running: Boolean = false
        @Volatile var startedAtMillis: Long = 0L

        // M3'-A pairing UI surface. Populated when a /socket handshake completes;
        // cleared when the socket ends. UI polls these to render the rolling
        // PIN the user types into the PC. A second concurrent socket would
        // overwrite — acceptable for v0.3 (one user, one phone, one pairing
        // attempt at a time); the entry reset in handleEncryptedSocket gives
        // us per-socket isolation of the *approval* gesture which is what
        // matters for safety.
        @Volatile var activePairSecret: ByteArray? = null
        @Volatile var activePeerFingerprint: String? = null

        // True once the user explicitly tapped "trust this PC" in HotspotPairActivity
        // for the *current* handshake. UI sets this; the WS handler reads it on
        // PAIR_REQUEST. Reset to false at socket entry AND on successful PAIR_OK
        // so each trust press is one-shot.
        @Volatile var userApprovesNext: Boolean = false
    }

    private var ktor: ApplicationEngine? = null
    private var wakeLock: PowerManager.WakeLock? = null

    // M3'-A: one tracker shared across ALL pairing attempts during this
    // service lifetime. Five wrong PINs in 60s → locked for the rest of the
    // window. Service restart resets — by design (see PairAttemptTracker doc).
    private val pinTracker = Crypto.PairAttemptTracker()

    // Stable label phones see in PAIR_OK. Hard-coded for now; M4' UI lets the
    // user rename their phone in the "trusted devices" panel.
    private val phoneLabel: String = android.os.Build.MODEL ?: "PassMan phone"

    // M3'-B B-1: per-device HMAC key for biometric CHALLENGE, handed to the PC
    // once inside the encrypted PAIR_OK frame (design §8). We mint it lazily and
    // cache it for this service lifetime.
    //
    // B-2 (done): on PAIR_OK the raw key is imported into the bio-gated
    // AndroidKeyStore (Crypto.enrollDeviceHmacKey) so a later CHALLENGE can only
    // sign after a live fingerprint.
    //
    // B-5 (方案 C): K_bio stays Keystore-only and is NEVER persisted to ESP. The
    // fallback path uses a SEPARATE K_pin (FallbackSecretStore.getOrCreatePinKey)
    // so the PC can tell bio vs fallback apart by which key verified the HMAC
    // (design §7). K_bio is still minted in-memory here for this service lifetime;
    // a service restart forces a re-pair (acceptable under M3'-A's ephemeral
    // keypair model; persistent identity is M4').
    @Volatile private var deviceHmacKey: ByteArray? = null
    private val secureRandom = SecureRandom()
    private val ioScope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO)

    // M3'-B B-5: fallback secrets (K_pin + PIN hash/salt + lockout) in ESP, and
    // the 3-fail/24h tracker restored from ESP on service start so a restart
    // doesn't hand an attacker fresh tries (design §8).
    private lateinit var fallbackStore: FallbackSecretStore
    private val fallbackTracker = Crypto.FallbackPinTracker()

    // M3'-B B-5: in-flight fallback challenges, keyed by challenge id. A
    // FALLBACK_REQ keeps the PC's challenge pending (the PC reuses the same
    // id/nonce for the post-PIN RESPONSE); we stash the bits needed to compute
    // the K_pin HMAC when the user types the PIN. Removed on RESPONSE / cancel /
    // socket close. One entry per active fallback; bounded by the PC's pending
    // TTL (150s) in practice.
    private data class PendingFallback(
        val nonce: ByteArray,
        val purpose: String,
        val fingerprintHex: String,
        val myPubkey: ByteArray,
    )
    private val pendingFallbacks = java.util.concurrent.ConcurrentHashMap<String, PendingFallback>()

    /** 32B HMAC key as base64 (NO_WRAP), minted once per service lifetime. */
    @Synchronized
    private fun deviceHmacKeyB64(): String {
        val key = deviceHmacKey ?: ByteArray(32).also {
            secureRandom.nextBytes(it)
            deviceHmacKey = it
        }
        return Base64.encodeToString(key, Base64.NO_WRAP)
    }

    /** Snapshot of whether strong (Class 3) biometrics are usable right now. */
    private fun biometricCapable(): Boolean =
        BiometricManager.from(this)
            .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
            BiometricManager.BIOMETRIC_SUCCESS

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()
        // B-5: ESP-backed fallback secrets + restore the 24h lockout so a service
        // restart preserves the failure count (design §8).
        fallbackStore = FallbackSecretStore(this)
        try {
            fallbackStore.restoreLockout(fallbackTracker)
        } catch (t: Throwable) {
            Log.w(TAG, "restoreLockout failed (starting fresh): ${t.message}")
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                Log.i(TAG, "ACTION_STOP")
                shutdownServer()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            else -> {
                // Treat any other action (incl. ACTION_START or null) as start.
                if (running) {
                    Log.i(TAG, "Already running, ignoring START")
                    return START_STICKY
                }
                startInForeground()
                startKtorServer()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        shutdownServer()
    }

    private fun startInForeground() {
        val notif = buildNotification("Starting…")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // API 34+ requires foregroundServiceType to be passed at start time.
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(NOTIF_ID, notif)
        }

        // Hold a partial wake lock so Doze doesn't kill the socket while the
        // user is on another screen. Release in shutdownServer().
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "passman:hotspot-server").apply {
            setReferenceCounted(false)
            acquire(60 * 60 * 1000L)  // 1 hour cap; refreshed on next start
        }
    }

    private fun startKtorServer() {
        try {
            ktor = embeddedServer(CIO, port = PORT, host = "0.0.0.0") {
                install(ContentNegotiation) { json() }
                // Ktor's built-in WS ping/pong keepalive; maxFrameSize per
                // reviewer suggestion (64KB — enough for PING/PONG/PAIR_REQUEST;
                // M3'-C full sync will chunk >64KB payloads).  reviewers
                install(WebSockets) {
                    maxFrameSize = 64 * 1024
                }
                routing {
                    get("/ping") {
                        call.respond(PingResponse(
                            app = APP_NAME, ver = APP_VERSION,
                            time = System.currentTimeMillis(),
                            uptimeMs = System.currentTimeMillis() - startedAtMillis
                        ))
                    }
                    // M2' — encrypted channel. See Crypto.kt + secure.js for the
                    // handshake / frame format. Text frames = JSON handshake;
                    // binary frames = AES-GCM ciphertext.
                    // M3' adds PAIR_REQUEST/PAIR_OK/PAIR_REJECT over encrypted frames.
                    webSocket("/socket") {
                        handleEncryptedSocket(
                            tracker = this@HotspotServerService.pinTracker,
                            userApproves = { userApprovesNext },
                            phoneLabel = this@HotspotServerService.phoneLabel,
                        )
                    }
                }
            }.also { it.start(wait = false) }

            startedAtMillis = System.currentTimeMillis()
            running = true
            lastError = null
            updateNotification("Listening on :$PORT")
            Log.i(TAG, "Ktor CIO server started on 0.0.0.0:$PORT (with /socket)")
        } catch (t: Throwable) {
            running = false
            lastError = t.javaClass.simpleName + ": " + (t.message ?: "(no message)")
            updateNotification("Error: $lastError")
            Log.e(TAG, "Ktor failed to start", t)
        }
    }

    /**
     * M2' + M3'-A per-connection handler. Runs inside a Ktor coroutine.
     *
     * State machine:
     *   AWAIT_HELLO  --text-->  derive aesKey + pairSecret
     *                            --> ACTIVE
     *   ACTIVE       --binary--> decrypt JSON, dispatch by `t`:
     *     PING         -> reply PONG (M2')
     *     PAIR_REQUEST -> verify PIN against rolling PIN windows;
     *                     check lockout tracker; reply PAIR_OK or PAIR_REJECT
     *
     * Any frame that fails GCM auth / JSON parse closes the socket with
     * CANNOT_ACCEPT (1003). Replayed frames are silently dropped.
     *
     * Service-level state passed in by the caller:
     *   tracker      — shared across all sockets, enforces 5-tries/60s lockout
     *   userApproves — UI-set flag; true iff the user pressed "trust" since last reset
     *   phoneLabel   — string sent back in PAIR_OK so PC can show "Mi 14 Pro"
     */
    private suspend fun DefaultWebSocketServerSession.handleEncryptedSocket(
        tracker: Crypto.PairAttemptTracker,
        userApproves: () -> Boolean,
        phoneLabel: String,
    ) {
        // Per-socket reset of the service-level "user pressed trust" flag.
        // The flag is shared across sockets (one user, one trust button), so
        // if socket A solicited trust but dropped before sending PAIR_REQUEST,
        // we must clear stale approval before socket B starts — otherwise B's
        // PAIR_REQUEST would inherit a yes the user did not give for THIS
        // connection. Race-safe: any concurrent click on the trust button
        // runs on the main thread and would land *after* this reset.
        userApprovesNext = false

        val kp = Crypto.generateKeypair()
        val noncePhone = Crypto.randomNonce()
        var channel: Crypto.SecureChannel? = null
        var pairSecret: ByteArray? = null
        val fingerprint = Crypto.fingerprintHex(kp.publicKey)
        val json = Json { ignoreUnknownKeys = true }

        // Helper: encrypt + send a PAIR_* reply.
        suspend fun replyEncrypted(obj: JsonObject) {
            val ch = channel ?: return
            val bytes = obj.toString().toByteArray(Charsets.UTF_8)
            send(Frame.Binary(true, ch.seal(bytes)))
        }

        try {
            for (frame in incoming) {
                when (frame) {
                    is Frame.Text -> {
                        // Handshake. Expect HELLO first; reply WELCOME.
                        val msg = try {
                            json.parseToJsonElement(frame.readText()).jsonObject
                        } catch (t: Throwable) {
                            send(Frame.Close(CloseReason(CloseReason.Codes.CANNOT_ACCEPT, "bad json")))
                            return
                        }
                        val t = msg["t"]?.jsonPrimitive?.content
                        if (t != "HELLO" || channel != null) {
                            send(Frame.Close(CloseReason(CloseReason.Codes.CANNOT_ACCEPT, "expected HELLO")))
                            return
                        }
                        val peerPub = Crypto.b64decode(msg["pub"]!!.jsonPrimitive.content)
                        val noncePc = Crypto.b64decode(msg["nonce"]!!.jsonPrimitive.content)
                        val derived = Crypto.deriveSessionKey(kp.privateKey, peerPub, noncePc, noncePhone)
                        channel = Crypto.SecureChannel(derived.aesKey)
                        pairSecret = derived.pairSecret
                        // Surface to UI so it can render the rolling PIN the
                        // user reads off the phone screen. Cleared in finally{}.
                        activePairSecret = derived.pairSecret
                        activePeerFingerprint = Crypto.fingerprintHex(peerPub)

                        val welcome = buildJsonObject {
                            put("t", "WELCOME")
                            put("pub", Crypto.b64encode(kp.publicKey))
                            put("nonce", Crypto.b64encode(noncePhone))
                        }.toString()
                        send(Frame.Text(welcome))
                        Log.i(TAG, "WS /socket: handshake done, fingerprint=${fingerprint.take(16)}…")
                    }
                    is Frame.Binary -> {
                        val ch = channel ?: run {
                            send(Frame.Close(CloseReason(CloseReason.Codes.CANNOT_ACCEPT, "binary before handshake")))
                            return
                        }
                        val plaintext = try {
                            ch.open(frame.readBytes())
                        } catch (re: Crypto.ReplayException) {
                            Log.w(TAG, "replay frame rejected: ${re.got}")
                            continue   // drop silently, keep channel alive
                        } catch (t: Throwable) {
                            send(Frame.Close(CloseReason(CloseReason.Codes.CANNOT_ACCEPT, "decrypt failed")))
                            return
                        }
                        val req = try {
                            json.parseToJsonElement(String(plaintext, Charsets.UTF_8)).jsonObject
                        } catch (t: Throwable) {
                            send(Frame.Close(CloseReason(CloseReason.Codes.CANNOT_ACCEPT, "bad plaintext json")))
                            return
                        }
                        when (req["t"]?.jsonPrimitive?.content) {
                            "PING" -> {
                                val echoTs = req["ts"]?.jsonPrimitive?.long
                                    ?: System.currentTimeMillis()
                                val pong = buildJsonObject {
                                    put("t", "PONG")
                                    put("ts", System.currentTimeMillis())
                                    put("echoTs", echoTs)
                                }.toString().toByteArray(Charsets.UTF_8)
                                send(Frame.Binary(true, ch.seal(pong)))
                            }
                            "PAIR_REQUEST" -> {
                                handlePairRequest(
                                    req = req,
                                    tracker = tracker,
                                    pairSecret = pairSecret!!,
                                    userApproves = userApproves,
                                    fingerprint = fingerprint,
                                    phoneLabel = phoneLabel,
                                    reply = ::replyEncrypted,
                                )
                            }
                            "CHALLENGE" -> {
                                handleChallenge(
                                    req = req,
                                    fingerprintHex = fingerprint,
                                    myPubkey = kp.publicKey,
                                    reply = ::replyEncrypted,
                                )
                            }
                            "FALLBACK_PIN" -> {
                                handleFallbackPin(
                                    req = req,
                                    fingerprintHex = fingerprint,
                                    myPubkey = kp.publicKey,
                                    reply = ::replyEncrypted,
                                )
                            }
                            else -> {
                                // Unknown but well-formed & authenticated: log and drop.
                                Log.w(TAG, "unknown msg type, dropping: ${req["t"]}")
                            }
                        }
                    }
                    else -> { /* ignore ping/close frames handled by ktor */ }
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "WS /socket ended: ${t.message}")
        } finally {
            channel?.close()
            // Wipe pair_secret (HKDF derivative — small, but habit).
            pairSecret?.let { java.util.Arrays.fill(it, 0.toByte()) }
            // Tear down UI-visible state so a disconnected socket doesn't
            // leave a stale PIN on screen.
            activePairSecret = null
            activePeerFingerprint = null
        }
    }

    /**
     * M3'-A PAIR_REQUEST dispatcher. Decides between PAIR_OK / PAIR_REJECT
     * based on (a) lockout state, (b) PIN match, (c) user approval gesture.
     *
     * Mirrors the JS mock-phone logic in scripts/test-m3a-pairing.js so the
     * two endpoints behave identically.
     */
    private suspend fun handlePairRequest(
        req: JsonObject,
        tracker: Crypto.PairAttemptTracker,
        pairSecret: ByteArray,
        userApproves: () -> Boolean,
        fingerprint: String,
        phoneLabel: String,
        reply: suspend (JsonObject) -> Unit,
    ) {
        if (tracker.isLocked()) {
            reply(buildJsonObject {
                put("t", "PAIR_REJECT")
                put("reason", "locked")
            })
            return
        }
        val pin = req["pin"]?.jsonPrimitive?.content
        val w = req["w"]?.jsonPrimitive?.long
        if (pin == null || w == null) {
            // Malformed PAIR_REQUEST. Don't burn a failure slot — this isn't
            // a wrong PIN, it's a protocol violation. Reject with bad_pin so
            // the PC reports something user-meaningful; bump no counter.
            reply(buildJsonObject {
                put("t", "PAIR_REJECT")
                put("reason", "bad_pin")
            })
            return
        }
        val matched = Crypto.verifyPin(pin, w, pairSecret)
        if (matched == null) {
            tracker.recordFailure()
            reply(buildJsonObject {
                put("t", "PAIR_REJECT")
                // The protocol uses 'bad_pin' for both "typo" and "out of slack
                // window" — they're indistinguishable to the user.
                put("reason", "bad_pin")
            })
            return
        }
        if (!userApproves()) {
            // PIN was correct, but user pressed "deny" on the phone. NOT a
            // failure (don't lock the user out for refusing a stranger).
            reply(buildJsonObject {
                put("t", "PAIR_REJECT")
                put("reason", "user_denied")
            })
            return
        }
        tracker.reset()
        // Consume the approval gesture: even if this socket stays alive and
        // somehow tries another PAIR_REQUEST, the user has to press trust
        // again. Pairs with the per-socket reset at the top of
        // handleEncryptedSocket() to give one-trust-per-attempt semantics.
        userApprovesNext = false
        // B-2: mint (B-1) + enroll the key into the bio-gated AndroidKeyStore so
        // a later CHALLENGE can compute its HMAC only after a live fingerprint.
        // `fingerprint` is THIS phone's identity → the Keystore alias. Best-effort:
        // a phone with no secure lock screen / no biometrics can't back the key, so
        // we log and still hand the PC the key, leaving the fallback PIN path (B-5)
        // to cover it. Re-enrolling on every PAIR_OK keeps the Keystore copy equal
        // to whatever key we just sent the PC.
        val hmacKeyB64 = deviceHmacKeyB64()
        deviceHmacKey?.let { raw ->
            try {
                Crypto.enrollDeviceHmacKey(raw, fingerprint)
            } catch (t: Throwable) {
                Log.w(TAG, "enrollDeviceHmacKey failed (fallback PIN path only): ${t.message}")
            }
        }
        // B-5 (方案 C): mint the independent K_pin (ESP, no bio gate) and hand it
        // to the PC alongside K_bio. The PC stores both and decides bio-vs-fallback
        // by which key verifies a RESPONSE (design §7). We DON'T block PAIR_OK on
        // the PIN-set prompt: the PIN is set asynchronously on first pairing and
        // is only needed when a fallback CHALLENGE later arrives. If the user
        // never sets one, a later FALLBACK_PIN yields NOT_SET → error (acceptable:
        // the bio path still works, and re-pairing re-triggers the prompt).
        val pinKeyB64 = try {
            Crypto.b64encode(fallbackStore.getOrCreatePinKey())
        } catch (t: Throwable) {
            Log.w(TAG, "getOrCreatePinKey failed (ESP): ${t.message}")
            null
        }
        if (pinKeyB64 != null && !fallbackStore.hasFallbackPin()) {
            // Best-effort: ask the user to set a fallback PIN now so it's ready
            // before fingerprints ever become unavailable. Non-blocking — PAIR_OK
            // proceeds regardless; the PIN can still be set on the next pairing.
            launchSetPinPrompt()
        }
        reply(buildJsonObject {
            put("t", "PAIR_OK")
            put("fingerprint", fingerprint)
            put("label", phoneLabel)
            // M3'-B: hand the PC the per-device HMAC key + a snapshot of whether
            // this phone can do strong biometrics, so it knows whether to offer
            // biometric CHALLENGE later (design §8/§9).
            put("device_hmac_key_b64", hmacKeyB64)
            // B-5 方案 C: the independent fallback key. PC stores this in
            // paired_devices.device_pin_key and only tries it for `unlock`.
            if (pinKeyB64 != null) put("device_pin_key_b64", pinKeyB64)
            else put("device_pin_key_b64", JsonNull)
            put("biometric_capable", biometricCapable())
        })
        Log.i(TAG, "WS /socket: PAIR_OK to PC, fingerprint=${fingerprint.take(16)}…")
    }

    /**
     * M3'-B B-3 CHALLENGE dispatcher (design §3/§6/§10). Validates the request,
     * builds the §4 AAD, drives a BiometricPrompt via ChallengePromptActivity,
     * and replies RESPONSE { hmac, ts, biometric_ok } or RESPONSE { error }.
     *
     * `fingerprintHex` / `myPubkey` are THIS connection's identity — the Keystore
     * alias and the AAD fingerprint, respectively. Because M3'-A still mints an
     * ephemeral keypair per connection (persistent identity is M4'), the bio key
     * is only findable on the same connection that paired (and enrolled) it; a
     * reconnect changes the fingerprint and yields error=unknown_device until M4'.
     *
     * When the phone has no usable strong biometrics we emit FALLBACK_REQ so the
     * PC can start the 4-digit-PIN path; the PIN handling itself lands in B-5.
     */
    private suspend fun handleChallenge(
        req: JsonObject,
        fingerprintHex: String,
        myPubkey: ByteArray,
        reply: suspend (JsonObject) -> Unit,
    ) {
        val id = req["id"]?.jsonPrimitive?.content
        if (id == null || id.length != Crypto.CHAL_ID_HEX_LEN) {
            // Can't echo a malformed id back meaningfully — drop and let the PC
            // time out rather than answer an unparseable challenge.
            Log.w(TAG, "CHALLENGE with bad id, dropping")
            return
        }

        fun respondError(error: String) = buildJsonObject {
            put("t", "RESPONSE"); put("id", id); put("error", error)
        }

        val purpose = req["purpose"]?.jsonPrimitive?.content
        if (purpose == null || runCatching { Crypto.challengePurposeByte(purpose) }.isFailure) {
            reply(respondError("unknown_purpose")); return
        }
        val nonce = req["nonce_b64"]?.jsonPrimitive?.content?.let {
            try { Crypto.b64decode(it) } catch (e: Exception) { null }
        }
        if (nonce == null || nonce.size != Crypto.CHAL_NONCE_SIZE) {
            reply(respondError("bad_nonce")); return
        }

        // No usable strong biometrics → ask the PC to begin the fallback PIN path.
        // Stash the challenge so the post-PIN RESPONSE (reusing this id/nonce,
        // design §7) can compute the K_pin HMAC. We keep the entry for the whole
        // fallback round-trip; the PC's pending TTL (150s) bounds it, and we
        // also drop it on RESPONSE / cancel / socket close.
        if (!biometricCapable()) {
            pendingFallbacks[id] = PendingFallback(nonce, purpose, fingerprintHex, myPubkey)
            reply(buildJsonObject {
                put("t", "FALLBACK_REQ"); put("id", id); put("reason", "bio_unavailable")
            })
            return
        }
        // Key not enrolled for this identity (e.g. challenged on a different
        // connection than the one that paired — see the ephemeral-keypair note).
        if (!Crypto.hasDeviceHmacKey(fingerprintHex)) {
            reply(respondError("unknown_device")); return
        }

        // Phone picks ts; the AAD binds it, and the PC checks |ts - now| < 30s.
        val ts = System.currentTimeMillis()
        val fingerprintRaw = MessageDigest.getInstance("SHA-256").digest(myPubkey)
        val aad = try {
            Crypto.buildChallengeAad(id, nonce, purpose, ts, fingerprintRaw)
        } catch (e: Exception) {
            Log.w(TAG, "buildChallengeAad failed: ${e.message}")
            reply(respondError("bad_nonce")); return
        }

        // Hand off to the prompt Activity and await the signed HMAC.
        // TODO(hardening): launching an Activity from a Service is restricted on
        // Android 12+ background. Pairing is interactive so the foreground-app
        // exemption applies; the truly-backgrounded case needs a
        // full-screen-intent notification.
        val deferred = ChallengeBridge.enqueue(ChallengeBridge.Request(id, fingerprintHex, aad))
        try {
            startActivity(Intent(this, ChallengePromptActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                putExtra(ChallengePromptActivity.EXTRA_CHALLENGE_ID, id)
            })
        } catch (t: Throwable) {
            Log.w(TAG, "could not launch ChallengePromptActivity: ${t.message}")
            ChallengeBridge.cancel(id)
            reply(respondError("bio_unavailable")); return
        }

        // §10: 30s challenge window. Give the prompt headroom; the PC enforces
        // the real freshness bound on ts anyway.
        val result = withTimeoutOrNull(60_000L) { deferred.await() }
        if (result == null) {
            ChallengeBridge.cancel(id)
            reply(respondError("user_cancelled")); return
        }

        when (result) {
            is BiometricChallengeSigner.Result.Success -> reply(buildJsonObject {
                put("t", "RESPONSE")
                put("id", id)
                put("hmac_b64", Crypto.b64encode(result.hmac))
                put("ts", ts)
                put("biometric_ok", true)
            })
            is BiometricChallengeSigner.Result.KeyInvalidated ->
                // Fingerprints changed since pairing → PC must prompt a re-pair (§9).
                reply(respondError("key_invalidated"))
            is BiometricChallengeSigner.Result.Error -> {
                // §7: ERROR_LOCKOUT_PERMANENT means the system biometrics are
                // locked for the long haul — switch this challenge to the
                // fallback PIN path. We stash the pending fallback (reusing the
                // same id/nonce the PC is still holding) and emit FALLBACK_REQ so
                // the PC opens its PIN modal; the subsequent FALLBACK_PIN is
                // handled by handleFallbackPin below.
                if (result.androidCode == BiometricPrompt.ERROR_LOCKOUT_PERMANENT ||
                    result.androidCode == BiometricPrompt.ERROR_LOCKOUT) {
                    pendingFallbacks[id] = PendingFallback(nonce, purpose, fingerprintHex, myPubkey)
                    reply(buildJsonObject {
                        put("t", "FALLBACK_REQ"); put("id", id); put("reason", "bio_locked")
                    })
                } else {
                    reply(respondError(mapBiometricError(result)))
                }
            }
        }
    }

    /**
     * M3'-B B-5 — handle the FALLBACK_PIN frame the PC sends after the user
     * confirms the fallback modal (design §7 step 3). The phone prompts for the
     * 4-digit PIN, verifies it locally against the PBKDF2 hash, and on match
     * signs the ORIGINAL challenge AAD with K_pin (not K_bio) and replies
     * RESPONSE { hmac, ts, biometric_ok:false }.
     *
     * `fingerprintHex`/`myPubkey` come from THIS connection's ephemeral keypair
     * (the same one that stashed the pending fallback). We rebuild a fresh ts +
     * AAD here (the PC reuses the SAME id/nonce/purpose, design §7, but the
     * phone picks a new ts bound into the AAD — the PC checks freshness on ts).
     *
     * Failure modes → RESPONSE error:
     *   no_pending    — no stashed fallback for this id (PC sent FALLBACK_PIN
     *                   without a preceding FALLBACK_REQ, or socket changed)
     *   no_pin_key    — K_pin never minted (ESP failure at pairing)
     *   pin_not_set   — user never set a fallback PIN
     *   pin_locked    — 3 wrong PINs / 24h; the channel is locked
     *   pin_rejected  — wrong PIN (also bumps the tracker; 3 → locked)
     *   user_cancelled— user backed out of the PIN prompt
     */
    private suspend fun handleFallbackPin(
        req: JsonObject,
        fingerprintHex: String,
        myPubkey: ByteArray,
        reply: suspend (JsonObject) -> Unit,
    ) {
        val id = req["id"]?.jsonPrimitive?.content
        if (id == null) {
            Log.w(TAG, "FALLBACK_PIN with no id, dropping"); return
        }
        fun respondError(error: String) = buildJsonObject {
            put("t", "RESPONSE"); put("id", id); put("error", error)
        }

        val pending = pendingFallbacks[id]
        if (pending == null) { reply(respondError("no_pending")); return }

        // Drive the PIN-entry Activity and await the typed PIN.
        val deferred = FallbackPinBridge.enqueue(FallbackPinBridge.Request(id, FallbackPinBridge.Kind.VERIFY))
        try {
            startActivity(Intent(this, FallbackPinActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                putExtra(FallbackPinActivity.EXTRA_PIN_REQUEST_ID, id)
            })
        } catch (t: Throwable) {
            Log.w(TAG, "could not launch FallbackPinActivity: ${t.message}")
            FallbackPinBridge.cancel(id)
            reply(respondError("user_cancelled")); return
        }

        val pinResult = withTimeoutOrNull(120_000L) { deferred.await() }
        if (pinResult == null || pinResult is FallbackPinBridge.Result.Cancelled) {
            pendingFallbacks.remove(id)
            FallbackPinBridge.cancel(id)
            reply(respondError("user_cancelled")); return
        }
        val pin = (pinResult as FallbackPinBridge.Result.Submitted).pin

        // Verify the PIN locally (PBKDF2) + enforce the 3/24h lockout.
        val check = try {
            fallbackStore.verifyFallbackPin(pin, fallbackTracker)
        } catch (t: Throwable) {
            Log.w(TAG, "verifyFallbackPin threw: ${t.message}")
            pendingFallbacks.remove(id)
            reply(respondError("pin_not_set")); return
        }
        when (check) {
            FallbackSecretStore.PinCheck.LOCKED -> {
                pendingFallbacks.remove(id)
                reply(respondError("pin_locked")); return
            }
            FallbackSecretStore.PinCheck.NOT_SET -> {
                pendingFallbacks.remove(id)
                reply(respondError("pin_not_set")); return
            }
            FallbackSecretStore.PinCheck.REJECTED -> {
                // Wrong PIN. Keep the pending entry? No — the PC treats any
                // RESPONSE error as terminal for this id (it consumes the id),
                // so a retry needs a fresh CHALLENGE. Drop our stash too.
                pendingFallbacks.remove(id)
                reply(respondError("pin_rejected")); return
            }
            FallbackSecretStore.PinCheck.VERIFIED -> { /* proceed to sign */ }
        }

        // Sign the ORIGINAL challenge AAD with K_pin (NOT K_bio). Same id/nonce/
        // purpose as the stashed FALLBACK_REQ; fresh ts (PC re-checks freshness).
        val pinKey = fallbackStore.loadPinKey()
        if (pinKey == null) {
            pendingFallbacks.remove(id)
            reply(respondError("no_pin_key")); return
        }
        val ts = System.currentTimeMillis()
        val fingerprintRaw = MessageDigest.getInstance("SHA-256").digest(myPubkey)
        val aad = try {
            Crypto.buildChallengeAad(id, pending.nonce, pending.purpose, ts, fingerprintRaw)
        } catch (e: Exception) {
            Log.w(TAG, "buildChallengeAad (fallback) failed: ${e.message}")
            pendingFallbacks.remove(id)
            reply(respondError("bad_nonce")); return
        }
        val hmac = Crypto.computeChallengeHmac(pinKey, aad)
        pendingFallbacks.remove(id)
        reply(buildJsonObject {
            put("t", "RESPONSE")
            put("id", id)
            put("hmac_b64", Crypto.b64encode(hmac))
            put("ts", ts)
            // Display-only — the PC ignores this and derives biometricOk=false
            // from the fact that K_pin (not K_bio) verified (design §7 方案 C).
            put("biometric_ok", false)
        })
        Log.i(TAG, "WS /socket: fallback RESPONSE (K_pin) for id=${id.take(8)}…")
    }

    /** Map a signer Error to one of the §3 RESPONSE error codes. */
    private fun mapBiometricError(err: BiometricChallengeSigner.Result.Error): String = when (err.androidCode) {
        BiometricPrompt.ERROR_USER_CANCELED,
        BiometricPrompt.ERROR_NEGATIVE_BUTTON,
        BiometricPrompt.ERROR_CANCELED -> "user_cancelled"
        else -> "bio_failed"
    }

    /**
     * Best-effort: launch the SET-mode PIN prompt so the user can choose a
     * fallback PIN right after pairing (design §7 — PIN ready before it's
     * needed). Fire-and-forget; the result is consumed by setFallbackPin in the
     * bridge callback. We don't block PAIR_OK on this.
     */
    private fun launchSetPinPrompt() {
        val id = "setpin-" + Crypto.b64encode(ByteArray(8).also { secureRandom.nextBytes(it) })
        val deferred = FallbackPinBridge.enqueue(FallbackPinBridge.Request(id, FallbackPinBridge.Kind.SET))
        try {
            startActivity(Intent(this, FallbackPinActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                putExtra(FallbackPinActivity.EXTRA_PIN_REQUEST_ID, id)
            })
        } catch (t: Throwable) {
            Log.w(TAG, "could not launch FallbackPinActivity (SET): ${t.message}")
            FallbackPinBridge.cancel(id)
            return
        }
        // Consume the deferred off the IO scope — store the PIN if the user
        // submitted one. ESP writes are @Synchronized.
        ioScope.launch {
            val r = withTimeoutOrNull(120_000L) { deferred.await() }
            if (r is FallbackPinBridge.Result.Submitted) {
                try { fallbackStore.setFallbackPin(r.pin) }
                catch (t: Throwable) { Log.w(TAG, "setFallbackPin failed: ${t.message}") }
            }
        }
    }

    private fun shutdownServer() {
        try { ktor?.stop(gracePeriodMillis = 100, timeoutMillis = 1000) } catch (t: Throwable) {
            Log.w(TAG, "Ktor stop threw: ${t.message}")
        }
        ktor = null
        try { wakeLock?.let { if (it.isHeld) it.release() } } catch (_: Throwable) {}
        wakeLock = null
        running = false
        Log.i(TAG, "server stopped")
    }

    private fun ensureNotificationChannel() {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(NOTIF_CHANNEL_ID) == null) {
            val ch = NotificationChannel(
                NOTIF_CHANNEL_ID,
                "PassMan pairing channel",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows while PassMan is accepting Wi-Fi pairing connections."
                setShowBadge(false)
            }
            nm.createNotificationChannel(ch)
        }
    }

    private fun buildNotification(text: String): Notification {
        val openIntent = Intent(this, HotspotPairActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val openPi = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stopIntent = Intent(this, HotspotServerService::class.java).setAction(ACTION_STOP)
        val stopPi = PendingIntent.getService(
            this, 1, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, NOTIF_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("PassMan")
            .setContentText(text)
            .setContentIntent(openPi)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPi)
            .build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        nm.notify(NOTIF_ID, buildNotification(text))
    }

    @Serializable
    data class PingResponse(
        val app: String,
        val ver: String,
        val time: Long,
        val uptimeMs: Long,
    )
}
