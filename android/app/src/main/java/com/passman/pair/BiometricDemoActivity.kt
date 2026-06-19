package com.passman.pair

import android.os.Build
import android.os.Bundle
import android.text.method.ScrollingMovementMethod
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * M1.5 PoC: prove BiometricPrompt works on this phone before M3 puts it in the
 * critical pairing path. No USB, no crypto — just opens the system fingerprint
 * UI, surfaces success/failure to a TextView, and dumps everything to logcat
 * (`adb logcat -s PassManBio`).
 *
 * BIOMETRIC_STRONG (Class 3) is required for any production use because Class 2
 * fingerprint can be bypassed on some OEM ROMs. Demo uses STRONG so a refusal
 * here surfaces unsupported-OEM cases (most BLE-only / face-only phones).
 */
class BiometricDemoActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "PassManBio"
        private val TIME_FMT = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
    }

    private lateinit var statusView: TextView
    private lateinit var logView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        log("Activity launched. Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT}) on ${Build.MANUFACTURER} ${Build.MODEL}")
        refreshStatus()
    }

    // Programmatically build the UI — avoids needing a res/layout XML for one Activity.
    private fun buildUi(): View {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }

        TextView(this).apply {
            text = "PassMan — Biometric Demo"
            textSize = 22f
            gravity = Gravity.CENTER
            setPadding(0, pad, 0, pad)
        }.also(root::addView)

        statusView = TextView(this).apply {
            textSize = 14f
            setPadding(0, 0, 0, pad)
        }
        root.addView(statusView)

        Button(this).apply {
            text = "Authenticate (BIOMETRIC_STRONG)"
            setOnClickListener { promptStrong() }
        }.also(root::addView)

        Button(this).apply {
            text = "Authenticate (DEVICE_CREDENTIAL fallback)"
            setOnClickListener { promptWithCredentialFallback() }
        }.also(root::addView)

        Button(this).apply {
            text = "Refresh status"
            setOnClickListener { refreshStatus() }
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
            // Light-grey background to set off from white parent.
            setBackgroundColor(0xFFEEEEEE.toInt())
        }
        root.addView(logView)

        return root
    }

    private fun refreshStatus() {
        val mgr = BiometricManager.from(this)
        val authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG or
                             BiometricManager.Authenticators.DEVICE_CREDENTIAL
        val canAuth = mgr.canAuthenticate(authenticators)
        val msg = when (canAuth) {
            BiometricManager.BIOMETRIC_SUCCESS ->
                "✅ Biometric ready (STRONG + device credential)"
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE ->
                "❌ No biometric hardware"
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE ->
                "⚠️ Hardware temporarily unavailable"
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED ->
                "⚠️ No fingerprint enrolled — set one up in Settings first"
            BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED ->
                "⚠️ Android security update required"
            BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED ->
                "❌ Unsupported on this device"
            BiometricManager.BIOMETRIC_STATUS_UNKNOWN ->
                "❓ Status unknown (still being determined)"
            else -> "❓ Unexpected status: $canAuth"
        }
        statusView.text = msg
        log("canAuthenticate(STRONG | DEVICE_CREDENTIAL) → $msg")
    }

    private fun promptStrong() {
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("PassMan — Verify Fingerprint")
            .setSubtitle("Demo — proves M1.5 biometric path")
            .setDescription("M3 will use this same prompt to gate the master-password challenge.")
            .setNegativeButtonText("Cancel")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setConfirmationRequired(false)
            .build()
        showPrompt(info, label = "STRONG")
    }

    private fun promptWithCredentialFallback() {
        // Note: setAllowedAuthenticators(STRONG | DEVICE_CREDENTIAL) is incompatible
        // with setNegativeButtonText. The system shows its own cancel UI.
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("PassMan — Verify (Bio or PIN)")
            .setSubtitle("Demo with PIN/pattern/password fallback")
            .setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_STRONG or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
            )
            .build()
        showPrompt(info, label = "STRONG+CREDENTIAL")
    }

    private fun showPrompt(info: BiometricPrompt.PromptInfo, label: String) {
        val executor = ContextCompat.getMainExecutor(this)
        val prompt = BiometricPrompt(this, executor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val type = when (result.authenticationType) {
                    BiometricPrompt.AUTHENTICATION_RESULT_TYPE_BIOMETRIC      -> "biometric"
                    BiometricPrompt.AUTHENTICATION_RESULT_TYPE_DEVICE_CREDENTIAL -> "device_credential"
                    else -> "unknown(${result.authenticationType})"
                }
                log("[$label] ✅ AUTH OK via $type")
                Toast.makeText(this@BiometricDemoActivity,
                    "Authenticated via $type", Toast.LENGTH_SHORT).show()
            }

            override fun onAuthenticationFailed() {
                // Fingerprint mismatch (no error code; user can retry within prompt).
                log("[$label] ✗ fingerprint not recognised (system will let user retry)")
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                // Terminal — prompt is dismissed.
                log("[$label] ❌ ERROR $errorCode: $errString")
            }
        })
        log("[$label] showing prompt…")
        prompt.authenticate(info)
    }

    private fun log(line: String) {
        val stamp = TIME_FMT.format(Date())
        val full = "[$stamp] $line"
        android.util.Log.i(TAG, line)
        runOnUiThread {
            logView.append(full + "\n")
            // Keep the most recent line visible.
            val scroll = logView.layout?.getLineTop(logView.lineCount) ?: 0
            val pad = logView.height
            if (scroll > pad) logView.scrollTo(0, scroll - pad)
        }
    }
}
