/**
 * confirmationFollowup.js — the double opt-in has a LAST DAY (#5692).
 *
 * The owner's rule, in full: at most THREE confirmation requests, one per day,
 * the first one included; after the third goes unanswered the record moves to
 * the terminal status `expired` and is KEPT — «resta la prova di aver chiesto
 * tre volte e di essersi fermati, che è ciò che si mostra a un'autorità, e
 * l'arretrato resta misurabile senza tornare a chiamarsi `pending`» (#5764).
 *
 * The decision lives here, once, because three callers ask the same question
 * from three runtimes and none of them may answer it privately:
 *   - `newsletterConfirmationEmail.js` (Cloud Function) must refuse a fourth
 *     send. The cap belongs at the SEND point, not in whoever calls it: a cap
 *     enforced by the caller is a cap the next caller does not have;
 *   - `scripts/newsletter-confirmation-followups.mjs` recomputes, every run,
 *     who is due and who is finished;
 *   - `services/newsletterSubscribers.ts` starts the cycle on the write that
 *     creates the `pending` document.
 *
 * WHY `pending` COULD NEVER END, measured 2026-08-13 on 8.670 documents:
 *   1.498 `pending`, growing ~12/day, 487 of them older than 90 days. Nothing
 *   in the codebase moved a document OUT of `pending` except the recipient's
 *   own click, so every unanswered signup stayed there forever.
 *
 * The counting trap this module is built around, and the reason the issue's
 * own headline number is wrong. Of those 1.498, **848 already carry
 * `confirmed_at`**: `scripts/mailtrap-suppression-retry.mjs` writes
 * `status: 'pending', isActive: true` on a previously-confirmed address as a
 * DELIVERABILITY re-probe, where `pending` means "re-probe me", not "never
 * consented" (see services/subscriberConsent.mjs). Counting `pending` docs
 * with no `confirmation_sent_at` reports 803 people who "never received the
 * confirmation email"; 772 of those 803 are re-probes who confirmed long ago.
 * The real never-asked cohort is 31, none created in the last 30 days.
 *
 * So `hasConfirmationProof` is not a nicety here, it is the guard that stops
 * this policy from expiring 848 genuine subscribers. It is asked FIRST, before
 * anything counts attempts.
 *
 * FUTURE SUBSCRIPTIONS ONLY. The owner scoped the rule to new signups, so the
 * epoch is a CONSTANT rather than "whenever the cron was switched on": a
 * document created before it is backlog by construction, on every run, on
 * every machine, forever. That property is what makes «l'arretrato non si
 * tocca» testable instead of operational.
 */

import { isNewsletterOptOutBinding } from './newsletterOptOut.js';
import { hasConfirmationProof } from './subscriberConsent.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The terminal status. A record reaching it is KEPT, never deleted. */
export const CONFIRMATION_EXPIRED_STATUS = 'expired';

/**
 * The ONLY status a confirmation request may be addressed to.
 *
 * An allowlist of one, and deliberately not the `NEWSLETTER_EXCLUDED_STATUSES`
 * exclusion set every other channel uses. The two are not interchangeable here:
 * an exclusion set answers "is this address suppressed", and the answer for
 * `expired`, `confirmed` or an unknown future status would be "no, go ahead" —
 * which is right for a newsletter and wrong for a consent request, where the
 * only person who may be asked to confirm is one whose confirmation is
 * genuinely outstanding. Named so the channel gate in
 * tests/no-channel-mails-opted-out.test.ts can point at it.
 */
export const CONFIRMATION_REQUEST_STATUS = 'pending';

/** Three requests, the first one included. */
export const MAX_CONFIRMATION_ATTEMPTS = 3;

/**
 * The floor between two requests — "one per day" with the slack a scheduled
 * run needs.
 *
 * 20h and not 24h on purpose: a daily cron that fires at 09:03 one morning and
 * 08:58 the next is 23h55m apart, and a strict 24h test would silently skip
 * that day and stretch a three-day cycle into a five-day one. The NOMINAL
 * cadence is 24h; the 4h of slack absorbs jitter without ever allowing two
 * requests in one calendar day.
 */
