package com.passman.pair

import android.os.Bundle
import android.util.Log
import androidx.fragment.app.FragmentActivity

/**
 * M3'-B B-3 — invisible host for the biometric CHALLENGE prompt.
 *
 * HotspotServerService can't show a BiometricPrompt (it's a Service, not a
 * FragmentActivity), so on CHALLENGE it parks the request in ChallengeBridge
 * and launches this Activity. We pull the request by id, run the prompt, report
 * the result back through the bridge, and finish immediately — the only UI ever
 * shown is the system biometric sheet (this Activity uses a transparent theme).
 *
 * Platform caveat: starting an Activity from a background Service is restricted
 * on Android 12+. Pairing is interactive (the user is on HotspotPairActivity),
 * so the foreground-app exemption normally applies. Hardening for the truly
 * backgrounded case (a full-screen-intent notification) is a follow-up — see the
 * TODO in HotspotServerService.handleChallenge.
 */
class ChallengePromptActivity : FragmentActivity() {

    companion object {
        const val EXTRA_CHALLENGE_ID = "com.passman.pair.CHALLENGE_ID"
        private const val TAG = "PassManChallenge"
    }

    private var reported = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val id = intent.getStringExtra(EXTRA_CHALLENGE_ID)
        val req = id?.let { ChallengeBridge.peek(it) }
        if (id == null || req == null) {
            // Stale launch (timed out / already handled). Nothing to do.
            Log.w(TAG, "ChallengePromptActivity: no pending request for id=$id")
            finish()
            return
        }

        BiometricChallengeSigner(this).sign(req.fpHex, req.aad) { result ->
            if (!reported) {
                reported = true
                ChallengeBridge.complete(id, result)
            }
            finish()
        }
    }
}
