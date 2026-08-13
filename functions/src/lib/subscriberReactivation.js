import admin from 'firebase-admin';

/**
 * Suppression recovery — the single decision point shared by every
 * newsletter*WebhookCore.js, on BOTH the newsletter and the job-alert branch.
 *
 * A subscriber's `status` gates every send (services/emailSuppression.mjs →
 * NEWSLETTER_EXCLUDED_STATUSES / JOB_ALERT_EXCLUDED_STATUSES). Before this
 * module owned the decision, the two mirrored branches inside the same five
 * files were wrong in OPPOSITE directions:
 *
 *  - the newsletter branch was too NARROW — `instantReactivationFields()` only
 *    ever cleared an exact `'inactive'`, and deliberately refused `'bounced'`.
 *    A subscriber flipped to `bounced` by a reputation/soft signal (or by a
 *    pre-classifier provider event, back when every reject collapsed into the
 *    same permanent `bounced` — see functions/src/lib/bounceClassification.js)
 *    could therefore never come back, not even when a later `delivered` event
 *    proved the mailbox alive. That is a ONE-WAY DOOR: once suppressed we stop
 *    sending, so the very event that would clear the state can no longer
 *    arrive. Every recovery so far has been a hand-run one-off script
 *    (scripts/dev/reactivate-false-positive-bounces.mjs, 2017 docs in a single
 *    batch).
 *
 *  - the job-alert branch was too BROAD — it ended with an unconditional
 *    `topUpdate.status = 'active'` on delivered/open/click, which would
 *    overwrite `'complained'`, i.e. a human's spam complaint, with a machine's
 *    inference. Latent (a suppressed address is never sent to, so the event can
 *    essentially never arrive) but it must not be *able* to happen.
 *
 * The rule, stated once:
 *
 *  - A positive event (delivered/open/click) CLEARS a suppression that a
 *    MACHINE inferred and that is NOT proven-permanent — `inactive` (our own
 *    sunset), `suppressed` (provider list), and `bounced` only when
 *    `bounce_severity` is not `'hard'`.
 *  - It NEVER clears a HUMAN-declared state. `complained` and `unsubscribed`
 *    are consent decisions, not inferences; no delivery signal overrides them.
 *  - It NEVER clears `bounced` when `bounce_severity === 'hard'` — a real dead
 *    mailbox, and resurrecting those burns sender reputation on the 5 free-tier
 *    ESPs.
 */

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/**
 * The three event types that count as proof the mailbox is alive and reachable.
 * `send` is NOT one of them: it only proves we tried.
 */
export const POSITIVE_RECOVERY_EVENTS = new Set(['delivered', 'open', 'click']);

/**
 * Suppressions a MACHINE inferred. Reversible in principle — an actual delivery
 * disproves the inference that produced them.
 */
export const MACHINE_INFERRED_SUPPRESSIONS = new Set(['inactive', 'suppressed', 'bounced']);

/**
 * Suppressions that turn on what the HUMAN did, not on what a machine inferred.
 * Never reversible by a delivery signal — only by the human acting again (a
 * fresh opt-in).
 *
 * `complained` and `unsubscribed` are the two decisions they declared.
 * `expired` (#5692) is the third member and the one that needs saying out
 * loud: it is what their SILENCE decided. We asked to confirm the subscription
 * three times, one day apart, and stopped; nothing was inferred about the
 * mailbox, so there is no inference for a `delivered` to disprove. It belongs
 * here and not in MACHINE_INFERRED_SUPPRESSIONS because the alternative is
 * concrete and wrong: an `open` on the third unanswered confirmation email
 * would clear the state and re-activate a subscription that was never
 * confirmed — reading a machine's proof-of-eyeballs as the click it exists to
 * ask for. A real re-subscription still works, and is the only thing that
 * does: it lands as a fresh `pending` with a new cycle
 * (services/newsletterSubscribers.ts).
 */
export const HUMAN_DECLARED_SUPPRESSIONS = new Set(['complained', 'unsubscribed', 'expired']);

/**
 * True when a positive event must NOT be allowed to change `status` at all:
 * a human-declared state, or a bounce proven permanent by its severity.
 *
 * Callers use this to guard any *other* status promotion they do on a positive
 * event (the job-alert branch's historical "healthy delivery → active"), so the
 * "never overwrite consent" rule lives here and cannot drift per provider.
 *
 * @param {string|null|undefined} currentStatus
 * @param {string|null|undefined} bounceSeverity value of the doc's `bounce_severity`
 * @returns {boolean}
 */
export function isTerminalSuppression(currentStatus, bounceSeverity) {
  const status = norm(currentStatus);
  if (HUMAN_DECLARED_SUPPRESSIONS.has(status)) return true;
  return status === 'bounced' && norm(bounceSeverity) === 'hard';
}

