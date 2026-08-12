/**
 * suppressionDecay.mjs — pure classifier for MACHINE-INFERRED suppression.
 *
 * The defect this exists to close: subscriber `status` gates every send
 * (functions/src/lib/emailSuppression.js), and the machine-inferred
 * suppressions — `bounced`, `suppressed` — are permanent IN PRACTICE even
 * though nothing declares them permanent. Once one is written we stop sending
 * to that address, so the `delivered`/`open` event that would clear it
 * (`softBounceRecoveryFields()` / the `status: 'active'` rewrite in every
 * `persistJobAlert*Event`) can never arrive. The recovery edge exists only on
 * an event we have made unreachable. Every recovery so far has come from a
 * hand-run one-off (scripts/dev/reactivate-false-positive-bounces.mjs, run
 * with `--apply` once, on one collection, on 2026-07-01).
 *
 * Measured in production on 2026-08-10: 505 addresses blocked from ALL sends
 * with no unambiguous hard-bounce evidence, 453 of them confirmed signups.
 * The two existing scripts leave a gap in the middle rather than covering the
 * population between them:
 *   - reactivate-false-positive-bounces.mjs selects `status=='bounced'` and
 *     demands proof of life (delivered/opened);
 *   - scripts/mailtrap-suppression-retry.mjs selects `status=='suppressed'`
 *     and never sees a `bounced` doc at all.
 * 281 `newsletter_subscribers` docs sit between them: `bounce_reason` exactly
 * `reject` (a Mailtrap soft/reputation event), no `bounce_severity` field at
 * all (written before functions/src/lib/bounceClassification.js existed), all
 * bounced before 2026-07-01, and — in a 120-doc sample — 120/120 carrying a
 * `mailtrap:suspension` event with 0/120 ever delivered or opened.
 *
 * ── The evidence tiers ──────────────────────────────────────────────────────
 *
 * `proven-alive`  The mailbox has demonstrably accepted or been read
 *                 (`last_delivered_at` set, or open_count > 0) AND the reason
 *                 is not an unambiguous hard bounce. This is EXACTLY the
 *                 criteria the owner approved and ran with `--apply` on
 *                 2026-07-01 — this module does not invent a new policy, it
 *                 makes the approved one re-runnable and channel-complete.
 *
 * `never-probed`  Machine-suppressed, never delivered, never opened, reason
 *                 not hard, and suppressed longer than the cooldown. Owner
 *                 decision 2026-08-10: this tier is applied AUTOMATICALLY too,
 *                 but RAMPED — its true liveness is genuinely unknown, and
 *                 re-probing a dead list burns sender reputation across five
 *                 free-tier ESPs. The probe is the NORMAL SEND (nothing here
 *                 invents a probe message), and the rails below — batch size,
 *                 per-address budget, circuit breaker, settle window — are
 *                 what make an unattended cron safe. See `## Re-probe rails`.
 *
 * `terminal`      A human decision (`complained` / `unsubscribed`) or an
 *                 unambiguous hard-bounce reason. NEVER recovered, by any
 *                 tier, at any age. The human-decision half is the important
 *                 one: no amount of "evidence of life" may ever undo a spam
 *                 complaint or an opt-out.
 *
 * `none`          Not a machine-inferred suppression at all (mailable status),
 *                 or the engagement-sunset state `inactive` — see below.
 *
 * ── Why `inactive` is deliberately NOT decayed here ─────────────────────────
 *
 * `inactive` is a soft, per-channel sunset written by
 * scripts/lib/subscriberSunset.mjs (newsletter) and
 * scripts/lib/jobAlertSunset.mjs (job alerts), and BOTH already own the
 * reverse edge: `classifyJobAlertSunset` returns `reactivate` the moment an
 * `inactive` subscriber opens or clicks, and
 * newsletterMailtrapWebhookCore.js's `instantReactivationFields()` flips it
 * back live on the same signal. Decaying `inactive` from here would be a
 * SECOND, competing owner of the same transition. It is also not a population
 * worth a backfill: production carried 2 such docs on 2026-08-10.
 * `check-suppression-invariant.mjs` still counts it, in its own bucket, so the
 * choice stays visible instead of silent.
 *
 * Pure: no I/O, no Date.now() — the caller passes `nowMs`, same contract as
 * scripts/lib/jobAlertSunset.mjs and scripts/lib/mailtrapSuppressionRetry.mjs.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Unambiguous hard-bounce signals — the mailbox itself is gone or rejecting
 * permanently. Never recover on these, regardless of prior engagement.
 *
 * Single source of truth: this regex was written for, and validated by, the
 * owner-approved 2026-07-01 production run of
 * scripts/dev/reactivate-false-positive-bounces.mjs, which now imports it from
 * here. Two literal copies of a safety regex are exactly the drift AGENTS.md
 * Non-Negotiable #6 forbids — one of them would eventually be widened and the
 * other would keep recovering addresses the widened one meant to protect.
 */
