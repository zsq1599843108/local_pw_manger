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
import kotlinx.serialization.Serializable

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
                routing {
                    get("/ping") {
                        call.respond(PingResponse(
                            app = APP_NAME, ver = APP_VERSION,
                            time = System.currentTimeMillis(),
                            uptimeMs = System.currentTimeMillis() - startedAtMillis
                        ))
                    }
                }
            }.also { it.start(wait = false) }

            startedAtMillis = System.currentTimeMillis()
            running = true
            lastError = null
            updateNotification("Listening on :$PORT")
            Log.i(TAG, "Ktor CIO server started on 0.0.0.0:$PORT")
        } catch (t: Throwable) {
            running = false
            lastError = t.javaClass.simpleName + ": " + (t.message ?: "(no message)")
            updateNotification("Error: $lastError")
            Log.e(TAG, "Ktor failed to start", t)
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
