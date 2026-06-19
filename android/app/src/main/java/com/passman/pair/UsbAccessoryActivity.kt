package com.passman.pair

// ⚠️ DEPRECATED 2026-06-19 — only ever activates on Linux/macOS; Windows
// host-side AOAP handshake is blocked by the MTP driver (see ADR-002). The
// APK still ships this Activity for cross-platform completeness, but the
// primary pairing path moves to TetheringServerService (Wi-Fi hotspot, M1').

import android.app.Activity
import android.content.Intent
import android.hardware.usb.UsbAccessory
import android.hardware.usb.UsbManager
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.util.Log
import android.widget.Toast
import java.io.FileInputStream
import java.io.FileOutputStream
import kotlin.concurrent.thread

/**
 * M1 PoC: when the user confirms the system "Open PassMan?" dialog, this
 * Activity is launched with USB_ACCESSORY_ATTACHED. We open the accessory's
 * file descriptor and start a thread that reads bytes from PC and echoes
 * them back, prefixed with "ECHO:".
 *
 * This is intentionally minimal — M2 replaces the echo loop with TLV frame
 * decoding (Frame.kt). The PC side calls bulk transferIn/transferOut via
 * src/public/js/aoap.js → frame.js (M2).
 *
 * Theme is Theme.NoDisplay so the user sees no UI; everything goes to logcat:
 *   adb logcat -s PassManAOAP
 * (yes, adb works without USB debugging once the device is in accessory mode
 *  — but on a non-debug device you'll watch via Toast or wired-on-second-cable.)
 */
class UsbAccessoryActivity : Activity() {

    companion object {
        private const val TAG = "PassManAOAP"
        // USB bulk endpoints have a max packet size of 512 bytes (full speed) or
        // up to 1024 (high speed). Reading up to 16 KiB groups multiple packets
        // efficiently without bloating heap.
        private const val READ_BUF_SIZE = 16 * 1024
    }

    private var pfd: ParcelFileDescriptor? = null
    private var inStream: FileInputStream? = null
    private var outStream: FileOutputStream? = null
    private var ioThread: Thread? = null
    @Volatile private var running = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val accessory: UsbAccessory? =
            intent.getParcelableExtra(UsbManager.EXTRA_ACCESSORY)

        if (accessory == null) {
            // Manually launched from the launcher — nothing to do.
            Log.i(TAG, "Activity started without USB_ACCESSORY_ATTACHED extra; finishing.")
            Toast.makeText(this, "Plug in PC via USB to pair.", Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        Log.i(TAG, "Accessory attached: " +
                "manufacturer=${accessory.manufacturer}, " +
                "model=${accessory.model}, " +
                "version=${accessory.version}, " +
                "description=${accessory.description}")

        val usbManager = getSystemService(USB_SERVICE) as UsbManager
        val descriptor = usbManager.openAccessory(accessory)
        if (descriptor == null) {
            Log.e(TAG, "openAccessory returned null — permission denied?")
            Toast.makeText(this, "Failed to open USB accessory.", Toast.LENGTH_LONG).show()
            finish()
            return
        }

        pfd = descriptor
        val fd = descriptor.fileDescriptor
        inStream = FileInputStream(fd)
        outStream = FileOutputStream(fd)

        running = true
        ioThread = thread(name = "passman-aoap-io", start = true) { runEchoLoop() }
    }

    /**
     * M1 echo loop: read bytes, log them, write "ECHO:<bytes>" back.
     * Termination conditions:
     *   - PC closes (read returns -1 or throws)
     *   - Activity is destroyed (running=false)
     */
    private fun runEchoLoop() {
        val buf = ByteArray(READ_BUF_SIZE)
        val input = inStream ?: return
        val output = outStream ?: return

        try {
            while (running) {
                val n = input.read(buf)
                if (n < 0) {
                    Log.i(TAG, "EOF from PC, ending echo loop.")
                    break
                }
                if (n == 0) continue

                // Log up to 64 bytes as printable ASCII (useful for "HELLO from PC" sniff test)
                val preview = String(buf, 0, minOf(n, 64), Charsets.UTF_8)
                Log.i(TAG, "RX $n bytes: \"$preview\"${if (n > 64) "…" else ""}")

                // Echo back with prefix so PC can confirm phone-side processed it.
                val prefix = "ECHO:".toByteArray(Charsets.UTF_8)
                output.write(prefix)
                output.write(buf, 0, n)
                output.flush()
                Log.i(TAG, "TX ${prefix.size + n} bytes back to PC")
            }
        } catch (t: Throwable) {
            // PC unplug typically lands here as IOException("Stale file handle"). Not fatal.
            Log.w(TAG, "Echo loop ended: ${t.javaClass.simpleName}: ${t.message}")
        } finally {
            running = false
            // Don't finish() here — Activity teardown happens in onDestroy.
            runOnUiThread { finish() }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        running = false
        try { inStream?.close() } catch (_: Throwable) {}
        try { outStream?.close() } catch (_: Throwable) {}
        try { pfd?.close() } catch (_: Throwable) {}
        ioThread?.join(500)
    }
}