export const HARD_BOUNCE_PATTERN = /does not exist|no such user|no such mailbox|user unknown|unknown user|invalid recipient|invalid mailbox|mailbox not found|mailbox unavailable|recipient rejected|address rejected|nonexistent|non-?existent|account.*disabled|disabled account|550[ -]?5\.1\.1|550[ -]?5\.1\.10|user doesn'?t exist/i;

/**
 * Statuses that encode a HUMAN decision. Structurally distinct from the
 * machine-inferred ones: every `newsletter*WebhookCore.js` writes these on the
 * `complaint` / `unsubscribed` branches, which are mutually exclusive with the
 * `bounce` / `suppressed` branches next to them. A doc in one of these states
 * was never machine-inferred and must never be undone by this pipeline.
 */
export const TERMINAL_STATUSES = new Set(['complained', 'unsubscribed']);

/**
 * Statuses written by a MACHINE inference about the mailbox — the only ones
 * this classifier may ever propose recovering. Both are in
 * ADDRESS_SUPPRESSED_STATUSES (functions/src/lib/emailSuppression.js), i.e.
 * both block every channel, which is what makes them self-sealing.
 */
export const DECAYABLE_STATUSES = new Set(['bounced', 'suppressed']);

/**
 * Soft per-channel sunset, owned by the two sunset classifiers (and by the
 * webhook's live `instantReactivationFields()`). Counted, never decayed here —
 * see the module header for why a second owner of that edge is a defect.
 */
export const ENGAGEMENT_SUNSET_STATUSES = new Set(['inactive']);

/**
 * How long a never-delivered, never-opened suppression must sit before it is
 * even eligible to be CONSIDERED for a re-probe. Deliberately longer than
 * SUPPRESSION_RETRY_GRACE_DAYS (21) in
 * scripts/lib/mailtrapSuppressionRetry.mjs: that script has provider-side
 * corroboration (it removes the Mailtrap suppression record first, and the
 * dominant cause there is the transient "Over quota"), while this tier has
 * none — no delivery, no open, no provider signal. A longer floor is the only
 * conservatism available to it.
 */
export const NEVER_PROBED_COOLDOWN_DAYS = 30;

/**
 * Hard cap on documents mutated per run, across ALL collections. Deliberately
 * far below mailtrapSuppressionRetry's 800: this pipeline runs unattended on a
 * weekly cron with no provider-side confirmation step, so a misclassification
 * here reaches real inboxes. 200/week drains the measured 505-address backlog
 * in ~3 runs while keeping any single mistake small enough to notice and
 * reverse. Overridable per run with `--limit`.
 */
export const MAX_DECAY_PER_RUN = 200;

/* ── Re-probe rails ─────────────────────────────────────────────────────────
 *
 * THE PROBE IS THE NORMAL SEND. Nothing here invents a probe message: the
 * runner un-suppresses a small batch, the next regular newsletter reaches them
 * through the existing cascade, and the provider webhook observes `delivered`
 * or `bounce`. That is what closes the loop in BOTH directions — a delivery
 * makes the address `proven-alive` for good, and a genuine hard bounce
 * re-suppresses it through `bounceUpdateFields({ severity: 'hard' })` while a
 * soft signal only increments the counter. The recovery edge and the
 * re-suppression edge are both the existing code; these constants only decide
 * HOW FAST addresses are fed into it.
 *
 * The risk being bounded is sender reputation across five free-tier ESPs, so
 * every rail below is a cap on exposure per unit time, not a correctness knob.
 */

/**
 * Addresses un-suppressed per run by the `never-probed` tier. Deliberately a
 * quarter of MAX_DECAY_PER_RUN: proven-alive addresses have already accepted
 * mail, these have not. At the measured backlog (357 on 2026-08-10) a weekly
 * cron drains it in ~8 runs while adding ~50 never-delivered addresses to a
 * ~5.900-recipient newsletter — under 1% of the send, instead of the ~6% a
 * one-shot drain would add.
 */
export const REPROBE_BATCH_SIZE = 50;

/**
 * How many times one address may be fed to the send cascade before it is
 * treated as genuinely dead. Two: the first probe distinguishes "mailbox was
 * temporarily full" from "mailbox is gone", the second covers a single
 * unlucky transient. A third would be re-probing a known-bad address on a
 * hunch, which is precisely what burns a shared sending domain — and without
 * this cap the runner would re-select the same dead addresses every week
 * forever, because a re-suppressed doc looks exactly like a fresh one.
 */
export const MAX_REPROBE_ATTEMPTS = 2;

