/**
 * FallbackPinTest.kt — JVM unit tests for the M3'-B B-5 fallback PIN pieces in
 * Crypto.kt: PBKDF2 hashing/verification and the FallbackPinTracker (3 wrong
 * PINs → 24h lockout, design §7).
 *
 * These are pure-JVM (no Android Keystore / EncryptedSharedPreferences), so they
 * run under app:testDebugUnitTest. The Android-only persistence + PIN-entry
 * Activity land in the next B-5 commit and are exercised on a real device.
 *
 * Run: ./gradlew app:testDebugUnitTest
 */

package com.passman.pair

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNotEquals

class FallbackPinTest {

    // Cheaper than the production 120k so the suite stays fast; the algorithm
    // path is identical, only the iteration count differs.
    private val iters = 1_000

    // ---------- PBKDF2 hashing / verification ----------

    @Test
    fun hash_is_deterministic_for_same_inputs() {
        val salt = ByteArray(16) { it.toByte() }
        val a = Crypto.hashFallbackPin("1234", salt, iters)
        val b = Crypto.hashFallbackPin("1234", salt, iters)
        assertArrayEquals("same pin+salt+iters must hash identically", a, b)
        assertEquals("PBKDF2 hash is 32 bytes", 32, a.size)
    }

    @Test
    fun hash_differs_with_salt() {
        val h1 = Crypto.hashFallbackPin("1234", ByteArray(16) { 0 }, iters)
        val h2 = Crypto.hashFallbackPin("1234", ByteArray(16) { 1 }, iters)
        assertFalse("different salt → different hash", h1.contentEquals(h2))
    }

    @Test
    fun verify_accepts_correct_pin_rejects_wrong() {
        val salt = Crypto.randomFallbackSalt()
        assertEquals(Crypto.FALLBACK_PIN_SALT_SIZE, salt.size)
        val stored = Crypto.hashFallbackPin("4271", salt, iters)
        assertTrue("correct pin verifies", Crypto.verifyFallbackPin("4271", salt, stored, iters))
        assertFalse("wrong pin rejected", Crypto.verifyFallbackPin("4270", salt, stored, iters))
        assertFalse("empty pin rejected", Crypto.verifyFallbackPin("", salt, stored, iters))
        assertFalse("longer pin rejected", Crypto.verifyFallbackPin("42710", salt, stored, iters))
    }

    @Test
    fun random_salt_is_not_constant() {
        assertNotEquals(
            "two random salts should differ",
            Crypto.randomFallbackSalt().toList(),
            Crypto.randomFallbackSalt().toList(),
        )
    }

    // ---------- FallbackPinTracker (3 fails / 24h) ----------

    private class FakeClock(var t: Long = 0L) { fun now(): Long = t }

    @Test
    fun tracker_locks_after_maxFailures() {
        val c = FakeClock(1_000_000L)
        val tr = Crypto.FallbackPinTracker(clock = c::now)
        assertFalse(tr.isLocked())
        tr.recordFailure(); assertFalse("1 fail not locked", tr.isLocked())
        tr.recordFailure(); assertFalse("2 fails not locked", tr.isLocked())
        tr.recordFailure(); assertTrue("3 fails → locked", tr.isLocked())
    }

    @Test
    fun tracker_reset_clears_lock() {
        val c = FakeClock(1_000_000L)
        val tr = Crypto.FallbackPinTracker(clock = c::now)
        repeat(3) { tr.recordFailure() }
        assertTrue(tr.isLocked())
        tr.reset()
        assertFalse("reset (e.g. correct PIN) unlocks", tr.isLocked())
    }

    @Test
    fun tracker_unlocks_after_24h_window() {
        val c = FakeClock(1_000_000L)
        val tr = Crypto.FallbackPinTracker(clock = c::now)
        repeat(3) { tr.recordFailure() }
        assertTrue(tr.isLocked())
        val remaining = tr.unlockInMs()
        assertTrue("unlockInMs ~24h", remaining in (24 * 60 * 60 * 1000L - 10)..(24 * 60 * 60 * 1000L))
        // Advance just shy of the window → still locked.
        c.t += 24 * 60 * 60 * 1000L - 1
        assertTrue("still locked 1ms before window end", tr.isLocked())
        // Cross the window → oldest failures prune out, unlocked.
        c.t += 2
        assertFalse("unlocked after 24h", tr.isLocked())
        assertEquals(0L, tr.unlockInMs())
    }

    @Test
    fun tracker_snapshot_restore_roundtrips() {
        val c = FakeClock(1_000_000L)
        val tr = Crypto.FallbackPinTracker(clock = c::now)
        tr.recordFailure()
        c.t += 1000
        tr.recordFailure()
        val snap = tr.snapshot()
        assertEquals(2, snap.size)

        // A fresh tracker (simulating a service restart) restores the failures
        // and reaches lockout on the 3rd — i.e. the restart did NOT hand out
        // fresh tries (design §8 persistence requirement).
        val restored = Crypto.FallbackPinTracker(clock = c::now)
        restored.restore(snap)
        assertFalse("2 restored fails not locked", restored.isLocked())
        restored.recordFailure()
        assertTrue("3rd fail after restore → locked", restored.isLocked())
    }

    @Test
    fun tracker_restore_prunes_stale_timestamps() {
        val c = FakeClock(100 * 60 * 60 * 1000L)   // 100h in
        val tr = Crypto.FallbackPinTracker(clock = c::now)
        // Two timestamps older than 24h + one recent → only the recent survives.
        tr.restore(longArrayOf(1L, 2L, c.t - 1000))
        assertEquals(1, tr.snapshot().size)
        assertFalse("stale failures don't count toward lockout", tr.isLocked())
    }
}
