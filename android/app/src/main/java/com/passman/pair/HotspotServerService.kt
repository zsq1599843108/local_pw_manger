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
import android.util.Log
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
import kotlinx.serialization.json.put

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
    }

    private var ktor: ApplicationEngine? = null
    private var wakeLock: PowerManager.WakeLock? = null

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
                    webSocket("/socket") {
                        handleEncryptedSocket()
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
     * M2' per-connection handler. Runs inside a Ktor coroutine.
     *
     * State machine:
     *   AWAIT_HELLO  --text--> derive key --> ACTIVE --binary--> echo PONG
     *
     * Any frame that fails to parse / decrypt closes the socket with code 1003.
     * The browser side mirrors this in lan-pair.js.
     */
    private suspend fun DefaultWebSocketServerSession.handleEncryptedSocket() {
        val kp = Crypto.generateKeypair()
        val noncePhone = Crypto.randomNonce()
        var channel: Crypto.SecureChannel? = null
        val json = Json { ignoreUnknownKeys = true }

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
                        val sessionKey = Crypto.deriveSessionKey(kp.privateKey, peerPub, noncePc, noncePhone)
                        channel = Crypto.SecureChannel(sessionKey)

                        val welcome = buildJsonObject {
                            put("t", "WELCOME")
                            put("pub", Crypto.b64encode(kp.publicKey))
                            put("nonce", Crypto.b64encode(noncePhone))
                        }.toString()
                        send(Frame.Text(welcome))
                        Log.i(TAG, "WS /socket: handshake done, session_key derived")
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
                                val echoTs = req["ts"]?.jsonPrimitive?.content?.toLongOrNull()
                                    ?: System.currentTimeMillis()
                                val pong = buildJsonObject {
                                    put("t", "PONG")
                                    put("ts", System.currentTimeMillis())
                                    put("echoTs", echoTs)
                                }.toString().toByteArray(Charsets.UTF_8)
                                send(Frame.Binary(true, ch.seal(pong)))
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
