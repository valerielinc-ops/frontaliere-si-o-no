/**
 * Mailtrap suppression retry — pure classifier.
 *
 * Root cause (live-verified 2026-07-22 via Mailtrap's Suppressions API, small
 * sample): the reason we've seen is `type: "hard bounce"`,
 * `message_bounce_category: "Over quota"` — SMTP 4.2.2, the recipient's inbox
 * was full. That is a TEMPORARY condition, but Mailtrap suppresses the
 * address permanently with no auto-retry.
 *
 * We do NOT gate eligibility on that category, though — same-day live testing
 * showed Mailtrap's Suppressions API (both the bulk list, which does not
 * paginate at all — `?page=1/2/100` and `?per_page=100` all returned the
 * identical fixed ~8 records — and the per-email `?email=` filter) failed to
 * find several addresses that were, at that exact moment, genuinely
 * `status: 'suppressed'` in our own Firestore with suppression events from
 * hours earlier. The API is not reliable enough to enumerate or classify our
 * backlog at scale, so eligibility here uses ONLY data we already own.
 *
 * Safety this still has, structurally: `status: 'suppressed'` is written by
 * exactly one webhook branch (functions/src/newsletterMailtrapWebhookCore.js
 * `type === 'suppressed'`), which is mutually exclusive with the `complaint`
 * and `unsubscribed` branches next to it — a spam complaint or explicit
 * opt-out is ALREADY a different Firestore status
 * (`complained`/`unsubscribed`) and is never touched by this classifier.
 * What's left inside `suppressed` may still include a few genuinely-dead
 * mailboxes alongside the mailbox-full cases — retrying those just costs one
 * wasted send attempt each; the existing webhook re-suppresses them on the
 * next bounce (self-healing, no extra bookkeeping needed here).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// Mailbox-full is usually resolved within days; 21 days is a conservative
// floor (shorter than the 120d newsletter-inactivity sunset in
// subscriberSunset.mjs, since this is a distinct, more transient signal).
export const SUPPRESSION_RETRY_GRACE_DAYS = 21;

// Caps API calls per run (this is the only place mailtrapSuppressionsApi.mjs
// gets called) and staggers the backlog drain across several weekly runs
// instead of resending to ~1900 people in one run the first time it ships.
// Raised 400->800 2026-07-27: first apply run hit the cap (400/400
// reactivated, 234 deferred) same-day, well under the ~1900 one-shot
// burst this constant guards against — doubling still bounds the batch
// while clearing same-day backlog instead of waiting for the next
// weekly cron.
export const MAX_REACTIVATIONS_PER_RUN = 800;

/**
 * `subscriberData.suppressed_at` must already be populated — either written
 * live by the webhook (functions/src/newsletterMailtrapWebhookCore.js) or
 * backfilled from event history by the caller (see
 * scripts/mailtrap-suppression-retry.mjs). Do NOT fall back to `updated_at`:
 * live check 2026-07-22 found addresses first suppressed 34-37 days ago
 * whose `updated_at` was only 1-2 days old, because something keeps
 * re-sending to already-suppressed addresses (11-22 repeat `suppressed`
 * events observed on single addresses — a separate bug, not accounted for
 * here) — `updated_at` would have wrongly excluded them as "too recent".
 *
 * @param {{ suppressed_at?: {toDate: () => Date}|string|Date|null }} subscriberData
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isRetryable(subscriberData, nowMs) {
  const v = subscriberData?.suppressed_at;
  if (!v) return true; // no age signal at all — don't block forever on missing data
  const effectiveAt = typeof v.toDate === 'function' ? v.toDate().getTime() : new Date(v).getTime();
  if (!Number.isFinite(effectiveAt)) return true;
  const ageDays = (nowMs - effectiveAt) / DAY_MS;
  return ageDays >= SUPPRESSION_RETRY_GRACE_DAYS;
}
