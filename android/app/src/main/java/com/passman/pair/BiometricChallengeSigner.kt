package com.passman.pair

import android.security.keystore.KeyPermanentlyInvalidatedException
import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

/**
 * M3'-B B-2 — drives the system BiometricPrompt to produce a challenge HMAC.
 *
 * The HMAC key lives in the AndroidKeyStore behind a bio gate (timeout=0), so
 * computing the HMAC requires a live fingerprint *for this specific operation*:
 * we init a Mac with the Keystore key (Crypto.initChallengeMac), wrap it in a
 * BiometricPrompt.CryptoObject, and only call mac.doFinal(aad) once the prompt
 * reports success. A Frida hook that fakes onAuthenticationSucceeded can't help
 * the attacker — the Mac was never actually unlocked, so doFinal throws.
 *
 * BiometricPrompt needs a FragmentActivity, which is why this lives outside the
 * pure Crypto object and outside the (Service-based) Ktor server. B-3 launches
 * a thin transparent Activity from HotspotServerService to host this prompt.
 *
 * See docs/m3b-biometric-challenge-design.md §5–§6, §11.
 */
class BiometricChallengeSigner(private val activity: FragmentActivity) {

    sealed class Result {
        /** Fingerprint confirmed; `hmac` is the 32B HMAC-SHA256 over the AAD. */
        data class Success(val hmac: ByteArray) : Result()
        /** Enrolled fingerprints changed → key invalidated, user must re-pair (§9). */
        object KeyInvalidated : Result()
        /**
         * Terminal biometric error (cancel, lockout, hw unavailable) or HMAC
         * failure. `androidCode` is the BiometricPrompt.ERROR_* int when the
         * failure came from the prompt (null for non-prompt failures like
         * mac_init), so callers can distinguish "user cancelled" from "lockout".
         */
        data class Error(val code: String, val message: String, val androidCode: Int? = null) : Result()
    }

    companion object { private const val TAG = "PassManChallenge" }

    /**
     * Authenticate and sign. `fpHex` selects the Keystore key; `aad` is the
     * exact bytes from Crypto.buildChallengeAad. `onResult` is always called
     * exactly once, on the main thread.
     */
    fun sign(fpHex: String, aad: ByteArray, onResult: (Result) -> Unit) {
        val mac = try {
            Crypto.initChallengeMac(fpHex)
        } catch (e: KeyPermanentlyInvalidatedException) {
            Log.w(TAG, "device hmac key invalidated by biometric enrollment change")
            onResult(Result.KeyInvalidated); return
        } catch (e: Exception) {
            Log.w(TAG, "initChallengeMac failed: ${e.message}")
            onResult(Result.Error("mac_init_failed", e.message ?: e.toString())); return
        }

        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("PassMan — Confirm with fingerprint")
            .setSubtitle("A paired PC is asking you to confirm it's you")
            .setNegativeButtonText("Cancel")
            // Class 3 only — matches the key's AUTH_BIOMETRIC_STRONG requirement.
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setConfirmationRequired(false)
            .build()

        val executor = ContextCompat.getMainExecutor(activity)
        val prompt = BiometricPrompt(activity, executor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val unlocked = result.cryptoObject?.mac
                if (unlocked == null) {
                    // No CryptoObject came back — never trust a bare success.
                    onResult(Result.Error("no_crypto_object", "auth succeeded without a CryptoObject"))
                    return
                }
                try {
                    onResult(Result.Success(unlocked.doFinal(aad)))
                } catch (e: KeyPermanentlyInvalidatedException) {
                    onResult(Result.KeyInvalidated)
                } catch (e: Exception) {
                    onResult(Result.Error("hmac_failed", e.message ?: e.toString()))
                }
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                // Terminal: cancel, permanent lockout, hw unavailable, etc.
                onResult(Result.Error("bio_error_$errorCode", errString.toString(), androidCode = errorCode))
            }

            // onAuthenticationFailed is non-terminal (a single non-matching
            // finger); the system lets the user retry within the same prompt.
        })

        prompt.authenticate(info, BiometricPrompt.CryptoObject(mac))
    }
}
