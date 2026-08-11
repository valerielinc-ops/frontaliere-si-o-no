/**
 * classify() — pure classifier behind
 * scripts/restore-mailtrap-suspension-suppressions.mjs. Extracted so it is
 * importable without triggering that script's module-level
 * `admin.initializeApp()` (would require live Firestore credentials in
 * tests) — a pattern this codebase already applies elsewhere to keep
 * suppression-decision regexes/constants unit-testable.
 *
 * A subscriber's `events` subcollection is classified into three
 * independent signals the caller combines to decide whether a
 * `status: 'suppressed'` doc is restorable:
 *   - sawSuspension: at least one `suppressed` event whose provider event is
 *     Mailtrap's `suspension` (the account/stream-level signal that was
 *     mis-mapped into a per-subscriber suppression until 2026-07-29).
 *   - sawRealFailure: at least one `suppressed` event from any OTHER cause
 *     (bounce, complaint, reject, or an empty/unrecognised raw event).
 *   - sawUnsubscribe: an explicit opt-out, from either the event log or the
 *     `unsubscribed_at` stamp checked by the caller.
 *
 * A doc restores only when sawSuspension is true AND neither sawRealFailure
 * nor sawUnsubscribe is — see the caller for the full precedence.
 *
 * Deliberately CONSERVATIVE on missing evidence: zero events (or events with
 * no suspension-typed entry) yields `sawSuspension: false`, which the caller
 * treats as "leave suppressed". This is the opposite default from the
 * `isRetryable` grace-period check for the OTHER suppression-recovery
 * runner, which treats a missing age signal as immediately retryable ("no
 * age signal at all — don't block forever on missing data"). The two are
 * not actually the same question asked twice: that check only flips a doc
 * to `pending` and lets the normal send cascade + webhook self-heal on the
 * next bounce (a cheap, reversible action), while `classify()` here decides
 * between `confirmed` and `pending` for a claim about root cause (was THIS
 * suppression really caused by the mis-mapped `suspension` webhook?) that
 * fabricated consent would make worse than the bug it repairs — so on
 * missing evidence it declines rather than guesses. See the test file for
 * both functions for a fixture pinning this exact divergence.
 *
 * @param {Array<{event_type?: string, mailtrap_event?: string, provider_event?: string}>} events
 * @returns {{sawSuspension: boolean, sawRealFailure: boolean, sawUnsubscribe: boolean}}
 */
export function classify(events) {
  let sawSuspension = false;
  let sawRealFailure = false;
  let sawUnsubscribe = false;
  for (const e of events) {
    const type = String(e.event_type || '');
    const raw = String(e.mailtrap_event || e.provider_event || '').toLowerCase();
    if (type === 'unsubscribed' || raw === 'unsubscribe') sawUnsubscribe = true;
    if (type !== 'suppressed') continue;
    // Anything that is not a suspension counts as a real recipient-level
    // failure, INCLUDING an empty/unknown raw event: an unrecognised cause must
    // keep the address suppressed rather than resurrect it on a guess.
    if (raw === 'suspension') sawSuspension = true;
    else sawRealFailure = true;
  }
  return { sawSuspension, sawRealFailure, sawUnsubscribe };
}
