package com.passman.pair

import kotlinx.coroutines.CompletableDeferred
import java.util.concurrent.ConcurrentHashMap

/**
 * M3'-B B-5 — handoff between the Ktor server coroutine (HotspotServerService)
 * and the fallback-PIN entry Activity, mirroring ChallengeBridge.
 *
 * Two modes, distinguished by the Request.kind:
 *   SET    — first pairing; the user sets a new 4-digit PIN (twice for confirm).
 *            Result is the chosen PIN string (the Service hashes+stores it via
 *            FallbackSecretStore.setFallbackPin), or null if the user cancelled.
 *   VERIFY — a FALLBACK_PIN arrived; the user types the PIN to authorise the
 *            challenge. Result is the typed PIN string (the Service verifies it
 *            via FallbackSecretStore.verifyFallbackPin), or null if cancelled.
 *
 * The Service parks a CompletableDeferred here keyed by request id, launches
 * FallbackPinActivity, and awaits the result. The Activity completes the
 * Deferred and finishes. State is transient — one entry per in-flight request.
 */
object FallbackPinBridge {

    enum class Kind { SET, VERIFY }

    data class Request(val id: String, val kind: Kind)

    sealed class Result {
        /** User submitted a PIN (chosen in SET mode, or typed in VERIFY mode). */
        data class Submitted(val pin: String) : Result()
        /** User cancelled / backed out. */
        object Cancelled : Result()
    }

    private val requests = ConcurrentHashMap<String, Request>()
    private val results = ConcurrentHashMap<String, CompletableDeferred<Result>>()

    /** Service: register a pending PIN request and get the Deferred to await. */
    fun enqueue(req: Request): CompletableDeferred<Result> {
        val d = CompletableDeferred<Result>()
        requests[req.id] = req
        results[req.id] = d
        return d
    }

    /** Activity: read the request to act on (peek — does not remove). */
    fun peek(id: String): Request? = requests[id]

    /** Activity: report the outcome and clean up. No-op if already cancelled. */
    fun complete(id: String, result: Result) {
        requests.remove(id)
        results.remove(id)?.complete(result)
    }

    /** Service: drop a pending request (timeout / socket closed). */
    fun cancel(id: String) {
        requests.remove(id)
        results.remove(id)
    }
}
