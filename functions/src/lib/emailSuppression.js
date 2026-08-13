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
 *     (#5688: three senders used isAddressSuppressed here, which answers a
 *     different question and let a newsletter opt-out through);
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
 * Newsletter-channel exclusions: the address-level signals PLUS the channel-level
 * soft states — `unsubscribed` (explicit opt-out) and `inactive` (the sunset of a
 * never-engager, see scripts/lib/subscriberSunset.mjs). `inactive` is NOT in
 * ADDRESS_SUPPRESSED_STATUSES because it is a soft, channel-level state, not a
 * hard cross-channel signal (a bounce/complaint).
 *
 * `unsubscribed` is a different animal from `inactive`, and this docblock used
 * to lump them together — "Job alerts do NOT fold these in […] a newsletter-only
 * sunset must never silently cross to the alert channel". The second half is
 * still true and is why `inactive` stops here. The first half was the sentence
 * that authorised #5688: a person who clicks "disiscriviti" is not sunsetting a
 * channel, they are telling us to stop, and that instruction binds every channel
 * — see CROSS_CHANNEL_STOP_STATUSES below, which is what the alert senders read.
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
  // happen to exclude it anyway (no `confirmed_at`, so the gated senders skip
  // it; `isActive: false`, which scripts/mailtrap-suppression-retry.mjs is
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
 * The address-level hard signals plus `unsubscribed` — and deliberately NOT
 * `inactive`, in either channel's sense of the word. The two halves are not the
 * same kind of fact:
 *   - `unsubscribed` is a human instruction ("stop emailing me"), recorded by
 *     the one-click Cloud Function, the SPA link and every ESP unsubscribe
 *     webhook. Nothing in the wording of an unsubscribe link is per-channel, so
 *     honouring it on one channel and not another is not a policy, it is a bug.
 *   - `inactive` is list hygiene we applied ourselves — the never-engager sunset
 *     (scripts/lib/subscriberSunset.mjs on the newsletter doc,
 *     scripts/lib/jobAlertSunset.mjs on the job-alert doc). Soft, reversible,
 *     and about ONE channel's engagement: a person who ignores the weekly
 *     newsletter may well be opening the job alert they created themselves, so
 *     crossing it would silence a channel the recipient still uses. It stays in
 *     NEWSLETTER_EXCLUDED_STATUSES / JOB_ALERT_EXCLUDED_STATUSES, each read
 *     against its own document, and out of this set.
 *
 * #5688 measured what the missing half cost: of 186 addresses suppressed after
 * an LPD complaint, 127 had a job-alert document and 127 of those 127 were
 * still `active` — one of them received a job alert fifteen minutes after we
 * had confirmed in writing that they were removed "from all lists". The alert
 * senders were already READING the newsletter document; they were reading it
 * with isAddressSuppressed(), which answers "is this mailbox dead or hostile",
 * not "did this person ask us to stop".
 *
 * The SET is the vocabulary; the PREDICATE is isCrossChannelStop() below, and
 * it is the one to call. `unsubscribed` appears here because it belongs to the
 * vocabulary, but a status is only one of the two ways an opt-out is recorded —
 * see lib/newsletterOptOut.js for the other, and for why it cannot be reduced
 * to a Set lookup.
 */
export const CROSS_CHANNEL_STOP_STATUSES = new Set(['unsubscribed', ...ADDRESS_SUPPRESSED_STATUSES]);

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
 * because a newsletter opt-out leaves no trace at all on this document (#5688).
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

/**
 * True when the newsletter document forbids mailing this address on ANY channel.
 *
 * The one predicate a non-newsletter sender applies to a `newsletter_subscribers`
 * document. Takes the ROW rather than the status string, because neither half of
 * the answer fits in a status string:
 *
 *   - the address-level hard signals DO live on `status`, so isAddressSuppressed
 *     still answers that half;
 *   - the opt-out does not. It is `status: 'unsubscribed'` OR an append-only
 *     stamp in either spelling, lifted only by a strictly later explicit
 *     re-opt-in — the rule `isNewsletterOptOutBinding` owns since #5711, and
 *     the reason this function delegates rather than re-deriving it. A second
 *     derivation is how two channels come to disagree about who opted out, and
 *     it would be a WRONG one here: after #5711 nothing deletes the stamp, so
 *     "carries a stamp ⇒ never mail again" would silence everyone who left and
 *     explicitly came back.
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
  if (isAddressSuppressed(status)) return true;
  // The projection may carry `status` without the raw document repeating it.
  if (norm(status) === 'unsubscribed') return true;
  return isNewsletterOptOutBinding(raw);
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
