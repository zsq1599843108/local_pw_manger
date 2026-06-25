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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
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
    // TODO(B-2): replace this in-memory mint with AndroidKeyStore enrollment —
    // a PURPOSE_SIGN HMAC key with setUserAuthenticationRequired(true) plus a
    // no-bio-gate EncryptedSharedPreferences mirror for the fallback path. Until
    // then the key is NOT persisted on the phone, so a service restart forces a
    // re-ENROLL on the next connection (design §9 handles this gracefully).
    @Volatile private var deviceHmacKey: ByteArray? = null
    private val secureRandom = SecureRandom()

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
        reply(buildJsonObject {
            put("t", "PAIR_OK")
            put("fingerprint", fingerprint)
            put("label", phoneLabel)
            // M3'-B: hand the PC the per-device HMAC key + a snapshot of whether
            // this phone can do strong biometrics, so it knows whether to offer
            // biometric CHALLENGE later (design §8/§9).
            put("device_hmac_key_b64", hmacKeyB64)
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
        if (!biometricCapable()) {
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
            is BiometricChallengeSigner.Result.Error ->
                reply(respondError(mapBiometricError(result)))
        }
    }

    /** Map a signer Error to one of the §3 RESPONSE error codes. */
    private fun mapBiometricError(err: BiometricChallengeSigner.Result.Error): String = when (err.androidCode) {
        BiometricPrompt.ERROR_USER_CANCELED,
        BiometricPrompt.ERROR_NEGATIVE_BUTTON,
        BiometricPrompt.ERROR_CANCELED -> "user_cancelled"
        // TODO(B-5): ERROR_LOCKOUT_PERMANENT should switch to the fallback PIN path.
        else -> "bio_failed"
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
