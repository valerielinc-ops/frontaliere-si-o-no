/**
 * Shared subscriber-`status` suppression sets — the single source of truth for
 * "stop emailing this recipient", used by every sender (newsletter, job alerts,
 * publisher blast). Extracting it here makes the value drift that previously
 * existed impossible by-construction: `publisherBlastMatch.mjs` checked for the
 * literal `'complaint'` (an event-type discriminator, NEVER a subscriber status
 * value) and so never actually suppressed users who filed a spam complaint,
 * while `send-job-alerts.mjs` checked no status at all.
 *
 * The canonical `status` values are written by every `newsletter*WebhookCore.js`
 * on provider events: `bounced` (hard bounce), `complained` (spam complaint),
 * `suppressed` (provider suppression list), and the channel-level `unsubscribed`.
 * Confirmed against all six webhook cores — they uniformly write `complained`
 * (the `complaint` strings in those files are event-type names, not statuses).
 */

/**
 * Address-level hard signals. The mailbox is dead (bounced), the human flagged
 * us as spam (complained), or the provider blocklisted the address (suppressed).
 * These apply across BOTH channels — newsletter AND job alerts — because the
 * signal is about the address, not a per-channel consent choice.
 */
export const ADDRESS_SUPPRESSED_STATUSES = new Set(['bounced', 'complained', 'suppressed']);

/**
 * Newsletter-channel exclusions: the address-level signals PLUS the channel-level
 * soft states — `unsubscribed` (explicit opt-out) and `inactive` (the sunset of a
 * never-engager, see scripts/lib/subscriberSunset.mjs). Both are reversible and
 * newsletter-specific. Job alerts do NOT fold these in — an alert opt-out is the
 * per-alert `active:false` flag, a separate consent, and a newsletter-only sunset
 * must never silently cross to the alert channel. `inactive` is NOT in
 * ADDRESS_SUPPRESSED_STATUSES because it is a soft, channel-level state, not a
 * hard cross-channel signal (a bounce/complaint).
 */
export const NEWSLETTER_EXCLUDED_STATUSES = new Set(['unsubscribed', 'inactive', ...ADDRESS_SUPPRESSED_STATUSES]);

/**
 * Job-alert-channel exclusions: the address-level signals PLUS that channel's OWN
 * `inactive` soft state (the sunset of a never-engaging job-alert subscriber, see
 * scripts/lib/jobAlertSunset.mjs — issue #2852 item 1). This `inactive` lives on
 * `job_alert_subscribers/{email}.status` — a completely separate document/field
 * from the newsletter one above, so there is no cross-channel leak in either
 * direction. Job alerts have no `unsubscribed` channel status: an alert opt-out
 * is the per-alert `active:false` flag on the `alerts` subcollection, unrelated
 * to this top-level doc-level set.
 */
export const JOB_ALERT_EXCLUDED_STATUSES = new Set(['inactive', ...ADDRESS_SUPPRESSED_STATUSES]);

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/**
 * True when an address-level hard signal (bounce/complaint/suppression) means we
 * must never email this address again on ANY channel.
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isAddressSuppressed(status) {
  return ADDRESS_SUPPRESSED_STATUSES.has(norm(status));
}

/**
 * True when a newsletter recipient must be excluded (address signals + unsub).
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isNewsletterExcluded(status) {
  return NEWSLETTER_EXCLUDED_STATUSES.has(norm(status));
}

/**
 * True when a job-alert recipient must be excluded (address signals + that
 * channel's own inactivity sunset).
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isJobAlertExcluded(status) {
  return JOB_ALERT_EXCLUDED_STATUSES.has(norm(status));
}