/**
 * Circuit breaker. If more than this share of the previous cohort came back
 * suppressed, the population is not what the classifier thinks it is and the
 * next batch must not go out.
 *
 * 12% is not a guess — it is anchored on the outcome of the SAME operation
 * already performed on this database. The 2.016 `newsletter_subscribers` docs
 * reactivated by the owner-approved 2026-07-01 run (identifiable by their
 * `bounce_reactivated_at` stamp) were measured on 2026-08-10: 1.955 delivered
 * (96,97%), 1.202 opened (59,6%), and only **11 bounced again (0,55%)**. 12% is
 * ~22× that observed re-bounce rate — wide enough that normal variance on a
 * 50-address cohort (one bounce = 2%) never trips it, tight enough to catch a
 * genuinely bad cohort on its FIRST batch. A 30% threshold, by contrast, is
 * ~55× the observed rate and would only ever fire on a catastrophe, which is
 * not what a breaker is for.
 *
 * IMPORTANT: that 0,55% base rate does NOT transfer wholesale to the
 * `never-probed` tier. Those addresses were excluded from the July run
 * precisely because they have no delivery and no open in their history, so
 * their true liveness is unknown — which is the entire reason they need
 * probing rather than bulk reactivation. The threshold is calibrated against
 * the only measurement that exists; the 50-per-run batch cap is what buys the
 * real number for this tier safely.
 */
export const REPROBE_HALT_HARD_BOUNCE_RATE = 0.12;

/**
 * A single spam complaint from a re-probed cohort halts too, independently of
 * the bounce rate. Complaints are the signal ESPs actually punish: 1-in-50 is
 * 2%, twenty times the 0.1% industry ceiling. A bounce says the mailbox is
 * gone; a complaint says a person who never asked for this is annoyed.
 */
export const REPROBE_HALT_COMPLAINT_COUNT = 1;

/**
 * A cohort must be old enough for its outcome to MEAN anything before it is
 * measured. Without this the breaker is trivially defeated: a cohort probed an
 * hour ago has a 0% bounce rate because no send has happened yet, so a
 * same-day second run would read "all clear" and release another batch. The
 * weekly cron clears this by a wide margin; it exists for `workflow_dispatch`.
 */
export const REPROBE_COHORT_SETTLE_HOURS = 48;

/**
 * Every collection a sender reads a suppression `status` from. Driving both
 * the runner and the monitor off this ONE array is the point of the module:
 * `reactivate-false-positive-bounces.mjs` queried only `newsletter_subscribers`
 * and so the job-alert channel was never cleaned even once — a third channel
 * added later would repeat that silently. `tests/suppression-decay.test.ts`
 * asserts this array covers every `*_subscribers` collection named by a file
 * that calls one of the emailSuppression predicates, so the omission becomes a
 * red test instead of an unnoticed population.
 */
export const SUPPRESSION_COLLECTIONS = ['newsletter_subscribers', 'job_alert_subscribers'];

/**
 * The FULLY-mailable status per collection — what a doc is restored to when
 * consent is not in question. NOT one shared value: the two channels have
 * different vocabularies, and writing the wrong one is silently lossy rather
 * than loud. `newsletter_subscribers` uses `confirmed` (what the
 * owner-approved 2026-07-01 run wrote); `job_alert_subscribers` uses `active`
 * — the only non-empty value in jobAlertSunset.mjs's MAILABLE_STATUSES and the
 * value its own webhook writes on delivered/open/click. A job-alert doc
 * restored to `confirmed` WOULD be mailable (isJobAlertExcluded says so), but
 * classifyJobAlertSunset would then refuse to ever sunset it again — a zombie
 * immune to list hygiene.
 *
 * For the newsletter this is a CEILING, not an unconditional value — see
 * `recoveredStatus()`.
 */
export const RECOVERED_STATUS_BY_COLLECTION = {
  newsletter_subscribers: 'confirmed',
  job_alert_subscribers: 'active',
};

/**
 * Newsletter origins that confirm at signup by design (the user performed an
 * explicit act — unlocking a job, signing in with a provider — so no double
 * opt-in is ever sent).
 *
 * Single source of truth, imported by
 * scripts/restore-mailtrap-suspension-suppressions.mjs, which is where it was
 * first written and reasoned out. Mirrors CONFIRMED_NEWSLETTER_SOURCES in
 * services/newsletterSubscribers.ts.
 *
 * `publisher_gate_social` only. Its sibling `publisher_gate_email` is
 * pending-BY-DESIGN: components/pages/PublisherPublishPage.tsx deliberately
 * omits status/isActive there so a new address falls to `pending` and gets the
 * opt-in email, and CONFIRMED_NEWSLETTER_SOURCES does not list it. Matching the
 * bare `publisher_gate` prefix would restore those to `confirmed` — exactly the
 * fabricated consent this exists to prevent.
 */