export const MIN_ATTEMPT_INTERVAL_MS = 20 * 60 * 60 * 1000;

/**
 * How long the whole cycle may stay open, counted from its start.
 *
 * Three requests one day apart plus one last day for the third to be answered.
 * It is a SECOND way to reach the terminal state, and it is deliberate: the
 * reminder texts are the owner's to write (#5692), so until they exist a
 * record receives one request and no more. Without this bound the accumulation
 * the whole issue is about would continue unchanged behind a cap that never
 * fills. With it, the window is the same length either way and the reason is
 * recorded on the document, so «expired dopo un solo tentativo» stays
 * countable — it is the measure of what is still missing.
 */
export const CONFIRMATION_WINDOW_MS = (MAX_CONFIRMATION_ATTEMPTS + 1) * DAY_MS;

/**
 * The first day the rule applies. Documents created before it are backlog.
 *
 * 2026-08-14: the day after the 1.498 were measured, so every one of them is
 * on the far side of it by construction. Overridable per run (the scheduled
 * workflow passes `--epoch`) but never DEFAULTED to "now": a default of now
 * would make the same document eligible or not depending on the hour the cron
 * happened to start, which is the opposite of a rule.
 */
export const DEFAULT_CONFIRMATION_FOLLOWUP_EPOCH = '2026-08-14T00:00:00.000Z';

/** `purpose` value that marks a request as part of the follow-up cadence. */
export const FOLLOWUP_PURPOSE = 'followup';

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

/**
 * Milliseconds from any of the four shapes a date takes on these documents:
 * a Firestore Timestamp, a Date, an epoch number, an ISO string.
 * @param {unknown} value
 * @returns {number|null}
 */
