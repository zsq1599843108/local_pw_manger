package com.passman.pair

import kotlinx.coroutines.CompletableDeferred
import java.util.concurrent.ConcurrentHashMap

/**
 * M3'-B B-3 — handoff between the Ktor server coroutine (HotspotServerService)
 * and the BiometricPrompt host (ChallengePromptActivity).
 *
 * BiometricPrompt requires a FragmentActivity, but a CHALLENGE arrives on a
 * background Service coroutine. The Service builds the request, parks a
 * CompletableDeferred here, launches the prompt Activity, and awaits the
 * Deferred; the Activity runs the prompt and completes it. Keyed by the
 * challenge id so concurrent challenges don't collide.
 *
 * State here is transient (one entry per in-flight challenge) and cleaned up on
 * complete()/cancel(). Survives a config-change recreation of the Activity only
 * if the Activity peeks rather than removes — see ChallengePromptActivity.
 */
object ChallengeBridge {

    data class Request(val id: String, val fpHex: String, val aad: ByteArray) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Request) return false
            return id == other.id && fpHex == other.fpHex && aad.contentEquals(other.aad)
        }
        override fun hashCode(): Int =
            31 * (31 * id.hashCode() + fpHex.hashCode()) + aad.contentHashCode()
    }

    private val requests = ConcurrentHashMap<String, Request>()
    private val results = ConcurrentHashMap<String, CompletableDeferred<BiometricChallengeSigner.Result>>()

    /** Service: register a pending challenge and get the Deferred to await. */
    fun enqueue(req: Request): CompletableDeferred<BiometricChallengeSigner.Result> {
        val d = CompletableDeferred<BiometricChallengeSigner.Result>()
        requests[req.id] = req
        results[req.id] = d
        return d
    }

    /** Activity: read the request to act on (peek — does not remove). */
    fun peek(id: String): Request? = requests[id]

    /** Activity: report the outcome and clean up. No-op if already cancelled. */
    fun complete(id: String, result: BiometricChallengeSigner.Result) {
        requests.remove(id)
        results.remove(id)?.complete(result)
    }

    /** Service: drop a pending challenge (timeout / socket closed). */
    fun cancel(id: String) {
        requests.remove(id)
        results.remove(id)
    }
}