export const AUTO_CONFIRMED_ORIGIN_RE = /^(signup|auth_|chatbot_|job_|tax_calendar_(google|facebook)|resubscribe_link|newsletter_email_link|one_tap|publisher_gate_social)/i;

/**
 * Positive evidence that this newsletter subscriber ever gave consent.
 *
 * @param {object} sub subscriber doc fields
 * @param {object[]} [events] docs from the subscriber's `events` subcollection
 * @returns {boolean}
 */
export function hasConsentEvidence(sub, events = []) {
  if (sub?.confirmed_at || sub?.confirmedAt) return true;
  for (const e of events || []) {
    const t = String(e?.event_type || '');
    if (t === 'confirm' || t === 'subscribe_completed') return true;
  }
  for (const field of [sub?.source_cta, sub?.source, sub?.source_channel]) {
    if (field && AUTO_CONFIRMED_ORIGIN_RE.test(String(field))) return true;
  }
  return false;
}

/**
 * The status one doc is restored to.
 *
 * CONSENT-AWARE for the newsletter, and that is not a nicety: a subscriber who
 * was still `pending` (signed up, never clicked the double-opt-in link) when
 * the suppression landed must NOT come back as `confirmed` — that fabricates a
 * consent they never gave, which is a worse state than the bug being repaired.
 * The proven-alive tier does NOT protect against this on its own: `pending`
 * subscribers routinely have `last_delivered_at` set, because the opt-in email
 * itself was delivered.
 *
 * scripts/restore-mailtrap-suspension-suppressions.mjs worked this out first
 * (2026-07-29) and the owner-approved 2026-07-01 one-off predates it — it wrote
 * `confirmed` unconditionally. This is the corrected form, applied to the
 * general path so it cannot regress back to the older behaviour.
 *
 * Job alerts have no double opt-in and no `pending` state: the doc exists
 * because the user created an alert, so `active` is unconditional there.
 *
 * @param {string} collection
 * @param {object} sub
 * @param {object[]} [events]
 * @returns {string}
 */
export function recoveredStatus(collection, sub, events = []) {
  if (collection !== 'newsletter_subscribers') return RECOVERED_STATUS_BY_COLLECTION[collection];
  return hasConsentEvidence(sub, events) ? 'confirmed' : 'pending';
}

