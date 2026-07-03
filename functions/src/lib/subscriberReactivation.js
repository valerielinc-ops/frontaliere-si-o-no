import admin from 'firebase-admin';

/**
 * Instant newsletter-sunset reactivation — shared by every newsletter*WebhookCore.js
 * (issue #2852 item 2).
 *
 * scripts/lib/subscriberSunset.mjs's `classifySunset()` puts never-engaging
 * subscribers into a soft `status: 'inactive'` state (see that file for the
 * full graduated winback → sunset → reactivate lifecycle). Before this fix,
 * an `inactive` subscriber who opened/clicked an email only got flipped back
 * to `status: 'active'` on the NEXT weekly run of scripts/newsletter-sunset.mjs
 * — up to a week of being silently excluded from sends despite having just
 * re-engaged. Every ESP webhook handler already loads the subscriber doc (or
 * can cheaply do so) when it processes an open/click event, so it can apply
 * the exact same transition immediately instead of waiting for the cron.
 *
 * Mirrors the `reactivate` branch of scripts/newsletter-sunset.mjs verbatim:
 * status → 'active', stamp `reactivated_at`, clear the winback markers so a
 * later engagement doesn't wrongly look like a still-pending winback.
 *
 * Deliberately narrow: only fires when the CURRENT status is exactly
 * 'inactive'. Does not touch bounced/complained/suppressed/unsubscribed
 * (address-level hard-suppression from #2831 is a separate mechanism —
 * see services/emailSuppression.mjs — and must never be overridden by an
 * open/click event).
 *
 * @param {string|null|undefined} currentStatus subscriber's current `status` field
 * @returns {Record<string, unknown>} fields to merge into the subscriber doc
 *   (empty object when no reactivation applies)
 */
export function instantReactivationFields(currentStatus) {
  if (String(currentStatus || '').trim().toLowerCase() !== 'inactive') return {};
  const FieldValue = admin.firestore.FieldValue;
  return {
    status: 'active',
    reactivated_at: FieldValue.serverTimestamp(),
    winback_sent_at: FieldValue.delete(),
    winback_pending: FieldValue.delete(),
  };
}
