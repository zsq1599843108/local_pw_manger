// lan-pair-protocol.js — message types and PIN verification logic for the
// M3'-A application layer that rides on top of the M2' SecureChannel.
//
// Wire shape: each direction sends UTF-8 JSON blobs through SecureChannel.seal,
// of the form { t: <type>, ... }. Types in use:
//
//   PING            { t:'PING', ts }
//   PONG            { t:'PONG', ts, echoTs }
//   PAIR_REQUEST    { t:'PAIR_REQUEST', pin: '123456', w: <window-number> }
//                     PC -> phone, asking to be trusted. `w` is the rolling
//                     window the PC computed the PIN for (so the phone can
//                     try w, w-1, w+1 to mask clock skew within ±30s).
//   PAIR_OK         { t:'PAIR_OK', fingerprint, label }
//                     phone -> PC, sent only after the user pressed "trust" on
//                     the phone AND the PIN matched.
//   PAIR_REJECT     { t:'PAIR_REJECT', reason: 'bad_pin'|'locked'|'user_denied'|'no_match' }
//                     phone -> PC, the offending PAIR_REQUEST is discarded.
//                     'locked' means the attempt tracker is rate-limited; the
//                     phone *should* keep the channel open so the user can
//                     wait and retry, but the PC may also choose to bail.
//
// This module intentionally has no IO and no crypto — it just normalizes the
// envelope so PC and phone agree on the shape, and isolates the lockout logic
// so we can unit-test it without spinning up a real handshake.

'use strict';

const MSG = Object.freeze({
  PING:          'PING',
  PONG:          'PONG',
  PAIR_REQUEST:  'PAIR_REQUEST',
  PAIR_OK:       'PAIR_OK',
  PAIR_REJECT:   'PAIR_REJECT',
});

const REJECT = Object.freeze({
  BAD_PIN:      'bad_pin',
  LOCKED:       'locked',
  USER_DENIED:  'user_denied',
  NO_MATCH:     'no_match',     // legitimate-but-stale PIN window
});

function encode(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

function decode(plaintext) {
  // Caller has already verified GCM auth — we only need to parse JSON.
  return JSON.parse(Buffer.from(plaintext).toString('utf8'));
}

/**
 * In-memory sliding-window rate limiter for failed pairing attempts.
 *
 * Default: 5 failures within 60 seconds -> "locked" for the rest of the window.
 * Service restart clears the tracker, which is fine per design (the attacker
 * can't restart it remotely; in fact we *prefer* the restart-resets-counter
 * behaviour over persistent disk state that could survive a user reboot and
 * frustrate them).
 *
 * Construct with { maxFailures, windowMs } if you want different policy in
 * a test.
 */
class PairAttemptTracker {
  constructor({ maxFailures = 5, windowMs = 60_000, now = () => Date.now() } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this._now = now;
    this._failures = [];     // unix-ms timestamps, oldest first
  }

  /** Returns true iff the caller is currently locked out (do not even check the PIN). */
  isLocked() {
    this._prune();
    return this._failures.length >= this.maxFailures;
  }

  /** Note a failed PIN attempt at "now". */
  recordFailure() {
    this._failures.push(this._now());
    this._prune();
  }

  /** Forget all failures (call on success or on explicit user reset). */
  reset() {
    this._failures = [];
  }

  /** ms until the oldest failure in the window expires; 0 if not locked. */
  unlockInMs() {
    this._prune();
    if (this._failures.length < this.maxFailures) return 0;
    const earliestRelevant = this._failures[this._failures.length - this.maxFailures];
    return Math.max(0, earliestRelevant + this.windowMs - this._now());
  }

  _prune() {
    const cutoff = this._now() - this.windowMs;
    while (this._failures.length && this._failures[0] < cutoff) this._failures.shift();
  }
}

/**
 * Constant-time string equality. Returns true iff `a` and `b` have the same
 * length and the same bytes; runs in O(len) regardless of where (or whether)
 * they differ. Mirrors Crypto.kt#constantTimeEquals so PC and phone behave
 * identically under timing analysis.
 *
 * Only suitable for short inputs of comparable length — for a 6-digit PIN
 * that's a 6-iteration loop, vanishingly cheap.
 */
function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Decide whether a submitted PIN is accepted for window `submittedW`, by
 * comparing against the PINs the *phone* would have computed for windows
 * w-1, w, w+1 (one window of skew slack on each side = ±30s ≤ ±45s, which
 * is well within typical clock drift between consumer devices).
 *
 * `pinForWindow` is an async function (w:bigint) => '123456'. Returns
 * { ok: true, matchedW } on match, or { ok: false } on no match.
 *
 * Both `submittedW` and the windows passed to pinForWindow are BigInt so
 * the call site doesn't lose precision past 2^53/30000 ms (~2873 years —
 * not really an issue but we follow secure.js's convention).
 *
 * Comparison is constant-time per candidate (see constantTimeEquals); the
 * outer loop still runs all `2*skew+1` iterations even on match so the
 * decision time leaks at most "did it match at all", not "which window".
 */
async function verifyPin({ submittedPin, submittedW, pinForWindow, skew = 1 }) {
  const sw = BigInt(submittedW);
  let matchedW = null;
  for (let off = -skew; off <= skew; off++) {
    const w = sw + BigInt(off);
    const expected = await pinForWindow(w);
    // Run every iteration even after a match: keeps the loop count constant
    // regardless of where (or whether) the hit is, and `constantTimeEquals`
    // keeps each comparison constant-time too.
    if (constantTimeEquals(expected, submittedPin) && matchedW === null) {
      matchedW = w;
    }
  }
  return matchedW === null ? { ok: false } : { ok: true, matchedW };
}

module.exports = {
  MSG, REJECT,
  encode, decode,
  PairAttemptTracker,
  verifyPin,
  constantTimeEquals,
};