export function toMillis(value) {
  if (value == null) return null;
  if (typeof value === 'object' && typeof value.toDate === 'function') {
    const d = value.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : null;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Firestore `seconds` fields and JS milliseconds are both in the wild.
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

const firstMillis = (...values) => {
  for (const v of values) {
    const ms = toMillis(v);
    if (ms != null) return ms;
  }
  return null;
};

/**
 * When the last confirmation request went out, both spellings.
 * @param {Record<string, any>|null|undefined} data
 * @returns {number|null}
 */
export function lastConfirmationAttemptAt(data) {
  return firstMillis(data?.confirmation_sent_at, data?.confirmationSentAt);
}

/**
 * How many requests this document has already received.
 *
 * The counter is authoritative, but it is NOT trusted alone: it landed with
 * this feature, so every document written before it has `undefined` there and
 * a `confirmation_sent_at` that proves at least one request went out. Taking
 * the MAX of the counter and that floor is what stops a legacy document from
 * being re-asked from zero. Both spellings of both fields are read — 458
 * documents in this collection carry only the camelCase one (#5673).
 *
 * @param {Record<string, any>|null|undefined} data
 * @returns {number}
 */
export function confirmationAttemptsUsed(data) {
  const raw = data?.confirmation_attempts ?? data?.confirmationAttempts;
  const counted = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;

  // The floor counts only a stamp that belongs to THIS cycle. A re-subscription
  // after `expired` resets the counter and starts a new cycle, but nothing
  // deletes the previous cycle's `confirmation_sent_at` — reading it as a floor
  // would hand the returning subscriber two requests instead of three, which is
  // the quiet half of the same defect the reset exists to prevent.
  const lastAttempt = lastConfirmationAttemptAt(data);
  const cycleStart = confirmationCycleStartedAt(data);
  const stampBelongsToCycle =
    lastAttempt != null && (cycleStart == null || lastAttempt >= cycleStart);
  return Math.max(counted, stampBelongsToCycle ? 1 : 0);
}

/**
 * When the FIRST request of this cycle went out — the date a reminder states.
 *
 * Strictly the first, never `confirmation_sent_at`: that field is overwritten
 * by every send, so on the third request it holds the date of the second, and
 * an email that says «ti avevamo scritto il <ieri>» when it means «tre giorni
 * fa» is a factual claim we would be making wrongly to somebody who has not
 * consented to hear from us at all. Returns null rather than a near-enough
 * date; the copy has an undated wording for exactly that case.
 *
 * @param {Record<string, any>|null|undefined} data
 * @returns {number|null}
 */
export function confirmationFirstSentAt(data) {
  return firstMillis(data?.confirmation_first_sent_at, data?.confirmationFirstSentAt);
}

/**
 * When the CURRENT cycle started — the anchor of the window.
 *
 * `confirmation_cycle_started_at` is written by the signup write that produces
 * a fresh `pending` (services/newsletterSubscribers.ts). It is what makes a
 * re-subscription after `expired` a NEW cycle rather than a document that is
 * born already out of attempts: without it the second signup of an address
 * that once expired would be capped before its first request.
 *
 * @param {Record<string, any>|null|undefined} data
 * @returns {number|null}
 */
export function confirmationCycleStartedAt(data) {
  return firstMillis(
    data?.confirmation_cycle_started_at,
    data?.confirmationCycleStartedAt,
    data?.confirmation_first_sent_at,
    data?.confirmationFirstSentAt,
    data?.created_at,
    data?.createdAt,
    data?.subscribed_at,
    data?.subscribedAt,
  );
}

/**
 * When the document was created, for the epoch test only.
 *
 * Separate from the cycle anchor above on purpose: the epoch decides whether
 * the rule applies to this person AT ALL, and it must not be satisfiable by a
 * field a later write can produce. A missing creation stamp is answered
 * fail-closed by the caller (backlog, never touched).
 *
 * @param {Record<string, any>|null|undefined} data
 * @returns {number|null}
 */
export function subscriberCreatedAt(data) {
  return firstMillis(data?.created_at, data?.createdAt, data?.subscribed_at, data?.subscribedAt);
}

/**
 * True when a positive delivery signal proves the address is dead or hostile,
 * even though the status still says `pending`.
 *
 * The issue's rule 4: «Un bounce al primo invio significa che il secondo e il
 * terzo sono recapiti falliti garantiti». Only HARD signals stop the cycle —
 * a soft bounce is a temporary condition and the next day's request is exactly
 * the right response to it.
 *
 * @param {Record<string, any>|null|undefined} data
 * @returns {boolean}
 */
export function hasHardAddressSignal(data) {
  if (norm(data?.bounce_severity) === 'hard') return true;
  return !!(data?.last_complained_at || data?.complained_at || data?.complaint_at);
}

/**
 * Is this send part of the double opt-in cycle, and therefore subject to the
 * cap?
 *
 * TWO exemptions, and both are load-bearing:
 *   - `purpose: 'login'` sends the same link as a passwordless sign-in link to
 *     an ALREADY CONFIRMED subscriber. Capping it would lock people out of
 *     their own preference centre after three sign-ins;
 *   - a document that already carries the confirmation stamp is not in a
 *     cycle at all — the 848 re-probes above are `pending` WITH proof, and
 *     counting their sends against a confirmation cap would be counting the
 *     wrong thing entirely.
 *
 * @param {{data?: Record<string, any>|null, purpose?: string|null}} args
 * @returns {boolean}
 */
export function isConfirmationCycleSend({ data, purpose } = {}) {
  if (norm(purpose) === 'login') return false;
  return !hasConfirmationProof(data);
}

/**
 * Why this confirmation request must be refused, or `null` to let it through.
 *
 * The 1-hour cooldown in newsletterConfirmationEmail.js is NOT replaced by
 * this — it guards a different accident (a double click on "resend" within the
 * minute) and stays exactly where it is. What this adds is the follow-up
 * cadence: a request that DECLARES itself part of the cadence is held to the
 * one-per-day floor instead, which is stricter, and the cap applies to both.
 *
 * @param {object} args
 * @param {Record<string, any>|null|undefined} args.data subscriber document
 * @param {string|null|undefined} [args.purpose] `purpose` from the caller
 * @param {number} args.now
 * @returns {{error: string, attempts: number}|null}
 */
export function confirmationSendRefusal({ data, purpose, now }) {
  if (!isConfirmationCycleSend({ data, purpose })) return null;

  const attempts = confirmationAttemptsUsed(data);
  if (attempts >= MAX_CONFIRMATION_ATTEMPTS) {
    return { error: 'confirmation_attempts_exhausted', attempts };
  }

  if (norm(purpose) === FOLLOWUP_PURPOSE) {
    const last = lastConfirmationAttemptAt(data);
    if (last != null && now - last < MIN_ATTEMPT_INTERVAL_MS) {
      return { error: 'followup_too_soon', attempts };
    }
  }

  return null;
}

/**
 * @typedef {{action: 'send', attempt: number, attempts: number, reason: 'first-ask'|'reminder'}
 *   | {action: 'expire', attempts: number, reason: 'attempts-exhausted'|'window-elapsed'}
 *   | {action: 'skip', attempts: number, reason: string}} FollowupDecision
 */

/**
 * What this document is owed today. Pure: same inputs, same answer, every run.
 *
 * The guards are ordered from "this person is not in a cycle" to "this person
 * is, and here is where they are in it", so a document can never be counted by
 * a later rule after an earlier one has spoken. Eligibility is DERIVED here on
 * every call and never frozen into a list (the issue's rule 6): a list built
 * yesterday would mail somebody who confirmed, unsubscribed or bounced in the
 * meantime.
 *
 * @param {Record<string, any>|null|undefined} data a `newsletter_subscribers` doc
 * @param {{now: number, epochMs: number}} ctx
 * @returns {FollowupDecision}
 */
export function decideConfirmationFollowup(data, { now, epochMs }) {
  const attempts = confirmationAttemptsUsed(data);
  const skip = (reason) => ({ action: 'skip', attempts, reason });
  const status = norm(data?.status);

  // Terminal, and terminal means terminal: no further request, and no deletion
  // either. The record IS the evidence.
  if (status === CONFIRMATION_EXPIRED_STATUS) return skip('already-expired');
  if (status !== CONFIRMATION_REQUEST_STATUS) return skip('not-pending');

  // Before any counting — see the docblock. 848 of the 1.498 land here.
  if (hasConfirmationProof(data)) return skip('already-confirmed');

  // A recorded opt-out ends the cycle immediately (issue rule 4). Via the
  // shared predicate, so the 458 camelCase-only stamps are seen too.
  if (isNewsletterOptOutBinding(data)) return skip('opt-out');

  if (hasHardAddressSignal(data)) return skip('address-signal');

  const createdAt = subscriberCreatedAt(data);
  // FAIL-CLOSED. A document whose age cannot be established is never expired:
  // the cost of skipping it is that it stays measurable as `pending`, the cost
  // of guessing is a terminal state written on someone the rule never covered.
  if (createdAt == null) return skip('no-creation-stamp');
  if (createdAt < epochMs) return skip('backlog');

  const lastAttemptAt = lastConfirmationAttemptAt(data);

  if (attempts >= MAX_CONFIRMATION_ATTEMPTS) {
    if (lastAttemptAt != null && now - lastAttemptAt < MIN_ATTEMPT_INTERVAL_MS) {
      return skip('awaiting-last-chance');
    }
    return { action: 'expire', attempts, reason: 'attempts-exhausted' };
  }

  if (lastAttemptAt != null && now - lastAttemptAt < MIN_ATTEMPT_INTERVAL_MS) {
    return skip('too-soon');
  }

  const cycleStartedAt = confirmationCycleStartedAt(data) ?? createdAt;
  if (now - cycleStartedAt >= CONFIRMATION_WINDOW_MS) {
    return { action: 'expire', attempts, reason: 'window-elapsed' };
  }

  return {
    action: 'send',
    attempt: attempts + 1,
    attempts,
    reason: attempts === 0 ? 'first-ask' : 'reminder',
  };
}

/**
 * The fields that record a request having gone out, as a plain object.
 *
 * Shared by BOTH senders — the Cloud Function that sends request #1 and
 * scripts/newsletter-confirmation-followups.mjs that sends #2 and #3 — because
 * the counter this writes is the whole evidence of "asked three times and
 * stopped". A second copy of these four lines is how one sender comes to skip
 * the increment, and a cap counting a number nobody increments is not a cap.
 *
 * `stamp` is injected rather than taken because the two runtimes disagree about
 * what a timestamp is: the Cloud Function passes
 * `admin.firestore.FieldValue.serverTimestamp()`, the runner passes the ISO
 * string it already uses for the expiry write in the same batch.
 *
 * @param {object} args
 * @param {number} args.attemptsBefore what confirmationAttemptsUsed() said before this send
 * @param {boolean} args.isCycleSend false for a login link or an already-confirmed re-probe
 * @param {string|null} [args.messageId]
 * @param {string} args.locale
 * @param {unknown} args.stamp
 * @returns {Record<string, unknown>}
 */
export function buildConfirmationSentFields({ attemptsBefore, isCycleSend, messageId, locale, stamp }) {
  const fields = {
    confirmation_sent_at: stamp,
    confirmation_message_id: messageId ?? null,
    preferred_locale: locale,
    updated_at: stamp,
  };
  // Only a real cycle send consumes one of the three. A passwordless login link
  // and a deliverability re-probe of an already-confirmed address are not
  // double opt-in requests, and counting them would spend somebody else's cap.
  if (isCycleSend) {
    fields.confirmation_attempts = attemptsBefore + 1;
    if (attemptsBefore === 0) fields.confirmation_first_sent_at = stamp;
  }
  return fields;
}

/**
 * The per-attempt evidence, in the subcollection that survives the next
 * overwrite of the flat fields — so "asked three times, then stopped" reads as
 * one sequence next to the `confirmation_expired` event that ends it.
 *
 * @param {object} args
 * @param {string} args.email
 * @param {number} args.attemptsBefore
 * @param {boolean} args.isCycleSend
 * @param {string|null} [args.messageId]
 * @param {string} args.locale
 * @param {string} args.occurredAt ISO
 * @param {unknown} [args.timestamp] server timestamp where the runtime has one
 * @returns {Record<string, unknown>}
 */
export function buildConfirmationSentEvent({
  email,
  attemptsBefore,
  isCycleSend,
  messageId,
  locale,
  occurredAt,
  timestamp,
}) {
  return {
    email,
    event_type: 'confirmation_email_sent',
    source_channel: 'newsletter_confirmation',
    message_id: messageId ?? null,
    locale,
    // `null` when the send was not part of a cycle, so a login link is never
    // counted as an ask afterwards.
    confirmation_attempt: isCycleSend ? attemptsBefore + 1 : null,
    confirmation_attempts_max: MAX_CONFIRMATION_ATTEMPTS,
    timestamp: timestamp === undefined ? occurredAt : timestamp,
    occurred_at: occurredAt,
  };
}

/**
 * The fields that close a record, as a plain object the caller merges.
 *
 * `isActive`/`active` are written alongside the status because the two are
 * read independently across this repo (scripts/send-onboarding-drip.mjs treats
 * `isActive === false` as suppressed on its own), and a status that says
 * "closed" over a boolean that says "active" is the shape #5733 was about.
 *
 * Nothing is deleted. `confirmation_attempts` is written back explicitly so a
 * legacy document that reached the cap through its stamp alone carries the
 * number it was closed on, instead of an absent field a later reader would
 * count as zero.
 *
 * @param {FollowupDecision} decision
 * @param {string} nowIso
 * @returns {Record<string, unknown>}
 */
export function buildConfirmationExpiryFields(decision, nowIso) {
  return {
    status: CONFIRMATION_EXPIRED_STATUS,
    isActive: false,
    active: false,
    confirmation_attempts: decision.attempts,
    confirmation_expired_at: nowIso,
    confirmationExpiredAt: nowIso,
    confirmation_expired_reason: decision.reason,
    updated_at: nowIso,
    updatedAt: nowIso,
  };
}