/** Tiers a runner may be asked to act on. `terminal`/`none` are never actionable. */
export const ACTIONABLE_TIERS = ['proven-alive', 'never-probed'];

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toMillis(v) {
  if (!v) return null;
  if (typeof v === 'object' && typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v === 'object' && typeof v.toDate === 'function') return v.toDate().getTime();
  if (typeof v === 'object' && typeof v._seconds === 'number') return v._seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * The recorded reason string. `bounce_reason` is what
 * bounceClassification.js's `bounceUpdateFields()` writes on both severities;
 * the other spellings cover pre-classifier and provider-specific writers.
 */
export function suppressionReason(sub) {
  return String(
    sub?.bounce_reason
      ?? sub?.suppression_reason
      ?? sub?.mailtrap_suppression_category
      ?? '',
  );
}

/**
 * True when the mailbox has demonstrably worked at least once. Both spellings
 * are checked because job-alert docs and newsletter docs were written by
 * different generations of handler (`open_count` today, `openCount` on the
 * older docs) — reading only one spelling silently downgrades a proven-alive
 * address to the risky `never-probed` tier.
 */
export function hasProofOfLife(sub) {
  const everDelivered = !!(sub?.last_delivered_at ?? sub?.lastDeliveredAt);
  const everOpened = num(sub?.open_count ?? sub?.openCount) > 0;
  return { everDelivered, everOpened, alive: everDelivered || everOpened };
}

/**
 * Age in days of the suppression itself, or null when no anchor exists.
 *
 * `updated_at` is deliberately NOT a fallback — the same trap documented in
 * scripts/lib/mailtrapSuppressionRetry.mjs: live checks found addresses first
 * suppressed 34-37 days ago whose `updated_at` was 1-2 days old because
 * something kept re-sending to already-suppressed addresses. Using it would
 * wrongly report an old suppression as too recent to touch.
 */
export function suppressionAgeDays(sub, nowMs) {
  const at =
    toMillis(sub?.suppressed_at)
    ?? toMillis(sub?.bounced_at)
    ?? toMillis(sub?.last_bounced_at)
    ?? null;
  if (at == null) return null;
  return (nowMs - at) / DAY_MS;
}

/** Anything shaped like an address. Deliberately greedy on the local part. */
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Longest reason string kept verbatim. Mailtrap writes 240-char prose. */
export const MAX_REASON_LENGTH = 120;

/**
 * Strip addresses out of a provider-supplied reason string.
 *
 * NOT cosmetic. Reason strings are written verbatim from provider payloads and
 * SOME CARRY THE RECIPIENT'S ADDRESS — production, 2026-08-10:
 * `"<…@icloud.com>: user is over quota"`. Those strings are grouped and counted
 * into the body of a PUBLIC GitHub issue by
 * .github/workflows/suppression-hygiene.yml, and into a downloadable run
 * artifact. Redacting at the source (rather than at each call site) is what
 * makes it impossible for a new consumer of `reasonBreakdown` to leak one.
 * AGENTS.md Privacy: never put a personal address in code, config or data.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactEmails(text) {
  return String(text ?? '').replace(EMAIL_IN_TEXT, '<email-redacted>');
}

/**
 * A reason string safe to publish: address-free and length-bounded, so a
 * 240-char provider paragraph does not swallow the issue body.
 *
 * @param {string} text
 * @returns {string}
 */
export function publishableReason(text) {
  const clean = redactEmails(text).trim();
  if (!clean) return '(empty)';
  return clean.length > MAX_REASON_LENGTH ? `${clean.slice(0, MAX_REASON_LENGTH)}…` : clean;
}

/**
 * Subscriber-identifying value reduced to what diagnostics actually need: the
 * DOMAIN (the signal — "all of these are icloud.com" is the finding worth
 * having) with the local part masked. Reports written by these scripts are
 * uploaded as workflow artifacts; a raw subscriber list must not be.
 *
 * @param {string} address
 * @returns {string}
 */
export function maskAddress(address) {
  const s = String(address ?? '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return '(masked)';
  return `${s.slice(0, 1)}***@${s.slice(at + 1)}`;
}

/**
 * @typedef {{
 *   tier: 'proven-alive'|'never-probed'|'terminal'|'none',
 *   recoverable: boolean,
 *   reason: string,
 *   evidence: { status: string, bounceReason: string, everDelivered: boolean, everOpened: boolean, ageDays: number|null },
 * }} SuppressionDecayVerdict
 */

/**
 * Classify one subscriber doc for suppression decay.
 *
 * @param {object} sub Firestore subscriber doc fields
 * @param {number} nowMs current time in ms
 * @returns {SuppressionDecayVerdict}
 */
export function classifySuppressionDecay(sub, nowMs) {
  const status = norm(sub?.status);
  const bounceReason = suppressionReason(sub);
  const { everDelivered, everOpened, alive } = hasProofOfLife(sub);
  const ageDays = suppressionAgeDays(sub, nowMs);
  const evidence = { status, bounceReason, everDelivered, everOpened, ageDays };
  // `code` is the MACHINE-readable discriminator. classifySuppressionEvidence
  // buckets on it, and matching on the human-readable `reason` string instead
  // would tie a monitor's output to prose that is meant to be editable.
  const verdict = (tier, code, recoverable, reason) => ({ tier, code, recoverable, reason, evidence });

  // Human decisions first, and unconditionally: a complaint or an opt-out
  // outranks every piece of "the mailbox is alive" evidence there is. Being
  // alive is precisely why they told us to stop.
  if (TERMINAL_STATUSES.has(status)) {
    return verdict('terminal', 'human-status', false, `human decision: status '${status}' is never reversed by decay`);
  }

  // Soft channel sunset — owned by the sunset classifiers, see module header.
  if (ENGAGEMENT_SUNSET_STATUSES.has(status)) {
    return verdict('none', 'engagement-sunset', false, `engagement sunset '${status}' is owned by the sunset classifiers, not decayed here`);
  }

  if (!DECAYABLE_STATUSES.has(status)) {
    return verdict('none', 'mailable', false, `status '${status}' is not a machine-inferred suppression`);
  }

  // ── The opt-out STAMPS, not only the current status ──────────────────────
  //
  // `status` is a single field where the last writer wins: a subscriber who
  // opted out and then received one more send before the filter caught up ends
  // up `status: 'bounced'` with `unsubscribed_at` still set, and the status
  // check above misses it entirely. The stamps are append-only — every
  // `newsletter*WebhookCore.js` writes `unsubscribed_at`/`complained_at` and
  // none of them ever clears one — so they are the durable record.
  //
  // Checked HERE, after the decayable gate, and not at the top: production on
  // 2026-08-10 has 773 newsletter docs carrying `unsubscribed_at`, of which 268
  // are currently `confirmed` — people who unsubscribed and later signed up
  // again. Only 3 are in a suppressed status at all. Testing the stamp before
  // the status gate would label all 268 of those healthy subscribers
  // `terminal`; it changes no write (they are not decayable either way) but it
  // makes every count this file produces wrong, including the ones the
  // circuit breaker and the escalation issue are read from.
  if (sub?.complained_at || sub?.complainedAt || sub?.last_complained_at) {
    // Unconditional: a spam complaint is not undone by a later signup form.
    return verdict('terminal', 'human-complaint-stamp', false, 'human decision: a spam complaint is recorded, whatever the current status says');
  }
  const unsubscribedAt = toMillis(sub?.unsubscribed_at) ?? toMillis(sub?.unsubscribedAt);
  if (unsubscribedAt != null) {
    // …unless they came back. A `confirmed_at` strictly newer than the opt-out
    // is a re-subscription, which makes the old stamp stale rather than
    // binding. 227 of the 268 above are exactly this, and 1 of the 3
    // suppressed-and-stamped docs is too — without this branch that person
    // stays deleted forever on the strength of a decision they reversed.
    //
    // `resubscribed_at` is read alongside it since #5711, and it is the
    // NARROWER of the two signals — only the explicit re-opt-in paths write it,
    // where `confirmed_at` is written by anything landing on `confirmed`. It
    // matters here because the preference-centre toggle re-subscribes WITHOUT
    // writing `confirmed_at`, and since #5711 stopped deleting the opt-out
    // stamp that document would otherwise read as terminal forever.
    //
    // NOTE — the broader `confirmed_at` rule stays deliberately confined to
    // this file. services/newsletterOptOut.mjs refuses it on purpose: all 186
    // resurrections of #5672 carry a newer `confirmed_at`, so using it to
    // decide MAILABILITY would exempt exactly the cohort that guard exists for.
    // The decision here is different — whether to decay a machine-inferred
    // suppression — and never whether to mail anyone.
    const confirmedAt = toMillis(sub?.confirmed_at) ?? toMillis(sub?.confirmedAt);
    const resubscribedAt = toMillis(sub?.resubscribed_at) ?? toMillis(sub?.resubscribedAt);
    const revivedAt = Math.max(confirmedAt ?? -Infinity, resubscribedAt ?? -Infinity);
    if (!Number.isFinite(revivedAt) || revivedAt <= unsubscribedAt) {
      return verdict('terminal', 'human-unsubscribe-stamp', false, 'human decision: unsubscribed_at is recorded and never superseded by a later confirmation');
    }
  }

  // ── Severity is the PRIMARY signal; the regex is the legacy fallback ─────
  //
  // `bounce_severity` is a STRUCTURED verdict written by
  // `classifyBounceSeverity()` (functions/src/lib/bounceClassification.js).
  // Reading the reason text first, and the field never, inverts the two: it
  // makes a prose string authoritative over the classification the system
  // actually computed.
  //
  // It is also a live defect, not a tidiness point. `maybeEscalateSoftBounce()`
  // writes `status: 'bounced'`, `bounce_severity: 'hard'` and
  // `bounce_reason: "<reason> (escalated after N consecutive soft rejects)"`
  // after 3 consecutive soft rejects with no delivery in between — a
  // DELIBERATELY permanent suppression that exists to protect the sending
  // domain. That reason string contains none of the phrases in
  // HARD_BOUNCE_PATTERN, so a regex-only test files it as recoverable. Since
  // most of those addresses do have historical deliveries, they land in
  // `proven-alive` and the weekly `--apply` job would restore every one of them
  // — and `recoveryFields()` writes `soft_bounce_count: 0`, which re-arms the
  // escalation counter. Escalate → decay → escalate → decay, once a week,
  // forever: an oscillator that cancels the protection entirely. Measured
  // population on 2026-08-10: 84 + 28 docs in `job_alert_subscribers` and
  // 3 + 27 + 5 in `newsletter_subscribers`.
  //
  // Keyed on the FIELD, not on the `(escalated after …)` suffix: pattern-
  // matching a string to fix a string-matching bug survives exactly until
  // someone rewords the message.
  if (norm(sub?.bounce_severity) === 'hard') {
    return verdict('terminal', 'hard-severity', false, `provider bounce classified hard (bounce_severity), reason "${bounceReason}"`);
  }

  // Legacy fallback ONLY, for documents written before `bounce_severity`
  // existed. That absence is the COMMON case in this backlog — it is precisely
  // what defines the population this module exists to drain — so a missing
  // field must never be read as hard.
  if (HARD_BOUNCE_PATTERN.test(bounceReason)) {
    return verdict('terminal', 'hard-reason', false, `unambiguous hard-bounce reason: "${bounceReason}"`);
  }

  if (alive) {
    return verdict(
      'proven-alive',
      'proof-of-life',
      true,
      `mailbox proven alive (delivered=${everDelivered}, opened=${everOpened}) with non-hard reason "${bounceReason}"`,
    );
  }

  // Re-probe budget exhausted. Checked AFTER the proof-of-life branch on
  // purpose: if a probe ever produced a delivery or an open, the address has
  // graduated to the evidence-backed tier and the budget is irrelevant. Here
  // it has not — it has been fed to the send cascade MAX_REPROBE_ATTEMPTS
  // times and came back suppressed every time. That is as close to proof of
  // death as this system can get, and continuing to probe it would be the
  // reputation cost the ramp exists to avoid.
  const probes = num(sub?.reprobe_count);
  if (probes >= MAX_REPROBE_ATTEMPTS) {
    return verdict(
      'terminal',
      'probe-exhausted',
      false,
      `re-probed ${probes}/${MAX_REPROBE_ATTEMPTS} times with no delivery and no open — budget exhausted`,
    );
  }

  // Unknown age is treated as ELIGIBLE, not as blocked — the same choice, for
  // the same reason, as `isRetryable()` in mailtrapSuppressionRetry.mjs: the
  // pre-classifier backlog this tier exists to surface is exactly the set of
  // docs written before the timestamp fields existed, so a missing anchor
  // would hide the population the tier was built to count. Safe because
  // `never-probed` is report-only in .github/workflows/suppression-hygiene.yml
  // and never applied unattended.
  if (ageDays == null || ageDays >= NEVER_PROBED_COOLDOWN_DAYS) {
    return verdict(
      'never-probed',
      'reprobe-eligible',
      true,
      ageDays == null
        ? `never delivered nor opened, non-hard reason "${bounceReason}", suppression age unknown`
        : `never delivered nor opened, non-hard reason "${bounceReason}", suppressed ${Math.floor(ageDays)}d ago`,
    );
  }

  return verdict(
    'none',
    'cooldown',
    false,
    `never probed but still cooling down (${Math.floor(ageDays)}d < ${NEVER_PROBED_COOLDOWN_DAYS}d)`,
  );
}

/* ── Re-probe selection and the breaker ─────────────────────────────────── */

/**
 * Oldest suppression first, then by key. Deterministic ORDER is a rail, not a
 * nicety: without it two runs against a shifting snapshot select overlapping
 * arbitrary subsets, so no cohort has a measurable outcome and the circuit
 * breaker below is reading noise. Oldest-first also puts the pre-classifier
 * backlog — the population this tier exists for — at the front.
 *
 * A missing age anchor sorts as INFINITELY old: those docs predate the
 * timestamp fields entirely (see `suppressionAgeDays`), so they are the oldest
 * there are, not the youngest.
 *
 * @param {{ ageDays: number|null, key: string }} a
 * @param {{ ageDays: number|null, key: string }} b
 */
export function compareOldestSuppressionFirst(a, b) {
  const aAge = a?.ageDays == null ? Infinity : a.ageDays;
  const bAge = b?.ageDays == null ? Infinity : b.ageDays;
  if (aAge !== bAge) return bAge - aAge;
  const aKey = String(a?.key ?? '');
  const bKey = String(b?.key ?? '');
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

/**
 * Cohort id for a run. ISO-8601, so `max()` over the stamps found on the
 * documents themselves identifies the most recent cohort — no side ledger, no
 * state file. That matters because `data/suppression-decay-report.json` does
 * NOT survive between GitHub Actions runs: a breaker that depended on it would
 * silently reset every week. Recomputing from Firestore each run is strictly
 * stronger than persistence — it cannot be lost, and it cannot go stale.
 *
 * @param {number} nowMs
 */
export function reprobeBatchId(nowMs) {
  return new Date(nowMs).toISOString();
}

/**
 * Was this doc adverse after being probed?
 *
 * The runner leaves every probed address MAILABLE, so a doc found back in a
 * suppressed status has been re-suppressed by the webhook since — which, given
 * that a soft signal only increments the soft-bounce counter, means a genuine
 * hard bounce. No timestamp comparison is needed for that inference; the
 * mailable-at-probe-time postcondition is what carries it.
 */
function cohortOutcome(sub) {
  const status = norm(sub?.status);
  if (status === 'complained') return 'complaint';
  if (DECAYABLE_STATUSES.has(status)) return 'hard-bounce';
  return 'ok';
}

/**
 * Decide whether a new re-probe batch may go out, from the previous cohort's
 * measured outcome. STICKY BY CONSTRUCTION: while the breaker is tripped no
 * new cohort is created, so the offending cohort remains the most recent one
 * and every later run reaches the same verdict. Clearing it is a deliberate
 * owner act (`--force-reprobe`), never a timeout.
 *
 * @param {{ batchId: string|null, docs: object[] }} cohort
 * @param {number} nowMs
 * @returns {{ batchId: string|null, size: number, hardBounces: number, complaints: number,
 *             hardBounceRate: number, settled: boolean, allowed: boolean, halted: boolean, reason: string }}
 */
export function evaluateReprobeCohort({ batchId = null, docs = [] } = {}, nowMs) {
  const base = { batchId, size: docs.length, hardBounces: 0, complaints: 0, hardBounceRate: 0 };

  // No cohort has ever gone out — the first batch is unconditionally allowed.
  if (!batchId || docs.length === 0) {
    return { ...base, settled: true, allowed: true, halted: false, reason: 'no previous cohort — first batch' };
  }

  const stampedAt = Date.parse(batchId);
  const ageHours = Number.isFinite(stampedAt) ? (nowMs - stampedAt) / (60 * 60 * 1000) : Infinity;
  let hardBounces = 0;
  let complaints = 0;
  for (const doc of docs) {
    const outcome = cohortOutcome(doc);
    if (outcome === 'hard-bounce') hardBounces += 1;
    else if (outcome === 'complaint') complaints += 1;
  }
  const hardBounceRate = hardBounces / docs.length;
  const measured = { ...base, hardBounces, complaints, hardBounceRate };

  if (ageHours < REPROBE_COHORT_SETTLE_HOURS) {
    return {
      ...measured,
      settled: false,
      allowed: false,
      halted: false,
      reason: `cohort ${batchId} is ${Math.floor(ageHours)}h old (< ${REPROBE_COHORT_SETTLE_HOURS}h) — its outcome is not measurable yet`,
    };
  }

  if (complaints >= REPROBE_HALT_COMPLAINT_COUNT) {
    return {
      ...measured,
      settled: true,
      allowed: false,
      halted: true,
      reason: `${complaints} spam complaint(s) from cohort ${batchId} (limit ${REPROBE_HALT_COMPLAINT_COUNT}) — halted`,
    };
  }

  if (hardBounceRate > REPROBE_HALT_HARD_BOUNCE_RATE) {
    return {
      ...measured,
      settled: true,
      allowed: false,
      halted: true,
      reason: `cohort ${batchId} re-bounced at ${(hardBounceRate * 100).toFixed(1)}% (> ${(REPROBE_HALT_HARD_BOUNCE_RATE * 100).toFixed(0)}%) — halted`,
    };
  }

  return {
    ...measured,
    settled: true,
    allowed: true,
    halted: false,
    reason: `cohort ${batchId} re-bounced at ${(hardBounceRate * 100).toFixed(1)}% (<= ${(REPROBE_HALT_HARD_BOUNCE_RATE * 100).toFixed(0)}%), ${complaints} complaint(s) — clear`,
  };
}

/**
 * ── The invariant ───────────────────────────────────────────────────────────
 *
 * No address may be suppressed without either a human decision or unambiguous
 * hard evidence. Buckets one doc for `scripts/check-suppression-invariant.mjs`:
 *
 *   own-choice         the human decided (`complained` / `unsubscribed`)
 *   hard-evidence      machine-inferred, with a reason matching HARD_BOUNCE_PATTERN
 *   engagement-sunset  `inactive` — reversible by-construction on the next
 *                      open/click, so it is not a violation, but it IS still a
 *                      block on sending and is reported separately rather than
 *                      folded into a bucket that implies evidence it lacks
 *   no-evidence        machine-inferred, non-hard reason → THE VIOLATION
 *   not-suppressed     mailable
 *
 * @param {object} sub
 * @param {number} nowMs
 * @returns {'own-choice'|'hard-evidence'|'engagement-sunset'|'no-evidence'|'not-suppressed'}
 */
export function classifySuppressionEvidence(sub, nowMs) {
  const status = norm(sub?.status);
  if (TERMINAL_STATUSES.has(status)) return 'own-choice';
  if (ENGAGEMENT_SUNSET_STATUSES.has(status)) return 'engagement-sunset';
  if (!DECAYABLE_STATUSES.has(status)) return 'not-suppressed';

  // Delegate to the decay classifier rather than re-deriving the rules. If the
  // two disagreed about one doc, the monitor would cry about a residue the
  // self-heal is right to leave alone — or, worse, stay silent about one it
  // isn't. Bucketing on the machine-readable `code`, never on the prose.
  const { code } = classifySuppressionDecay(sub, nowMs);
  if (code === 'hard-reason' || code === 'hard-severity') return 'hard-evidence';
  if (code === 'human-status' || code === 'human-complaint-stamp' || code === 'human-unsubscribe-stamp') {
    return 'own-choice';
  }
  // Exhausted probe budget is EVIDENCE — our own, empirical: we fed this
  // address to the send cascade MAX_REPROBE_ATTEMPTS times and it came back
  // suppressed every time. But it is neither a human decision nor a
  // hard-bounce reason, so folding it into either bucket would overstate what
  // we know. Its own bucket keeps the invariant's claim literally true.
  if (code === 'probe-exhausted') return 'probe-exhausted';
  return 'no-evidence';
}
