/**
 * FallbackSecretStoreInstrumentedTest.kt — M3'-B B-6 instrumented test for the
 * ESP-backed fallback secrets (design §8).
 *
 * Runs on a device/emulator only (EncryptedSharedPreferences + MasterKey need
 * the Android framework). Verifies:
 *   - K_pin mint is idempotent (no silent rotation → PC's stored copy stays valid)
 *   - setFallbackPin + verifyFallbackPin round-trip (VERIFIED / REJECTED)
 *   - 3 wrong PINs → LOCKED, and the lockout PERSISTS across a "service restart"
 *     (a fresh FallbackSecretStore + FallbackPinTracker restored from ESP) so a
 *     restart does NOT hand an attacker fresh tries (design §8 core requirement)
 *   - K_bio is never touched here (K_pin is the only key in ESP)
 *
 * Run: ./gradlew :app:connectedDebugAndroidTest  (needs a device/emulator)
 *
 * Pure-JVM crypto (PBKDF2/HMAC/tracker) is covered by FallbackPinTest; this
 * test covers only the Android-framework persistence layer.
 *
 * Test isolation: `@Before resetEsp()` wipes the ESP file once per test, so each
 * test starts clean. `newStore()` builds a fresh instance WITHOUT wiping — that's
 * how "simulate a service restart" works: a second `newStore()` reads back the
 * state the first instance wrote. (An earlier version wiped inside the helper,
 * which self-defeated the cross-restart persistence assertions — a real device
 * run caught it.)
 */

package com.passman.pair

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class FallbackSecretStoreInstrumentedTest {

    private val ctx: android.content.Context
        = ApplicationProvider.getApplicationContext()

    /** Wipe the ESP file once per test so each starts from a clean slate. */
    @Before
    fun resetEsp() {
        ctx.deleteSharedPreferences("passman_fallback")
    }

    /** A fresh store that reads whatever state the ESP file currently holds. */
    private fun newStore(): FallbackSecretStore = FallbackSecretStore(ctx)

    @Test
    fun pinKey_is_idempotent_across_instances() {
        val s1 = newStore()
        val k1 = s1.getOrCreatePinKey()
        assertEquals("K_pin is 32B", Crypto.KEY_SIZE, k1.size)

        // A second instance (simulating a service restart) must read back the
        // SAME K_pin — a silent rotation would force a re-pair (design §9).
        val s2 = newStore()
        val k2 = s2.loadPinKey()
        assertNotNull("K_pin persisted across instances", k2)
        assertArrayEquals("K_pin stable across restart", k1, k2)

        // getOrCreate on the second instance returns the same key, not a new one.
        assertArrayEquals("getOrCreate reuses stored K_pin", k1, s2.getOrCreatePinKey())
    }

    @Test
    fun fresh_pin_key_is_random() {
        // Two independent phones (two clean ESP files) mint different keys.
        val a = newStore().getOrCreatePinKey()
        resetEsp()   // simulate a second phone's fresh ESP
        val b = newStore().getOrCreatePinKey()
        assertNotEquals("two phones mint different K_pin", a.toList(), b.toList())
    }

    @Test
    fun setPin_then_correct_pin_verifies_wrong_rejected() {
        val s = newStore()
        s.setFallbackPin("4271")
        val tr = Crypto.FallbackPinTracker()
        assertEquals(FallbackSecretStore.PinCheck.VERIFIED, s.verifyFallbackPin("4271", tr))
        assertEquals(FallbackSecretStore.PinCheck.REJECTED, s.verifyFallbackPin("0000", tr))
        assertFalse("correct PIN reset the tracker", tr.isLocked())
    }

    @Test
    fun three_wrong_pins_lock_and_persists_across_restart() {
        val s1 = newStore()
        s1.setFallbackPin("1234")
        val tr1 = Crypto.FallbackPinTracker()
        assertEquals(FallbackSecretStore.PinCheck.REJECTED, s1.verifyFallbackPin("0000", tr1))
        assertEquals(FallbackSecretStore.PinCheck.REJECTED, s1.verifyFallbackPin("0001", tr1))
        assertEquals(FallbackSecretStore.PinCheck.REJECTED, s1.verifyFallbackPin("0002", tr1))
        assertTrue("3 wrong → locked in-process", tr1.isLocked())

        // Simulate a service restart: fresh store + fresh tracker, restore lockout
        // from ESP. The lockout MUST survive — a restart must not grant fresh tries.
        val s2 = newStore()
        val tr2 = Crypto.FallbackPinTracker()
        s2.restoreLockout(tr2)
        assertTrue("lockout persisted across restart", tr2.isLocked())
        // Even the CORRECT pin is blocked while locked.
        assertEquals(
            "locked channel refuses even the correct PIN",
            FallbackSecretStore.PinCheck.LOCKED,
            s2.verifyFallbackPin("1234", tr2),
        )
    }

    @Test
    fun verify_before_pin_set_returns_not_set() {
        val s = newStore()
        val tr = Crypto.FallbackPinTracker()
        assertEquals(
            FallbackSecretStore.PinCheck.NOT_SET,
            s.verifyFallbackPin("1234", tr),
        )
    }

    @Test
    fun setting_pin_clears_prior_lockout() {
        val s1 = newStore()
        s1.setFallbackPin("1234")
        val tr1 = Crypto.FallbackPinTracker()
        repeat(3) { s1.verifyFallbackPin("0000", tr1) }
        assertTrue(tr1.isLocked())

        // User re-sets the PIN (e.g. forgot it, re-paired) → fresh start.
        // setFallbackPin wipes the lockout entry; a restart then reads NO lockout.
        val s2 = newStore()
        s2.setFallbackPin("9999")
        val tr2 = Crypto.FallbackPinTracker()
        s2.restoreLockout(tr2)
        assertFalse("re-setting PIN clears the lockout (not the restart)", tr2.isLocked())
        assertEquals(FallbackSecretStore.PinCheck.VERIFIED, s2.verifyFallbackPin("9999", tr2))
    }

    /**
     * End-to-end: after a "restart", the SAME K_pin (read back from ESP) still
     * produces a challenge HMAC the PC would accept — i.e. the persisted K_pin
     * is the live fallback key, not a stale copy. Guards against a future change
     * that minted a fresh K_pin on every instance and silently broke the PC's
     * stored copy (design §9).
     */
    @Test
    fun persisted_pin_key_still_signs_after_restart() {
        val s1 = newStore()
        val k1 = s1.getOrCreatePinKey()

        // A challenge AAD (shape from Crypto.buildChallengeAad; constants chosen
        // to satisfy its preconditions without a full challenge frame).
        val id = "0123456789abcdef"
        val nonce = ByteArray(Crypto.CHAL_NONCE_SIZE) { it.toByte() }
        val fingerprintRaw = ByteArray(32) { (it + 1).toByte() }
        val aad = Crypto.buildChallengeAad(id, nonce, "unlock", 1L, fingerprintRaw)
        val sig1 = Crypto.computeChallengeHmac(k1, aad)

        // "Restart": read K_pin back from ESP and sign the same AAD.
        val k2 = newStore().loadPinKey()
        assertNotNull("K_pin readable after restart", k2)
        val sig2 = Crypto.computeChallengeHmac(k2!!, aad)

        assertArrayEquals("restarted K_pin signs identically", sig1, sig2)
    }
}
