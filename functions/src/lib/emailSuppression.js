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
 *
 * Sets are not interchangeable, and picking the wrong one is the recurring
 * defect here rather than forgetting to check at all. Which to reach for:
 *   - reading the recipient's OWN channel document → isNewsletterExcluded /
 *     isJobAlertExcluded (each folds in that channel's own soft states);
 *   - reading the NEWSLETTER document from any other channel → isCrossChannelStop
 *     (address-level hard signals plus the recorded unsubscribe/stop-all);
 *   - a transactional message the user just asked for → isTransactionalHardBlock.
 */

import { assertSubscriberData, isNewsletterOptOutBinding } from './newsletterOptOut.js';

/**
 * Address-level hard signals. The mailbox is dead (bounced), the human flagged
 * us as spam (complained), or the provider blocklisted the address (suppressed).
 * These apply across BOTH channels — newsletter AND job alerts — because the
 * signal is about the address, not a per-channel consent choice.
 */
export const ADDRESS_SUPPRESSED_STATUSES = new Set(['bounced', 'complained', 'suppressed']);

/**
 * Newsletter-channel exclusions: the address-level signals PLUS the explicit
 * opt-out state `unsubscribed` and the internal `inactive` sunset (see
 * scripts/lib/subscriberSunset.mjs). `inactive` is NOT in
 * ADDRESS_SUPPRESSED_STATUSES because it is a soft, channel-level state, not a
 * hard cross-channel signal (a bounce/complaint).
 *
 * `unsubscribed` is an explicit recipient opt-out. It therefore crosses
 * channels: a person who asks us to stop receiving email must not continue to
 * receive job alerts, company alerts, digests or advertising. `inactive` and
 * `expired` remain internal newsletter lifecycle states and stay scoped.
 */
export const NEWSLETTER_EXCLUDED_STATUSES = new Set([
  'unsubscribed',
  'inactive',
  // `expired`: the double opt-in was requested three times, one day apart, and
  // never answered (#5692). It stops here, in the newsletter set, for the same
  // reason `inactive` does — it is a channel-level state we wrote ourselves,
  // not a human instruction and not an address-level signal, so it must not
  // cross to the job-alert channel where the consent basis is a separate act.
  //
  // Stated in the vocabulary rather than left to the three mechanisms that
  // happen to exclude it anyway (no lifecycle anchor, so welcome/onboarding
  // remain recency-limited; `isActive: false`, which scripts/mailtrap-suppression-retry.mjs is
  // known to flip back to true; a MAILABLE_STATUSES allow-list in the sunset
  // and win-back classifiers). An invariant held by three coincidences is the
  // shape this repo keeps finding broken — and one of those senders is the
  // win-back, whose whole purpose is reaching people the ordinary campaigns no
  // longer may. A win-back to an address we recorded as "asked three times,
  // stopped" contradicts the record in the one direction that reaches a mailbox.
  'expired',
  ...ADDRESS_SUPPRESSED_STATUSES,
]);

/**
 * What the NEWSLETTER document says to every OTHER channel.
 *
 * The address-level hard signals plus an explicit newsletter opt-out. The
 * latter is read both from the status and from the append-only opt-out stamps;
 * the explicit global fields are retained for legacy stop-all writers.
 */
export const CROSS_CHANNEL_STOP_STATUSES = new Set([
  'unsubscribed',
  ...ADDRESS_SUPPRESSED_STATUSES,
]);

/**
 * Canonical and legacy spellings of the explicit stop-all decision.
 *
 * These fields remain supported for the legacy explicit stop-all action. The
 * ordinary unsubscribe status/stamps are also cross-channel stops; there is
 * no second gate a recipient must discover to stop email everywhere.
 */
export const GLOBAL_EMAIL_OPT_OUT_FIELDS = Object.freeze([
  'all_email_opted_out',
  'all_emails_opted_out',
  'global_email_opt_out',
  'global_email_opted_out',
]);

/**
 * Job-alert-channel exclusions: the address-level signals PLUS that channel's OWN
 * `inactive` soft state (the sunset of a never-engaging job-alert subscriber, see
 * scripts/lib/jobAlertSunset.mjs — issue #2852 item 1). This `inactive` lives on
 * `job_alert_subscribers/{email}.status` — a completely separate document/field
 * from the newsletter one above, so there is no cross-channel leak in either
 * direction. Job alerts have no `unsubscribed` channel status: an alert opt-out
 * is the per-alert `active:false` flag on the `alerts` subcollection, unrelated
 * to this top-level doc-level set.
 *
 * This set answers only "what does the JOB-ALERT document say". A sender must
 * also ask what the NEWSLETTER document says — isCrossChannelStop() below —
 * because unsubscribe/stop-all history lives on that central row.
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

function isExplicitTrue(value) {
  return value === true || value === 1 || value === 'true' || value === '1';
}

/**
 * True only when the subscriber carries an explicit stop-all field.
 * Accepts raw data or the `{ status, doc }` projection used by senders.
 * @param {({doc?: object} & Record<string, unknown>) | null | undefined} row
 * @returns {boolean}
 */
export function isGlobalEmailOptOut(row) {
  assertSubscriberData(row, 'isGlobalEmailOptOut');
  if (!row) return false;
  assertSubscriberData(row.doc, 'isGlobalEmailOptOut(row.doc)');
  const raw = row.doc && typeof row.doc === 'object' ? row.doc : row;
  return GLOBAL_EMAIL_OPT_OUT_FIELDS.some((field) => (
    isExplicitTrue(raw?.[field]) || isExplicitTrue(row?.[field])
  ));
}

/**
 * True when the newsletter document forbids mailing this address on ANY channel.
 *
 * The one predicate a non-newsletter sender applies to a `newsletter_subscribers`
 * document. Takes the ROW rather than the status string, because neither half of
 * the answer fits in a status string:
 *
 *   - the address-level hard signals DO live on `status`, so isAddressSuppressed
 *     still answers that half;
 *   - a recipient opt-out lives in `status` or append-only opt-out stamps, and
 *     the legacy stop-all decision lives in explicit fields;
 *
 * Accepts a raw Firestore document or a projection carrying the raw one on
 * `.doc` (the shape scripts/send-daily-brief.mjs builds); the opt-out fields are
 * read off the raw document, so a projection must carry it.
 *
 * "Raw Firestore document" means the DATA — `snapshot.data()`, never the
 * snapshot. A snapshot has no `status` and no stamp on itself, so every branch
 * below would fall through to `false`, i.e. "go ahead and mail them" (#5750
 * item 2). Both the row and its `.doc` projection are checked, because either
 * position can receive the wrong thing, and the check fails LOUD rather than
 * quietly answering the most dangerous of the two possible answers.
 *
 * @param {({doc?: object, status?: string|null} & Record<string, unknown>) | null | undefined} row
 * @returns {boolean}
 */
export function isCrossChannelStop(row) {
  assertSubscriberData(row, 'isCrossChannelStop');
  if (!row) return false;
  assertSubscriberData(row.doc, 'isCrossChannelStop(row.doc)');
  const raw = row.doc && typeof row.doc === 'object' ? row.doc : row;
  const status = row.status != null ? row.status : raw.status;
  if (CROSS_CHANNEL_STOP_STATUSES.has(norm(status))
    || CROSS_CHANNEL_STOP_STATUSES.has(norm(raw.status))) return true;
  return isGlobalEmailOptOut(row)
    || isNewsletterOptOutBinding(raw)
    || isNewsletterOptOutBinding(row);
}

/**
 * TRANSACTIONAL senders only — the calculator PDF the user submitted a form for,
 * the double-opt-in confirmation they just triggered. These are not marketing:
 * the user asked for this specific message seconds ago, so the marketing-grade
 * exclusion sets above would be wrong here. `unsubscribed`, `inactive`,
 * `pending` and a soft/absent-severity `bounced` are all deliberately ALLOWED —
 * a newsletter opt-out does not revoke a transactional request, and one soft
 * reject is a provider hiccup, not a dead mailbox (see bounceClassification.js:
 * a soft bounce never sets `status` at all until it escalates, and escalation
 * itself writes `bounce_severity: 'hard'`, so it is caught here too).
 *
 * What IS blocked is only what re-mailing would provably damage:
 *   - a hard bounce — the mailbox does not exist; retrying burns sender
 *     reputation across all five free-tier ESPs for every other recipient;
 *   - `complained` — the human filed a spam complaint; mailing them again is a
 *     compliance hazard regardless of what they subsequently submitted.
 *
 * Note `suppressed` (provider blocklist) without a recorded hard severity is
 * NOT blocked: it is a provider-side state with no evidence about the mailbox
 * itself, and the ESP will refuse the send on its own if it still holds.
 *
 * @param {{ status?: string|null, bounceSeverity?: string|null }} [args]
 * @returns {boolean} true → do not send this transactional email.
 */
export function isTransactionalHardBlock({ status, bounceSeverity } = {}) {
  const normalizedStatus = norm(status);
  if (normalizedStatus === 'complained') return true;
  if (!isAddressSuppressed(normalizedStatus)) return false;
  return norm(bounceSeverity) === 'hard';
}
