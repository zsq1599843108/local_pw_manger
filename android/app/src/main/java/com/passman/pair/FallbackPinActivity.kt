package com.passman.pair

import android.os.Bundle
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.util.Log
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * M3'-B B-5 — 4-digit fallback PIN entry, hosted in its own Activity because
 * HotspotServerService is a background Service and can't show UI.
 *
 * Two modes (FallbackPinBridge.Request.kind):
 *   SET    — first pairing; user chooses a 4-digit PIN and confirms it. The
 *            chosen PIN is handed back to the Service, which hashes+stores it.
 *   VERIFY — a paired PC sent FALLBACK_PIN; the user types the PIN to authorise
 *            the challenge. The typed PIN is handed back for local verification.
 *
 * The Activity is launched by the Service with FLAG_ACTIVITY_NEW_TASK (the
 * Android 12+ background-Activity-start caveat noted in handleChallenge applies;
 * pairing is interactive so the foreground-app exemption covers the common case).
 * Finishes as soon as a result is reported. Not exported — only our Service.
 */
class FallbackPinActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_PIN_REQUEST_ID = "com.passman.pair.PIN_REQUEST_ID"
        private const val TAG = "PassManFallbackPin"
        private const val PIN_LEN = 4
    }

    private var reported = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val id = intent.getStringExtra(EXTRA_PIN_REQUEST_ID)
        val req = id?.let { FallbackPinBridge.peek(it) }
        if (id == null || req == null) {
            Log.w(TAG, "no pending PIN request for id=$id")
            finish(); return
        }
        setContentView(buildUi(req.kind))
    }

    private fun buildUi(kind: FallbackPinBridge.Kind): View {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            gravity = Gravity.CENTER_HORIZONTAL
        }

        val title = TextView(this).apply {
            text = if (kind == FallbackPinBridge.Kind.SET)
                "Set a 4-digit fallback PIN" else "Enter your fallback PIN"
            textSize = 18f
            setPadding(0, 0, 0, pad)
        }
        root.addView(title)

        val hintView = TextView(this).apply {
            text = if (kind == FallbackPinBridge.Kind.SET)
                "Used only when your fingerprint is unavailable. It can unlock, " +
                "but never authorise destructive sync or plaintext export."
            else
                "A paired PC is asking you to confirm it's you."
            textSize = 12f
            setPadding(0, 0, 0, pad)
        }
        root.addView(hintView)

        val entry = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            filters = arrayOf(InputFilter.LengthFilter(PIN_LEN))
            hint = "4 digits"
            textSize = 20f
            gravity = Gravity.CENTER
            val w = (120 * resources.displayMetrics.density).toInt()
            layoutParams = LinearLayout.LayoutParams(w, LinearLayout.LayoutParams.WRAP_CONTENT)
        }
        root.addView(entry)

        // SET mode: a second field to confirm the PIN.
        val confirm = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            filters = arrayOf(InputFilter.LengthFilter(PIN_LEN))
            hint = if (kind == FallbackPinBridge.Kind.SET) "confirm" else ""
            textSize = 20f
            gravity = Gravity.CENTER
            visibility = if (kind == FallbackPinBridge.Kind.SET) View.VISIBLE else View.GONE
            val w = (120 * resources.displayMetrics.density).toInt()
            layoutParams = LinearLayout.LayoutParams(w, LinearLayout.LayoutParams.WRAP_CONTENT)
        }
        root.addView(confirm)

        val status = TextView(this).apply {
            textSize = 12f
            setPadding(0, pad / 2, 0, pad / 2)
        }
        root.addView(status)

        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val cancel = Button(this).apply { text = "Cancel" }
        val submit = Button(this).apply {
            text = if (kind == FallbackPinBridge.Kind.SET) "Set PIN" else "Unlock"
            isEnabled = false
        }
        cancel.layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        submit.layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        row.addView(cancel); row.addView(submit)
        root.addView(row)

        // Enable submit only when the entry is a full 4 digits (and, in SET
        // mode, the confirm field matches).
        val watcher = object : TextWatcher {
            override fun afterTextChanged(s: Editable?) {
                val p = entry.text.toString()
                val ready = if (kind == FallbackPinBridge.Kind.SET) {
                    p.length == PIN_LEN && confirm.text.toString() == p
                } else {
                    p.length == PIN_LEN
                }
                submit.isEnabled = ready
                if (kind == FallbackPinBridge.Kind.SET && p.length == PIN_LEN &&
                    confirm.text.length == PIN_LEN && confirm.text.toString() != p) {
                    status.text = "PINs don't match"
                } else {
                    status.text = ""
                }
            }
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        }
        entry.addTextChangedListener(watcher)
        confirm.addTextChangedListener(watcher)

        val requestId = intent.getStringExtra(EXTRA_PIN_REQUEST_ID)!!

        fun report(result: FallbackPinBridge.Result) {
            if (reported) return
            reported = true
            FallbackPinBridge.complete(requestId, result)
            finish()
        }
        cancel.setOnClickListener { report(FallbackPinBridge.Result.Cancelled) }
        submit.setOnClickListener {
            val pin = entry.text.toString()
            if (pin.length == PIN_LEN) report(FallbackPinBridge.Result.Submitted(pin))
        }

        return root
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        val id = intent.getStringExtra(EXTRA_PIN_REQUEST_ID) ?: return super.onBackPressed()
        if (!reported) {
            reported = true
            FallbackPinBridge.complete(id, FallbackPinBridge.Result.Cancelled)
        }
        @Suppress("DEPRECATION")
        super.onBackPressed()
    }
}
