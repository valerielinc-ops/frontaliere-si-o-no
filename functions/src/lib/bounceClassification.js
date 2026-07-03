import admin from 'firebase-admin';

/**
 * Hard-vs-soft bounce classification — shared by every newsletter*WebhookCore.js.
 * All 5 providers used to collapse reputation/soft rejects (Mailjet `blocked`,
 * Maileroo `rejected`, Mailtrap `soft_bounce`/`reject`, Mailgun `severity:
 * temporary`) into the same permanent `status: 'bounced'` as a genuine hard
 * bounce — which is excluded from every future send (see
 * services/emailSuppression.mjs) — so one provider hiccup could permanently
 * kill a real, engaged subscriber. Soft signals now only increment
 * `soft_bounce_count`; only SOFT_ESCALATION_THRESHOLD consecutive soft rejects
 * with no delivery/open in between escalate to a real `bounced`. Any
 * delivered/open/click event resets the counter (recovery signal).
 */

export const SOFT_ESCALATION_THRESHOLD = 3;

/**
 * @param {{ provider: 'mailjet'|'maileroo'|'mailtrap'|'mailgun'|'resend', rawEvent: string, eventData: object }} args
 * @returns {'hard'|'soft'}
 */
export function classifyBounceSeverity({ provider, rawEvent, eventData }) {
  const raw = String(rawEvent || '').toLowerCase();
  switch (provider) {
    case 'mailjet':
      // Mailjet already tells us: `blocked` is always reputation/soft; a real
      // `bounce` event is hard only when Mailjet itself flags hard_bounce.
      if (raw === 'blocked') return 'soft';
      return eventData?.hard_bounce ? 'hard' : 'soft';
    case 'maileroo':
      // `rejected` = provider-side reputation reject; `failed` = real delivery failure.
      return raw === 'rejected' ? 'soft' : 'hard';
    case 'mailtrap':
      return (raw === 'soft_bounce' || raw === 'reject') ? 'soft' : 'hard';
    case 'mailgun': {
      const severity = String(eventData?.severity || '').toLowerCase();
      if (severity === 'temporary') return 'soft';
      if (severity === 'permanent') return 'hard';
      // No severity captured (e.g. a pre-send `rejected`) — treat as soft, conservative.
      return raw === 'rejected' ? 'soft' : 'hard';
    }
    case 'resend': {
      const bounceType = String(eventData?.bounce?.type || eventData?.bounce_type || '').toLowerCase();
      return (bounceType === 'transient' || bounceType === 'undetermined') ? 'soft' : 'hard';
    }
    default:
      return 'hard';
  }
}

/**
 * Fields to merge into the caller's subscriberUpdate object for a bounce event.
 * Hard: identical to the prior behavior (permanent bounced status). Soft:
 * never touches `status` directly — only tracks the counter; escalation is a
 * separate follow-up step, see maybeEscalateSoftBounce.
 *
 * @param {{ severity: 'hard'|'soft', reason: string }} args
 */
export function bounceUpdateFields({ severity, reason }) {
  const FieldValue = admin.firestore.FieldValue;
  if (severity === 'hard') {
    return {
      status: 'bounced',
      bounced_at: FieldValue.serverTimestamp(),
      bounce_reason: reason,
      bounce_severity: 'hard',
      soft_bounce_count: 0,
    };
  }
  return {
    last_soft_bounce_at: FieldValue.serverTimestamp(),
    bounce_reason: reason,
    bounce_severity: 'soft',
    soft_bounce_count: FieldValue.increment(1),
  };
}

/**
 * Fields that reset the soft-bounce counter on any successful delivery/open/
 * click — the recovery signal proving the address is actually alive.
 */
export function softBounceRecoveryFields() {
  return { soft_bounce_count: 0 };
}

/**
 * Call AFTER the main subscriberUpdate write, only when the just-applied bounce
 * was soft. Reads the post-write soft_bounce_count and, once it reaches the
 * threshold with no intervening recovery, escalates to a real, permanent
 * `bounced` status.
 *
 * Wrapped in a Firestore transaction (same idiom as revertPendingJobsToDraft in
 * publisherPendingReapCore.js / reserveHereTransactionBudget in
 * trafficSchedulerCore.js) so the read-decide-write is atomic: two concurrent/
 * retried webhook deliveries for the same subscriber (ESP retry-on-timeout, or
 * genuinely simultaneous bounce notifications) can no longer both read the same
 * pre-increment count, both decide "not yet at threshold", and both write —
 * which could lose an increment or produce an inconsistent escalation decision.
 *
 * @param {FirebaseFirestore.DocumentReference} subscriberRef
 * @param {string} reason latest bounce reason, folded into the escalation audit trail
 * @returns {Promise<boolean>} true if this call escalated the subscriber
 */
export async function maybeEscalateSoftBounce(subscriberRef, reason) {
  const FieldValue = admin.firestore.FieldValue;
  return subscriberRef.firestore.runTransaction(async (tx) => {
    const snap = await tx.get(subscriberRef);
    const data = snap.data() || {};
    const count = Number(data.soft_bounce_count) || 0;
    if (count < SOFT_ESCALATION_THRESHOLD || data.status === 'bounced') return false;

    tx.set(subscriberRef, {
      status: 'bounced',
      bounced_at: FieldValue.serverTimestamp(),
      bounce_reason: `${reason} (escalated after ${count} consecutive soft rejects)`,
      bounce_severity: 'hard',
    }, { merge: true });
    return true;
  });
}
