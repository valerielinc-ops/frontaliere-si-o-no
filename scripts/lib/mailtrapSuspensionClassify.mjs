import { classifySuppressionDecay, hasConsentEvidence } from './suppressionDecay.mjs';

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
    // Every spelling an opt-out event is actually written under, because they
    // are all in production and only the first was matched here:
    //   'unsubscribed'              — provider webhook normalisation
    //   'unsubscribe'               — functions/src/newsletterSubscriptionManagement.js
    //                                 (both the one-click and the manage-page
    //                                 branches) and, since #5673, the SPA path
    //   'subscription_unsubscribed' — the preferences page toggle
    // `event_type: 'unsubscribe'` is the CANONICAL name in
    // services/newsletterSubscribers.ts's NewsletterEventType, and it was the
    // one this line missed: it only ever matched on the `mailtrap_event` /
    // `provider_event` raw field, which a first-party write does not carry.
    if (type === 'unsubscribed' || type === 'unsubscribe' || type === 'subscription_unsubscribed' || raw === 'unsubscribe') sawUnsubscribe = true;
    if (type !== 'suppressed') continue;
    // Anything that is not a suspension counts as a real recipient-level
    // failure, INCLUDING an empty/unknown raw event: an unrecognised cause must
    // keep the address suppressed rather than resurrect it on a guess.
    if (raw === 'suspension') sawSuspension = true;
    else sawRealFailure = true;
  }
  return { sawSuspension, sawRealFailure, sawUnsubscribe };
}

/**
 * ── THE BLIND SPOT, and why widening the query alone would be dangerous ─────
 *
 * `classify()` above reads ONLY events whose `event_type === 'suppressed'`.
 * That is the whole of its evidence, and it cuts BOTH ways:
 *
 *   - Mailtrap's `reject` is written as `event_type: 'bounce'`, so it is
 *     invisible to `classify()` → `sawRealFailure` stays false → the doc is
 *     restorable. For the 281-address cohort this PR exists for, that is the
 *     CORRECT answer: `mapMailtrapEvent` maps `reject → 'bounce'`,
 *     `classifyBounceSeverity({ provider: 'mailtrap', rawEvent: 'reject' })`
 *     returns `'soft'`, and `bounceUpdateFields({ severity: 'soft' })` does
 *     NOT touch `status` — so with today's code that state is structurally
 *     unproducible. It is the residue of a writer already removed from the
 *     repo, not a verdict anything still stands behind.
 *
 *   - but a GENUINE hard bounce is ALSO written as `event_type: 'bounce'`.
 *     Equally invisible. `classify()` never reads `bounce_severity` and never
 *     applies HARD_BOUNCE_PATTERN.
 *
 * So as long as the caller selected only `status === 'suppressed'` (2 docs in
 * production on 2026-08-11) the blind spot was harmless. Widening the query to
 * `status in ['suppressed','bounced']` — which is the only way to reach the
 * 281 — pulls the hard bounces into the same selection, and the event-log
 * classifier cannot tell them apart. Measured on the real data: the widened
 * query returns 398 docs and the OLD precedence would have restored 295 of
 * them, 14 of which carry `bounce_severity: 'hard'` — including two Gmail
 * `NoSuchUser` ("the email account that you tried to reach does not exist"),
 * one `address unknown`, four escalated after 3 consecutive soft rejects,
 * three mailbox-full and two over-quota marked hard. Resurrecting a mailbox
 * the provider declares nonexistent is the one outcome worse than leaving a
 * live subscriber suppressed.
 *
 * `decideRestore()` therefore puts `classifySuppressionDecay()`'s TERMINAL
 * verdict first in the precedence, ahead of every event-log signal. That
 * single gate covers all four terminal families at once — `hard-severity`
 * (the structured field, which is what catches the escalated docs whose prose
 * matches no hard pattern), `hard-reason` (the legacy regex, for pre-classifier
 * docs), the human stamps, and an exhausted re-probe budget — instead of
 * re-deriving any of them here, which is exactly the duplicated-safety-regex
 * drift AGENTS.md Non-Negotiable #6 forbids.
 *
 * Age-independent BY CONSTRUCTION: only the `terminal` half of the verdict is
 * read, and no terminal branch in `classifySuppressionDecay` consults
 * `ageDays`. `nowMs` is therefore threaded through for reporting only, and the
 * decision is identical whatever clock the caller passes — pinned by a test.
 *
 * @param {object} input
 * @param {object} input.sub subscriber doc fields
 * @param {object[]} [input.events] docs from the subscriber's `events` subcollection
 * @param {number} input.nowMs current time in ms (reporting only — see above)
 * @returns {{restore: boolean, code: string, reason: string, confirmed: boolean, tier: string}}
 */
export function decideRestore({ sub = {}, events = [], nowMs = 0 } = {}) {
  const decay = classifySuppressionDecay(sub, nowMs);

  // Only a MACHINE-inferred suppression may be undone. Redundant with the
  // caller's Firestore filter today, and deliberately so: the function is the
  // whole precedence, and a caller that widens its query again (or passes a
  // doc from a different code path) must not be able to "restore" a mailable
  // doc, still less an `inactive` one — that status is owned by the sunset
  // classifiers, and a second writer of that transition is the defect
  // scripts/lib/suppressionDecay.mjs's header calls out.
  if (decay.code === 'mailable' || decay.code === 'engagement-sunset') {
    return { restore: false, code: 'not-suppressed', reason: decay.reason, confirmed: false, tier: decay.tier };
  }

  // FIRST among the suppression verdicts, and ahead of every event-log signal:
  // a hard bounce or a human decision is never undone by this script, whatever
  // the event log says.
  if (decay.tier === 'terminal') {
    return { restore: false, code: decay.code, reason: decay.reason, confirmed: false, tier: decay.tier };
  }

  const { sawSuspension, sawRealFailure, sawUnsubscribe } = classify(events);

  // Deliberately UNCONDITIONAL, and deliberately divergent from
  // `classifySuppressionDecay`, which lets a `confirmed_at` newer than the
  // opt-out supersede the stamp (a re-subscription). This script resurrects
  // addresses on a root-cause claim rather than on evidence of life, so it
  // keeps the stricter reading it has always had: an opt-out stamp, or an
  // opt-out in the event log (which decay never reads at all), stops it.
  if (sub?.unsubscribed_at || sub?.unsubscribedAt || sawUnsubscribe) {
    return { restore: false, code: 'unsubscribed', reason: 'explicit opt-out (stamp or event log)', confirmed: false, tier: decay.tier };
  }
  if (sawRealFailure) {
    return { restore: false, code: 'real-failure', reason: 'a suppressed event from a cause other than suspension', confirmed: false, tier: decay.tier };
  }
  if (!sawSuspension) {
    return { restore: false, code: 'no-suspension-evidence', reason: 'no suppressed event carrying mailtrap suspension', confirmed: false, tier: decay.tier };
  }

  return {
    restore: true,
    code: 'suspension-mismapped',
    reason: `suppression attributable to the mis-mapped mailtrap suspension (decay tier '${decay.tier}')`,
    // Consent is never inferred from the restore itself: a subscriber who was
    // still `pending` when the suppression landed comes back `pending`.
    confirmed: hasConsentEvidence(sub, events),
    tier: decay.tier,
  };
}
