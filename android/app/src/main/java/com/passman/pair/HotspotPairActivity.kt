package com.passman.pair

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Bundle
import android.text.method.ScrollingMovementMethod
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.net.Inet4Address
import java.net.NetworkInterface
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * M1' (ADR-002) primary launcher activity.
 *
 * What this screen does:
 *   1. Lets the user start/stop HotspotServerService (the Ktor :9876 server).
 *   2. Surfaces the phone's local IPv4 addresses across all interfaces, so
 *      the user knows which one to type into the PC pairing UI (typically
 *      192.168.43.1 — Android's default hotspot gateway).
 *   3. Surfaces the running state, last error, and uptime.
 *
 * What this screen does NOT do (M1' scope):
 *   - It does not turn the hotspot itself ON or OFF — Android 8.0+ blocks
 *     apps from doing that. The user must enable hotspot via system settings.
 *   - It does not display SSID/password (handled by system settings UI).
 *
 * Permissions handled here:
 *   - POST_NOTIFICATIONS (API 33+) — runtime; needed for the foreground notif.
 *
 * Polls service status every 1s while in foreground (kept simple — M4'
 * could switch to LiveData / broadcasts if reactive UI matters).
 */
class HotspotPairActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "PassManHotspotUI"
        private const val REQ_NOTIF = 1001
        private val TIME_FMT = SimpleDateFormat("HH:mm:ss", Locale.US)
    }

    private lateinit var statusView: TextView
    private lateinit var ipsView: TextView
    private lateinit var startBtn: Button
    private lateinit var stopBtn: Button
    private lateinit var logView: TextView

    private val pollHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val pollRunnable = object : Runnable {
        override fun run() {
            refreshStatus()
            pollHandler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        ensureNotificationPermission()
        log("Activity created. Tap START to launch the Ktor server on :${HotspotServerService.PORT}.")
        log("Then enable Wi-Fi hotspot from system settings; the PC connects to the hotspot.")
    }

    override fun onResume() {
        super.onResume()
        pollHandler.post(pollRunnable)
    }

    override fun onPause() {
        super.onPause()
        pollHandler.removeCallbacks(pollRunnable)
    }

    private fun buildUi(): View {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }

        TextView(this).apply {
            text = "PassMan — Wi-Fi Pairing (M1' PoC)"
            textSize = 20f
            gravity = Gravity.CENTER
            setPadding(0, pad, 0, pad)
        }.also(root::addView)

        statusView = TextView(this).apply {
            textSize = 14f
            setPadding(0, 0, 0, pad / 2)
        }
        root.addView(statusView)

        ipsView = TextView(this).apply {
            textSize = 12f
            typeface = android.graphics.Typeface.MONOSPACE
            setPadding(0, 0, 0, pad)
        }
        root.addView(ipsView)

        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }
        startBtn = Button(this).apply {
            text = "Start server"
            setOnClickListener {
                HotspotServerService.startServer(this@HotspotPairActivity)
                log("→ requested START")
            }
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        stopBtn = Button(this).apply {
            text = "Stop server"
            setOnClickListener {
                HotspotServerService.stopServer(this@HotspotPairActivity)
                log("→ requested STOP")
            }
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        btnRow.addView(startBtn)
        btnRow.addView(stopBtn)
        root.addView(btnRow)

        Button(this).apply {
            text = "Open Biometric Demo"
            setOnClickListener {
                startActivity(Intent(this@HotspotPairActivity, BiometricDemoActivity::class.java))
            }
        }.also(root::addView)

        Button(this).apply {
            text = "Open system Wi-Fi hotspot settings"
            setOnClickListener {
                try {
                    // Direct Settings.Panel constant exists for Wi-Fi but not hotspot;
                    // fall back to tethering settings which is broadly supported.
                    startActivity(Intent("android.settings.TETHER_SETTINGS"))
                } catch (e: Exception) {
                    log("⚠️ couldn't open tether settings: ${e.message}; open it manually")
                }
            }
        }.also(root::addView)

        TextView(this).apply {
            text = "Log:"
            setPadding(0, pad, 0, 0)
        }.also(root::addView)

        logView = TextView(this).apply {
            textSize = 11f
            typeface = android.graphics.Typeface.MONOSPACE
            setPadding(pad / 2, pad / 2, pad / 2, pad / 2)
            movementMethod = ScrollingMovementMethod()
            isVerticalScrollBarEnabled = true
            setBackgroundColor(0xFFEEEEEE.toInt())
        }
        ScrollView(this).apply {
            addView(logView)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { weight = 1f }
        }.also(root::addView)

        return root
    }

    private fun refreshStatus() {
        val running = HotspotServerService.running
        val err     = HotspotServerService.lastError
        val uptime  = if (running && HotspotServerService.startedAtMillis > 0)
            System.currentTimeMillis() - HotspotServerService.startedAtMillis
        else 0L

        statusView.text = when {
            running && err == null -> "✅ Listening on :${HotspotServerService.PORT}  ·  uptime ${formatUptime(uptime)}"
            running && err != null -> "⚠️ Listening (last error: $err)"
            err != null            -> "❌ Stopped — last error: $err"
            else                   -> "⏸ Stopped"
        }
        startBtn.isEnabled = !running
        stopBtn.isEnabled  = running

        ipsView.text = "Local IPv4 addresses (any of these may be the PC's pairing target):\n" +
                       collectIpv4().joinToString("\n") { "  • $it" }
    }

    /** Iterates network interfaces and returns "iface=ip" strings for IPv4 addresses. */
    private fun collectIpv4(): List<String> {
        val out = mutableListOf<String>()
        try {
            val ifaces = NetworkInterface.getNetworkInterfaces() ?: return out
            for (iface in ifaces) {
                if (!iface.isUp || iface.isLoopback) continue
                for (addr in iface.inetAddresses) {
                    if (addr is Inet4Address && !addr.isLoopbackAddress) {
                        out.add("${iface.name} → ${addr.hostAddress}")
                    }
                }
            }
        } catch (t: Throwable) {
            out.add("(error enumerating interfaces: ${t.message})")
        }
        if (out.isEmpty()) out.add("(none — Wi-Fi off?)")
        return out
    }

    private fun formatUptime(ms: Long): String {
        val s = ms / 1000
        return if (s < 60) "${s}s" else "${s / 60}m${s % 60}s"
    }

    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int,
                                            permissions: Array<out String>,
                                            grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_NOTIF) {
            val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
            log("notification permission: ${if (granted) "granted" else "denied"}")
        }
    }

    private fun log(line: String) {
        val stamp = TIME_FMT.format(Date())
        val full = "[$stamp] $line"
        android.util.Log.i(TAG, line)
        runOnUiThread { logView.append(full + "\n") }
    }
}