/**
 * Fields that clear a machine-inferred, not-proven-permanent suppression when a
 * positive event proves the address is alive. Returns `{}` when nothing applies
 * — same contract as the narrow helper below, so callers can always
 * `Object.assign()` the result unconditionally.
 *
 * The write is deliberately audited: `reactivated_at` (the field name the
 * `reactivate` branch of scripts/newsletter-sunset.mjs already uses),
 * `recovered_from_status` + `recovered_by_event` recording WHAT cleared it, and
 * `bounce_reactivated_at` for the bounce case — the same field the one-off
 * remediation script stamps, so a Firestore query finds automatic and manual
 * recoveries together.
 *
 * `isActive`/`active` are reset too: the same writers that set a suppressed
 * `status` (newsletterResendWebhookCore.js, newsletterMailtrapWebhookCore.js)
 * also set those booleans false, and scripts/send-onboarding-drip.mjs treats
 * `isActive === false` as suppressed on its own — clearing `status` alone would
 * leave a second, independent one-way door. On `job_alert_subscribers` they are
 * inert (that channel's consent is the per-alert `active:false` flag), which is
 * why one function can serve both branches.
 *
 * @param {object} args
 * @param {string|null|undefined} args.currentStatus doc's current `status`
 * @param {string|null|undefined} [args.bounceSeverity] doc's current `bounce_severity`
 * @param {string|null|undefined} [args.event] normalized event type that arrived
 * @returns {Record<string, unknown>} fields to merge (empty when no recovery applies)
 */
export function positiveEventRecoveryFields({ currentStatus, bounceSeverity, event } = {}) {
  const status = norm(currentStatus);
  const eventType = norm(event);

  // An explicitly-passed non-positive event never recovers anything. An absent
  // event is tolerated (the caller already gated on the event type) but then
  // there is nothing to record as the cause.
  if (eventType && !POSITIVE_RECOVERY_EVENTS.has(eventType)) return {};
  if (!MACHINE_INFERRED_SUPPRESSIONS.has(status)) return {};
  if (isTerminalSuppression(status, bounceSeverity)) return {};

  const FieldValue = admin.firestore.FieldValue;
  const fields = {
    status: 'active',
    isActive: true,
    active: true,
    reactivated_at: FieldValue.serverTimestamp(),
    recovered_from_status: status,
    soft_bounce_count: 0,
    winback_sent_at: FieldValue.delete(),
    winback_pending: FieldValue.delete(),
  };
  // Only written when the caller told us what arrived — never a null field.
  if (eventType) fields.recovered_by_event = eventType;
  if (status === 'bounced') {
    fields.bounce_reactivated_at = FieldValue.serverTimestamp();
  }
  return fields;
}

/**
 * The job-alert branch's full "healthy delivery event" status decision.
 *
 * That branch historically ended with an UNCONDITIONAL
 * `topUpdate.status = 'active'`, which is right for a subscriber who is not
 * suppressed at all and catastrophic for one who is: it overwrote `'complained'`
 * — a human's spam complaint — with a machine's inference. Splitting the
 * decision per provider file is what let the two mirrored branches drift apart
 * in the first place, so it lives here, whole:
 *
 *   1. a machine-inferred suppression that this event disproves → recover it;
 *   2. a human-declared state, or a proven-permanent hard bounce → touch nothing;
 *   3. anything else (no doc yet, `pending`, `confirmed`, already `active`) →
 *      the historical promotion to `'active'`.
 *
 * @param {object} args same shape as positiveEventRecoveryFields
 * @returns {Record<string, unknown>} fields to merge (empty when the status must not change)
 */
export function positiveEventStatusFields({ currentStatus, bounceSeverity, event } = {}) {
  const eventType = norm(event);
  if (eventType && !POSITIVE_RECOVERY_EVENTS.has(eventType)) return {};

  const recovery = positiveEventRecoveryFields({ currentStatus, bounceSeverity, event });
  if (Object.keys(recovery).length > 0) return recovery;
  if (isTerminalSuppression(currentStatus, bounceSeverity)) return {};
  return { status: 'active' };
}

/**
 * Narrow newsletter-sunset reactivation (issue #2852 item 2): the "only an
 * exact `inactive`" contract, unchanged.
 *
 * No production caller is left — the five webhook cores now go through
 * `positiveEventRecoveryFields` / `positiveEventStatusFields`, which subsume it.
 * Kept, delegating, because it is the narrow shape the weekly cron implements
 * (the `reactivate` branch of scripts/newsletter-sunset.mjs) and the one asserted
 * by tests/newsletter-webhook-instant-reactivation.test.ts; delegating means
 * there is exactly ONE implementation of the decision and the two cannot drift.
 *
 * @param {string|null|undefined} currentStatus subscriber's current `status` field
 * @returns {Record<string, unknown>} fields to merge into the subscriber doc
 *   (empty object when no reactivation applies)
 */
export function instantReactivationFields(currentStatus) {
  if (norm(currentStatus) !== 'inactive') return {};
  return positiveEventRecoveryFields({ currentStatus, bounceSeverity: null });
}
