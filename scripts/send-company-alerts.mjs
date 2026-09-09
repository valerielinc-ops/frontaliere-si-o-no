#!/usr/bin/env node
/**
 * CompanyAlert — IMMEDIATE sender (issue #5012, phase 2 of #5151).
 *
 * The issue specifies `immediate` as the phase-1 cadence: an email when the
 * followed employer publishes, not a slot in tomorrow's digest. That is a
 * different trigger, not different copy — scripts/send-job-alerts.mjs is a
 * once-a-day cron whose candidate pool is a 24h `crawledAt` window, so a
 * CompanyAlert riding it arrives up to 24h late and buried among unrelated
 * matches.
 *
 * This runner is event-driven instead: .github/workflows/send-company-alerts.yml
 * fires on every push that touches `data/jobs/by-crawler/**` — the commit the
 * crawlers and publisher-jobs-sync make when a new ad lands — plus an hourly
 * safety-net cron.
 *
 * ── THE FIRESTORE QUERY, AND WHY IT NOW NARROWS SERVER-SIDE ───────────────
 * The alert load used to be byte-for-byte the digest's —
 * `db.collectionGroup('alerts').where('active','==',true)` — with the
 * company/immediate selection done entirely IN MEMORY. The header justifying
 * that said any extra `where` would need a composite index, and that
 * `firestore.indexes.json` is not applied by CI (deploy-firestore-rules.yml
 * ships `firestore:rules` only), so the query would go live and fail with
 * FAILED_PRECONDITION after a green merge.
 *
 * The premise held; the conclusion did not. Firestore only needs a COMPOSITE
 * index when a query mixes an equality with a range/orderBy on another field.
 * `active == true AND frequency == 'immediate'` is two equalities, which the
 * automatic single-field COLLECTION_GROUP indexes already serve by
 * intersection. Measured read-only against production on 2026-08-24, with
 * zero composite indexes deployed (the API reports 0):
 *
 *   active == true                             6.969 docs   (what we read)
 *   active == true AND frequency == 'immediate'   53 docs   (what we use)
 *   frequency == 'immediate' alone              FAILED_PRECONDITION
 *
 * The third line is the trap worth naming: dropping `active` is what needs an
 * index we do not have. `active` must stay first and stay in the query.
 *
 * This runner fires ~24x/day (hourly cron + one per crawler push), so the
 * in-memory filter was reading ~164k documents a day to keep 53 — about a
 * fifth of the whole project's Firestore read bill. The query is wrapped in a
 * FAILED_PRECONDITION fallback to the old shape anyway: a wrong reading of
 * Firestore's index rules must cost reads, never a missed alert.
 *
 * `isImmediateCompanyAlert` still runs in memory, and still owns the
 * partition: it also demands `specificCompanyKey` and `!paused`, neither of
 * which this query expresses.
 *
 * ── WHAT COUNTS AS "NEW" ──────────────────────────────────────────────────
 * `firstSeenAt` inside IMMEDIATE_WINDOW_MS — the genuine novelty field
 * (assemble-jobs-dataset.mjs carries it forward across re-crawls), NOT
 * `crawledAt`, which refreshes on every re-crawl and would re-send the whole
 * standing inventory on the first run. The per-alert `sentJobIds` dedup
 * (scripts/lib/alert-sent-jobs.mjs, shared with the digest) is the second,
 * independent guard: even a bad window can never mail the same job twice.
 *
 * ── ONE EMAIL PER RECIPIENT, NOT PER ALERT (residuo #5283) ────────────────
 * This runner used to iterate ALERTS and send one email each. Following ten
 * employers that published inside the same 6h window therefore produced ten
 * emails, arriving within seconds of each other, each naming one company —
 * which is also why MAX_COMPANY_ALERTS_PER_USER sat at 10 with a comment
 * saying the cap was standing in for grouping that did not exist yet.
 *
 * Now the run groups by recipient first: every alert of one address becomes a
 * SECTION of a single message. The three consequences worth knowing:
 *
 *   - The per-inbox ceiling for a run is 1 message, whatever the follow count.
 *     That is what freed the cap (now 20, see services/jobAlertService.ts).
 *   - `sentJobIds` stays PER ALERT. Grouping changes what one email covers, not
 *     what "already sent" means, so every alert whose section was rendered gets
 *     its own map updated — and only if the message actually went out.
 *   - PER_RUN_CAP now counts recipients, not emails (they were the same thing
 *     before). See the constant.
 *
 * Environment:
 *   ENABLE_JOB_ALERTS=true         — same master switch as the digest
 *   GOOGLE_APPLICATION_CREDENTIALS — Firebase service account
 *   NEWSLETTER_SECRET              — HMAC for unsubscribe/preferences links
 *   TARGET_EMAIL                   — limit to one recipient (test mode)
 *   COMPANY_ALERT_WINDOW_HOURS     — override the novelty window (default 6)
 *
 * Usage: node scripts/send-company-alerts.mjs [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildAlertProfile,
  scoreJobForAlert,
  jobCompanyIdentityQuarantineReason,
} from '../services/jobAlertMatching.mjs';
import {
  buildCompanyAlertEmail,
  allocateCompanyAlertCards,
  COMPANY_ALERT_TEMPLATE_ID,
  COMPANY_ALERT_MAX_TOTAL_CARDS,
} from '../services/companyAlertEmail.mjs';
import { nlNormLocale } from '../services/newsletter-template.mjs';
import { isCrossChannelStop, isJobAlertExcluded } from '../services/emailSuppression.mjs';
import { generateAutologinCode, makeAuthenticatedUrl } from '../services/newsletterUrls.mjs';
import {
  normalizeSentMap,
  normalizeDeliveryLedger,
  deliveryEntryBlocksRetry,
  filterUnsentJobs,
  mergeSentJobs,
  mergeDeliveryLedger,
  removeDeliveryLedgerJobs,
  jobDedupKey,
  jobIdentityQuarantineReason,
  DELIVERY_STATES,
  DEDUP_WINDOW_MS,
  DEFERRED_MAX_ATTEMPTS,
} from './lib/alert-sent-jobs.mjs';
import { makeAlertUnsubscribeUrl, makeAllAlertsUnsubscribeUrl, BASE_URL } from './lib/job-alert-unsub-urls.mjs';
import { FIRESTORE_BATCH_SIZE } from './lib/firestore-batch.mjs';
import { isImmediateCompanyAlert, IMMEDIATE_FREQUENCY } from './lib/company-alert-routing.mjs';
import { companyAlertQuarantineReason } from './lib/company-alert-routing.mjs';
/**
 * `/aziende-seguite/` per locale — ONE literal segment for every language, like
 * `/aziende/` in services/companyAlertEmail.mjs.
 *
 * The slug is duplicated from ROUTE_SLUGS.followedCompanies rather than
 * imported: this workflow runs the sender under plain `node`
 * (.github/workflows/send-company-alerts.yml), and services/routeSlugs.data.ts
 * is TypeScript — importing it would take the whole send down at runtime for a
 * string. Duplicated, therefore asserted: tests/company-alert.test.ts fails if
 * the two ever disagree, which would send every reader to a 404.
 */
const FOLLOWED_COMPANIES_SLUG = 'aziende-seguite';
function followedCompaniesPath(locale) {
  const prefix = locale === 'it' ? '' : `/${locale}`;
  return `${prefix}/${FOLLOWED_COMPANIES_SLUG}/`;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const FROM_EMAIL = 'Frontaliere Ticino <alerts@frontaliereticino.ch>';
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Novelty window. Wider than the workflow's own cadence on purpose: a push-run
 * that fails, a queued Actions runner or a crawler group that commits late must
 * not silently drop a job. Over-inclusion is harmless — `sentJobIds` dedups.
 */
const IMMEDIATE_WINDOW_MS = Math.max(1, Number(process.env.COMPANY_ALERT_WINDOW_HOURS) || 6) * 60 * 60 * 1000;

const CLOSED_JOB_STATUSES = new Set([
  'archived',
  'closed',
  'deleted',
  'expired',
  'inactive',
  'removed',
]);

// These are the states written by the two consent containers. `subscribed` is
// a known reactivation state, but not sendable here: the preferences-link
// writer does not establish double-opt-in proof, and company-follow consent
// is a separate gate. Anything else, including `pending` and a missing
// document, is unknown and therefore fail-closed in the sender.
const NEWSLETTER_SENDABLE_STATUS = 'confirmed';
const NEWSLETTER_NON_SENDABLE_STATUS_REASONS = Object.freeze({
  subscribed: 'newsletter-consent-resubscribe-status',
});
const JOB_ALERT_SENDABLE_STATUS = 'active';

/**
 * Per-run cap on RECIPIENTS, mirroring blast-publisher-ads.mjs's PER_RUN_CAP.
 * The workflow can fire many times an hour when several crawler groups land;
 * this bounds a pathological run (a crawler re-keying its whole slice so every
 * job looks first-seen) before it eats the shared cascade quota the digest and
 * the newsletter also draw on.
 *
 * THE UNIT CHANGED, THE NUMBER DID NOT. Before grouping, one email was one
 * alert, so "300 emails" and "300 alerts" were the same sentence and the cap
 * silently metered two different things at once. Now one email is one
 * recipient, and 300 means 300 messages — which is the unit the quota it
 * protects is actually denominated in, so the cap got MORE accurate, not less.
 *
 * The side effect is that a capped run now covers more alerts than before (up
 * to COMPANY_ALERT_MAX_TOTAL_CARDS sections each) for the same 300 messages.
 * That is the point of the change; it is not a loosening, because the ESP
 * charges and rate-limits per message, not per alert.
 */
export const PER_RUN_CAP = 300;

/**
 * Chunk size for per-recipient Firestore transactions.
 *
 * The sender reads and updates all alert refs in one transaction per chunk.
 * A chunk stays below the Firestore operation ceiling even when each recipient
 * carries the maximum number of employer sections, using the same arithmetic
 * that bounded the old post-send batch writeback.
 *
 * Per-recipient batching is not an optimisation, it is atomicity: all of one
 * email's alerts land in ONE transaction, so a chunk boundary cannot publish
 * half of a durable deferred decision or half of a delivery finalisation.
 *
 * Exported so tests/company-alert.test.ts can assert the invariant
 * (`DEDUP_CHUNK_SIZE × COMPANY_ALERT_MAX_TOTAL_CARDS ≤ FIRESTORE_BATCH_SIZE`)
 * instead of restating the arithmetic as a source-scan.
 */
export const DEDUP_CHUNK_SIZE = Math.max(1, Math.floor(FIRESTORE_BATCH_SIZE / COMPANY_ALERT_MAX_TOTAL_CARDS));

const TARGET_EMAIL_RAW = (process.env.TARGET_EMAIL || '').trim().toLowerCase();
const ALLOWED_EMAILS = TARGET_EMAIL_RAW ? new Set([TARGET_EMAIL_RAW]) : null;

let _db = null;

/** Test seam: inject a fake Firestore (mirrors send-job-alerts.mjs). */
export function __setFirestoreAdminForTest(fakeDb) {
  _db = fakeDb;
}

async function getFirestoreAdmin() {
  if (_db) return _db;
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (getApps().length === 0) {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath || !fs.existsSync(credPath)) {
      throw new Error('GOOGLE_APPLICATION_CREDENTIALS not set or file missing');
    }
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    initializeApp({ credential: cert(cred), projectId: cred.project_id });
  }
  _db = getFirestore();
  return _db;
}

function toMillis(v) {
  if (!v) return 0;
  if (typeof v === 'object' && typeof v.toMillis === 'function') return v.toMillis();
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * True only for an offer that can still be presented as open.
 *
 * The novelty window is not an availability check: a crawler can emit a fresh
 * firstSeenAt marker for an offer already closed or expired. Keeping this
 * guard at the sender boundary protects both the selection and the email
 * builder, including callers that hand `buildRecipientSections` a raw fixture.
 *
 * @param {object|null|undefined} job
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isOpenCompanyAlertJob(job, nowMs) {
  if (!job || typeof job !== 'object') return false;
  if (job.active === false) return false;
  const status = String(job.status || '').trim().toLowerCase();
  if (CLOSED_JOB_STATUSES.has(status)) return false;
  for (const field of ['expiredAt', 'expiresAt', 'validThrough']) {
    const expiry = toMillis(job[field]);
    if (expiry > 0 && expiry <= nowMs) return false;
  }
  return true;
}

/**
 * Jobs first seen inside the novelty window.
 * @param {object[]} jobs
 * @param {number} nowMs
 * @param {number} [windowMs]
 * @returns {object[]}
 */
export function selectNewlyPublishedJobs(jobs, nowMs, windowMs = IMMEDIATE_WINDOW_MS) {
  const cutoff = nowMs - windowMs;
  return (jobs || []).filter((j) => {
    const seen = toMillis(j?.firstSeenAt);
    return seen > 0 && seen >= cutoff && isOpenCompanyAlertJob(j, nowMs);
  });
}

/**
 * Display name for a followed employer.
 *
 * The alert persists only the canonical slug, so de-slug from a job the
 * employer just posted (authoritative, correctly cased) and fall back to a
 * title-cased slug when the field is missing.
 *
 * @param {object} alert
 * @param {object[]} jobs
 * @returns {string}
 */
function companyDisplayName(alert, jobs) {
  return String(jobs?.[0]?.company || '').trim()
    || String(alert?.specificCompanyKey || '')
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
}

/**
 * Bucket the run's alerts by recipient address — the unit of ONE email.
 *
 * Keyed on the lowercased/trimmed address because every other writer of
 * `job_alert_subscribers/{email}` keys it that way; a mixed-case duplicate here
 * would split one person into two inboxes and undo the grouping silently.
 * Alerts with no address are dropped rather than bucketed under '' — there is
 * nowhere to send them and an empty key would collapse unrelated alerts into
 * one nonsensical email.
 *
 * Pure — no IO — so tests/company-alert.test.ts can assert the grouping without
 * Firestore.
 *
 * @param {object[]} alerts
 * @returns {Map<string, object[]>}
 */
export function groupAlertsByRecipient(alerts) {
  const byRecipient = new Map();
  for (const alert of alerts || []) {
    const key = String(alert?.email || '').toLowerCase().trim();
    if (!key) continue;
    if (!byRecipient.has(key)) byRecipient.set(key, []);
    byRecipient.get(key).push(alert);
  }
  return byRecipient;
}

/**
 * Put recipients with durable deferred work ahead of fresh-only recipients.
 *
 * The order is deterministic after the backlog bit, so the per-run cap cannot
 * starve the same address just because new work keeps arriving in front of it.
 * @param {Map<string, object[]>} alertsByRecipient
 * @returns {string[]}
 */
export function sortCompanyAlertRecipients(alertsByRecipient) {
  const map = alertsByRecipient instanceof Map ? alertsByRecipient : new Map();
  return [...map.keys()].sort((a, b) => {
    const aDeferred = hasDeferredCompanyAlertWork(map.get(a)) ? 1 : 0;
    const bDeferred = hasDeferredCompanyAlertWork(map.get(b)) ? 1 : 0;
    return (bDeferred - aDeferred) || a.localeCompare(b);
  });
}

/**
 * Decide whether both consent containers prove that an immediate email is
 * allowed. The caller passes Firestore-like projections (`{exists, data}`), so
 * a missing row is distinguishable from a known suppression.
 *
 * `pending`, an unrecognised status, a false activity flag on a confirmed
 * newsletter record, and any absent container are all UNKNOWN. They are not a
 * reason to guess that the recipient opted in: the sender defers and the next
 * run can retry the lookup.
 *
 * @param {{exists?: boolean, data?: object}|null|undefined} newsletterDoc
 * @param {{exists?: boolean, data?: object}|null|undefined} jobAlertDoc
 * @returns {{action: 'send'|'suppress'|'defer', reason: string}}
 */
export function classifyRecipientConsent(newsletterDoc, jobAlertDoc) {
  if (!newsletterDoc?.exists || !jobAlertDoc?.exists) {
    return { action: 'defer', reason: 'consent-document-missing' };
  }
  const newsletter = typeof newsletterDoc.data === 'object' && newsletterDoc.data
    ? newsletterDoc.data
    : null;
  const jobAlert = typeof jobAlertDoc.data === 'object' && jobAlertDoc.data
    ? jobAlertDoc.data
    : null;
  if (!newsletter || !jobAlert) return { action: 'defer', reason: 'consent-document-malformed' };

  if (isCrossChannelStop(newsletter)) {
    return { action: 'suppress', reason: 'newsletter-cross-channel-stop' };
  }
  if (isJobAlertExcluded(jobAlert.status)) {
    return { action: 'suppress', reason: 'job-alert-status-excluded' };
  }
  if (jobAlert.active === false) {
    return { action: 'suppress', reason: 'job-alert-subscriber-inactive' };
  }

  const newsletterStatus = String(newsletter.status || '').trim().toLowerCase();
  const knownNonSendableReason = Object.hasOwn(
    NEWSLETTER_NON_SENDABLE_STATUS_REASONS,
    newsletterStatus,
  )
    ? NEWSLETTER_NON_SENDABLE_STATUS_REASONS[newsletterStatus]
    : null;
  if (knownNonSendableReason) {
    return { action: 'defer', reason: knownNonSendableReason };
  }
  if (newsletterStatus !== NEWSLETTER_SENDABLE_STATUS) {
    return { action: 'defer', reason: 'newsletter-consent-status-unknown' };
  }
  if (newsletter.isActive === false || newsletter.active === false) {
    return { action: 'defer', reason: 'newsletter-consent-activity-unknown' };
  }

  const jobAlertStatus = String(jobAlert.status || '').trim().toLowerCase();
  if (jobAlertStatus !== JOB_ALERT_SENDABLE_STATUS) {
    return { action: 'defer', reason: 'job-alert-consent-status-unknown' };
  }
  return { action: 'send', reason: 'consent-known-ok' };
}

/**
 * Whether a recipient has durable backlog entries that should be scheduled
 * before fresh work. This is the fairness key for the per-run cap.
 * @param {object[]|null|undefined} alerts
 * @returns {boolean}
 */
export function hasDeferredCompanyAlertWork(alerts) {
  return (alerts || []).some((alert) => {
    const ledger = normalizeDeliveryLedger(alert?.deliveryLedger);
    if (isDeferredExhausted(alert)) return false;
    return Object.values(ledger).some((entry) => entry.state === DELIVERY_STATES.DEFERRED);
  });
}

function deferredStateForAlert(alert) {
  return String(alert?.deliveryDeferredState || '').trim().toLowerCase();
}

function deferredAttemptsForAlert(alert) {
  const storedAttempts = Number(alert?.deliveryDeferredAttempts);
  return Number.isInteger(storedAttempts) && storedAttempts > 0 ? storedAttempts : 0;
}

function isDeferredExhausted(alert) {
  return deferredStateForAlert(alert) === DELIVERY_STATES.DEFERRED_EXHAUSTED
    || deferredAttemptsForAlert(alert) >= DEFERRED_MAX_ATTEMPTS;
}

function isThroughputDeferReason(reason) {
  return reason === 'per-run-cap' || reason === 'card-cap';
}

function candidateJobsForAlert(alert, newJobs, allJobs = newJobs) {
  const byKey = new Map();
  const withoutKey = [];
  const add = (job) => {
    const key = jobDedupKey(job);
    if (!key) {
      withoutKey.push(job);
      return;
    }
    if (!byKey.has(key)) byKey.set(key, job);
  };
  for (const job of newJobs || []) add(job);

  const ledger = normalizeDeliveryLedger(alert?.deliveryLedger);
  const alertDeferredExhausted = isDeferredExhausted(alert);
  const deferredKeys = alertDeferredExhausted
    ? new Set()
    : new Set(Object.entries(ledger)
      .filter(([, entry]) => entry.state === DELIVERY_STATES.DEFERRED)
      .map(([key]) => key));
  if (deferredKeys.size > 0) {
    for (const job of allJobs || []) {
      if (deferredKeys.has(jobDedupKey(job))) add(job);
    }
  }
  return [...byKey.values(), ...withoutKey];
}

/**
 * Return the job rows whose company identity cannot be resolved for a
 * company-pinned alert. The sender records the reason instead of allowing a
 * display-name guess to enter the email.
 *
 * @param {object} alert
 * @param {object[]} jobs
 * @returns {Array<{job: object, reason: string}>}
 */
export function companyAlertJobQuarantines(alert, jobs) {
  const profile = buildAlertProfile(alert, null, {});
  return (jobs || [])
    .map((job) => ({
      job,
      reason: jobCompanyIdentityQuarantineReason(job, profile) || jobIdentityQuarantineReason(job),
    }))
    .filter((item) => item.reason);
}

/**
 * Turn ONE recipient's alerts into the ranked employer sections their email
 * will carry — matching, per-alert dedup and ordering, and nothing else.
 *
 * Each returned section keeps its own `alert`, `sentMap` and job list: the
 * dedup record is per alert and stays per alert, because "already sent" is a
 * property of the subscription, not of the message that happened to carry it.
 * An alert with no unsent match yields NO section, so it is never marked, never
 * counted and never named in the subject.
 *
 * Ranking: freshest job first (that employer headlines the subject line), ties
 * broken by company name so a run is reproducible — a retry after a failed send
 * must compose the identical email, or the card budget would cut somewhere else
 * and mail a different set of jobs.
 *
 * Pure: no Firestore, no clock beyond `nowMs`.
 *
 * @param {object[]} alerts   One recipient's immediate CompanyAlerts.
 * @param {object[]} newJobs  Jobs first seen inside the novelty window.
 * @param {number} nowMs
 * @param {number} [dedupWindowMs]
 * @param {object[]} [allJobs=newJobs] Full dataset used to recover durable cap backlog.
 * @returns {Array<{alert: object, locale: string, sentMap: object, jobs: object[], companyName: string, freshestMs: number}>}
 */
export function buildRecipientSections(
  alerts,
  newJobs,
  nowMs,
  dedupWindowMs = DEDUP_WINDOW_MS,
  allJobs = newJobs,
) {
  const sections = [];
  for (const alert of alerts || []) {
    // A truthy but unresolvable pin (for example `??`) is not a broad alert.
    // Keep it out of the matcher and let the caller persist/log the explicit
    // quarantine reason.
    if (companyAlertQuarantineReason(alert)) continue;
    const locale = nlNormLocale(alert.locale);
    // The SAME matcher the digest uses. `scoreJobForAlert` treats
    // specificCompanyKey as a hard filter that folds brand aliases on both
    // sides (#5151) — re-implementing "job belongs to this employer" here
    // would be the fifth copy of the normalisation that PR spent its review
    // deleting.
    const profile = buildAlertProfile(alert, null, {});
    const matched = candidateJobsForAlert(alert, newJobs, allJobs)
      .filter((job) => isOpenCompanyAlertJob(job, nowMs))
      .filter((job) => !jobCompanyIdentityQuarantineReason(job, profile))
      .filter((job) => scoreJobForAlert(job, profile, locale) > 0);
    if (matched.length === 0) continue;

    const sentMap = normalizeSentMap(alert.sentJobIds);
    const unsent = filterUnsentJobs(
      matched,
      sentMap,
      nowMs,
      dedupWindowMs,
      alert.deliveryLedger,
      true,
    )
      .sort((a, b) => toMillis(b.firstSeenAt) - toMillis(a.firstSeenAt));
    if (unsent.length === 0) continue;

    sections.push({
      alert,
      locale,
      sentMap,
      jobs: unsent,
      companyName: companyDisplayName(alert, unsent),
      freshestMs: toMillis(unsent[0]?.firstSeenAt),
    });
  }
  sections.sort((a, b) => (b.freshestMs - a.freshestMs) || a.companyName.localeCompare(b.companyName));
  return sections;
}

/**
 * Build a durable backlog write for one deferred alert.
 *
 * The job key is stored, not the rendered email: the next run rehydrates the
 * same job from the full dataset and re-runs the open/matching guards. The
 * Consent/suppression deferrals count at alert level, because they can happen
 * with no current job key (or with a different job key on each run). The
 * throughput reasons (`per-run-cap` and `card-cap`) remain per-job: they are
 * allocator outcomes, not another attempt to resolve consent.
 *
 * @param {object[]} sections
 * @param {number} nowMs
 * @param {string} reason
 * @returns {Array<{ref: object, deliveryLedger: object, deliveryDeferredAttempts: number, deliveryDeferredState: string, reason: string, at: number}>}
 */
export function planDeferredDeliveryWrites(sections, nowMs, reason) {
  const normalizedReason = String(reason || '').trim() || 'deferred';
  const alertLevel = !isThroughputDeferReason(normalizedReason);
  return (sections || [])
    .filter((section) => section?.alert?.ref)
    .map((section) => {
      let deliveryLedger = normalizeDeliveryLedger(section.alert.deliveryLedger);
      if (!alertLevel) {
        for (const job of section.jobs || []) {
          const key = jobDedupKey(job);
          if (!key) continue;
          const previous = deliveryLedger[key];
          if (previous?.state === DELIVERY_STATES.DEFERRED_EXHAUSTED) continue;
          const attempts = previous?.state === DELIVERY_STATES.DEFERRED
            ? (Number(previous.attempts) || 0) + 1
            : 1;
          const state = attempts >= DEFERRED_MAX_ATTEMPTS
            ? DELIVERY_STATES.DEFERRED_EXHAUSTED
            : DELIVERY_STATES.DEFERRED;
          deliveryLedger = mergeDeliveryLedger(
            deliveryLedger,
            [job],
            nowMs,
            state,
            { reason: normalizedReason, attempts },
          );
        }
        return {
          ref: section.alert.ref,
          deliveryLedger,
          reason: normalizedReason,
          at: nowMs,
        };
      }

      const previousAttempts = deferredAttemptsForAlert(section.alert);
      const alreadyExhausted = isDeferredExhausted(section.alert);
      const attempts = alreadyExhausted
        ? Math.max(previousAttempts, DEFERRED_MAX_ATTEMPTS)
        : previousAttempts + 1;
      const state = alreadyExhausted || attempts >= DEFERRED_MAX_ATTEMPTS
        ? DELIVERY_STATES.DEFERRED_EXHAUSTED
        : DELIVERY_STATES.DEFERRED;

      // Do not promote older ledger entries here. Their per-job state may have
      // come from the pre-alert-level schema or from a different deferral
      // reason; the alert-level terminal state blocks their rehydration without
      // rewriting unrelated evidence.
      for (const job of section.jobs || []) {
        const key = jobDedupKey(job);
        if (!key) continue;
        const previous = deliveryLedger[key];
        if (previous?.state === DELIVERY_STATES.DEFERRED_EXHAUSTED) continue;
        deliveryLedger = mergeDeliveryLedger(
          deliveryLedger,
          [job],
          nowMs,
          state,
          { reason: normalizedReason, attempts },
        );
      }
      return {
        ref: section.alert.ref,
        deliveryLedger,
        deliveryDeferredAttempts: attempts,
        deliveryDeferredState: state,
        reason: normalizedReason,
        at: nowMs,
      };
    });
}

function coalesceDeliveryWrites(writes) {
  const byRef = new Map();
  for (const write of writes || []) {
    if (!write?.ref) continue;
    const key = write.ref.path || write.ref.id || write.ref;
    const prior = byRef.get(key);
    if (!prior) {
      byRef.set(key, {
        ...write,
        deliveryLedger: { ...write.deliveryLedger },
      });
      continue;
    }
    prior.deliveryLedger = { ...prior.deliveryLedger, ...write.deliveryLedger };
    const writeAttempts = deferredAttemptsForAlert(write);
    if (writeAttempts > 0) {
      prior.deliveryDeferredAttempts = Math.max(
        deferredAttemptsForAlert(prior),
        writeAttempts,
      );
      const priorState = deferredStateForAlert(prior);
      const writeState = deferredStateForAlert(write);
      prior.deliveryDeferredState = priorState === DELIVERY_STATES.DEFERRED_EXHAUSTED
        || writeState === DELIVERY_STATES.DEFERRED_EXHAUSTED
        ? DELIVERY_STATES.DEFERRED_EXHAUSTED
        : (writeState || priorState);
    }
    prior.reason = write.reason || prior.reason;
    prior.at = Math.max(prior.at || 0, write.at || 0);
  }
  return [...byRef.values()];
}

/**
 * Persist deferred work without claiming it as delivered.
 *
 * Consent lookup failures happen before the recipient loop, while cap/card
 * deferrals happen inside it. Keeping this write path shared makes both
 * classes observable and recoverable without ever touching `sentJobIds`.
 *
 * @param {object} db
 * @param {object[]} writes
 * @param {boolean} dryRun
 * @returns {Promise<number>}
 */
async function persistDeferredDeliveryWrites(db, writes, dryRun) {
  const coalesced = coalesceDeliveryWrites(writes);
  if (coalesced.length === 0) return 0;
  if (dryRun) {
    console.log(`   🔵 DRY RUN — ${coalesced.length} alert backlog write(s) would be persisted`);
    return coalesced.length;
  }
  if (!db || typeof db.runTransaction !== 'function') {
    throw new Error('Firestore transaction support is required for CompanyAlert backlog persistence');
  }
  for (let start = 0; start < coalesced.length; start += DEDUP_CHUNK_SIZE) {
    const chunk = coalesced.slice(start, start + DEDUP_CHUNK_SIZE);
    await db.runTransaction(async (tx) => {
      const snapshots = [];
      for (const write of chunk) snapshots.push(await tx.get(write.ref));
      for (let index = 0; index < chunk.length; index += 1) {
        const write = chunk[index];
        const snapshot = snapshots[index];
        if (!snapshot?.exists) continue;
        const currentData = snapshot.data() || {};
        const current = normalizeDeliveryLedger(currentData.deliveryLedger);
        const hasAlertLevelAttempt = deferredAttemptsForAlert(write) > 0;
        const currentExhausted = isDeferredExhausted(currentData);
        const desired = normalizeDeliveryLedger(write.deliveryLedger);
        const next = { ...current };
        for (const [key, entry] of Object.entries(desired)) {
          if (currentExhausted && entry.state === DELIVERY_STATES.DEFERRED) continue;
          // A concurrent sender may have claimed or marked the same job after
          // this plan was built. Never let a stale deferred write downgrade a
          // retry-blocking state and reopen a duplicate-send race.
          if (deliveryEntryBlocksRetry(current[key], write.at)) continue;
          next[key] = entry;
        }
        const update = {
          deliveryLedger: next,
          deliveryLastDeferredReason: write.reason,
          deliveryLastDeferredAt: write.at,
        };
        if (hasAlertLevelAttempt) {
          // This callback runs inside Firestore's transaction. If another run
          // commits first, Firestore retries the callback with its new
          // deliveryDeferredAttempts, so concurrent deferrals cannot both
          // commit the same alert-level value.
          const priorAttempts = deferredAttemptsForAlert(currentData);
          const plannedAttempts = deferredAttemptsForAlert(write);
          const deferredAttempts = currentExhausted
            ? Math.max(priorAttempts, DEFERRED_MAX_ATTEMPTS)
            : Math.max(priorAttempts + 1, plannedAttempts);
          update.deliveryDeferredAttempts = deferredAttempts;
          update.deliveryDeferredState = deferredAttempts >= DEFERRED_MAX_ATTEMPTS
            ? DELIVERY_STATES.DEFERRED_EXHAUSTED
            : DELIVERY_STATES.DEFERRED;
        }
        tx.update(write.ref, update);
      }
    });
  }
  console.log(`   📥 Deferred backlog persisted: ${coalesced.length} alert(s)`);
  return coalesced.length;
}

/**
 * Atomically reserve one recipient's sections before the provider call.
 *
 * Firestore retries this transaction when two workflow runs read the same
 * alert version. The winner writes `claimed`; the loser re-reads that state
 * and receives no sections, so concurrency cannot create two provider calls
 * for the same alert/job pair.
 *
 * @param {object} db
 * @param {object[]} sections
 * @param {number} nowMs
 * @param {string} claimId
 * @returns {Promise<object[]>}
 */
export async function claimRecipientSections(db, sections, nowMs, claimId) {
  const claimable = (sections || []).filter((section) => section?.alert?.ref);
  if (claimable.length === 0) return [];
  if (!db || typeof db.runTransaction !== 'function') {
    throw new Error('Firestore transaction support is required before sending CompanyAlerts');
  }
  const safeClaimId = String(claimId || `company-alert-${nowMs}`).slice(0, 120);
  return db.runTransaction(async (tx) => {
    const snapshots = [];
    for (const section of claimable) snapshots.push(await tx.get(section.alert.ref));
    // Re-run every mutable guard on the same transaction snapshot before the
    // allocator. If another sender accepted one card, allocating from the
    // stale pre-transaction list could claim a different set from the one the
    // builder will render and leave those cards with no deferred record.
    const freshCandidates = [];
    for (let index = 0; index < claimable.length; index += 1) {
      const section = claimable[index];
      const snapshot = snapshots[index];
      if (!snapshot?.exists) continue;
      const freshAlert = snapshot.data() || {};
      if (!isImmediateCompanyAlert(freshAlert) || companyAlertQuarantineReason(freshAlert)) continue;
      const sentMap = normalizeSentMap(freshAlert.sentJobIds);
      const ledger = normalizeDeliveryLedger(freshAlert.deliveryLedger);
      const freshProfile = buildAlertProfile(freshAlert, null, {});
      const freshMatchedJobs = section.jobs
        .filter((job) => isOpenCompanyAlertJob(job, nowMs))
        .filter((job) => !jobCompanyIdentityQuarantineReason(job, freshProfile))
        .filter((job) => scoreJobForAlert(job, freshProfile, nlNormLocale(freshAlert.locale)) > 0);
      const unsent = filterUnsentJobs(
        freshMatchedJobs,
        sentMap,
        nowMs,
        DEDUP_WINDOW_MS,
        ledger,
        true,
      );
      if (unsent.length === 0) continue;
      freshCandidates.push({
        ...section,
        alert: { ...section.alert, ...freshAlert, ref: section.alert.ref },
        sentMap,
        deliveryLedger: ledger,
        jobs: unsent,
        locale: nlNormLocale(freshAlert.locale),
        companyName: companyDisplayName(freshAlert, unsent),
        freshestMs: toMillis(unsent[0]?.firstSeenAt),
      });
    }

    // Claim only jobs the email builder can render. Jobs outside the per-section
    // or total card budget stay unclaimed and remain eligible for the next run.
    const renderableSections = allocateCompanyAlertCards(freshCandidates);
    const claimed = [];
    for (const renderableSection of renderableSections) {
      const section = freshCandidates.find((candidate) => candidate.alert.id === renderableSection.alert.id);
      if (!section || renderableSection.jobs.length === 0) continue;
      const nextLedger = mergeDeliveryLedger(
        section.deliveryLedger,
        renderableSection.jobs,
        nowMs,
        DELIVERY_STATES.CLAIMED,
        { claimId: safeClaimId },
      );
      tx.update(section.alert.ref, {
        deliveryLedger: nextLedger,
        deliveryLastClaimedAt: nowMs,
      });
      claimed.push({
        ...section,
        alert: { ...section.alert, deliveryLedger: nextLedger },
        deliveryLedger: nextLedger,
        jobs: renderableSection.jobs,
      });
    }
    claimed.sort((a, b) => (b.freshestMs - a.freshestMs) || a.companyName.localeCompare(b.companyName));
    return claimed;
  });
}

/**
 * Move a recipient's rendered jobs from a short-lived pre-provider claim to a
 * durable ambiguous attempt marker. This transaction is deliberately all or
 * nothing: no provider call is allowed for an email whose complete rendered
 * set is not marked first.
 *
 * `claimed` is reclaimable after CLAIM_TTL_MS; `ambiguous` is not. Therefore a
 * worker dying before this function runs can recover, while a worker dying
 * after it runs cannot silently resend a message that the provider may have
 * accepted. Reconciliation can later resolve the ambiguous entry.
 *
 * @param {object} db
 * @param {object[]} dedupWrites
 * @param {number} nowMs
 * @param {string} claimId
 * @returns {Promise<number>} number of alert documents marked
 */
export async function markRecipientDeliveryAttempted(db, dedupWrites, nowMs, claimId) {
  const writes = (dedupWrites || []).filter((write) => write?.ref && (write.sentJobs || []).length > 0);
  if (writes.length === 0) return 0;
  if (!db || typeof db.runTransaction !== 'function') {
    throw new Error('Firestore transaction support is required before CompanyAlert provider attempt');
  }
  const safeClaimId = String(claimId || '').slice(0, 120);
  return db.runTransaction(async (tx) => {
    const snapshots = [];
    for (const write of writes) snapshots.push(await tx.get(write.ref));
    const rows = [];
    for (let index = 0; index < writes.length; index += 1) {
      const write = writes[index];
      const snapshot = snapshots[index];
      if (!snapshot?.exists) return 0;
      const current = normalizeDeliveryLedger(snapshot.data()?.deliveryLedger);
      const keys = (write.sentJobs || []).map(jobDedupKey).filter(Boolean);
      if (keys.length === 0 || keys.some((key) => {
        const entry = current[key];
        return entry?.state !== DELIVERY_STATES.CLAIMED
          || (safeClaimId && entry.claimId !== safeClaimId);
      })) return 0;
      rows.push({ write, current });
    }
    for (const { write, current } of rows) {
      const nextLedger = mergeDeliveryLedger(
        current,
        write.sentJobs,
        nowMs,
        DELIVERY_STATES.AMBIGUOUS,
        { reason: 'provider-attempt-unknown' },
      );
      tx.update(write.ref, {
        deliveryLedger: nextLedger,
        deliveryLastOutcome: 'ambiguous',
        deliveryLastOutcomeAt: nowMs,
        deliveryLastOutcomeReason: 'provider-attempt-unknown',
      });
    }
    return rows.length;
  });
}

/**
 * Pure writeback plan for one recipient/job outcome.
 *
 * `ambiguous` is kept in the delivery ledger and is never collapsed into the
 * successful `sentJobIds` view. A later retry consults the ledger and does not
 * blindly resend; a definite failure clears the claim so it is recoverable.
 */
export function planDeliveryWriteback(alertData, sentJobs, outcome, nowMs, provider = {}) {
  const data = alertData || {};
  const jobs = Array.isArray(sentJobs) ? sentJobs : [];
  const state = String(outcome || '').trim().toLowerCase();
  const base = {
    deliveryLedger: normalizeDeliveryLedger(data.deliveryLedger),
    deliveryLastOutcome: state,
    deliveryLastOutcomeAt: nowMs,
  };
  if (state === 'accepted') {
    return {
      ...base,
      sentJobIds: mergeSentJobs(normalizeSentMap(data.sentJobIds), jobs, nowMs, DEDUP_WINDOW_MS),
      deliveryLedger: removeDeliveryLedgerJobs(base.deliveryLedger, jobs),
      matchCountDelta: jobs.length,
      deliveryLastOutcomeReason: 'provider-acknowledged',
      resetDeferredAttemptState: Object.prototype.hasOwnProperty.call(data, 'deliveryDeferredAttempts')
        || Object.prototype.hasOwnProperty.call(data, 'deliveryDeferredState'),
    };
  }
  if (state === 'ambiguous') {
    return {
      ...base,
      deliveryLedger: mergeDeliveryLedger(
        base.deliveryLedger,
        jobs,
        nowMs,
        DELIVERY_STATES.AMBIGUOUS,
        {
          reason: provider.reason || 'provider-outcome-ambiguous',
          provider: provider.provider,
          messageId: provider.messageId,
        },
      ),
      // An ambiguous response is not proof of provider acceptance. Keep the
      // attempt visible in the ledger, but do not advance the delivered-match
      // counters or `lastMatchedAt` as if it were accepted.
      matchCountDelta: 0,
      deliveryLastOutcomeReason: provider.reason || 'provider-outcome-ambiguous',
    };
  }
  if (state === 'failed') {
    return {
      ...base,
      deliveryLedger: removeDeliveryLedgerJobs(base.deliveryLedger, jobs),
      deliveryLastOutcomeReason: provider.reason || 'provider-rejected',
      matchCountDelta: 0,
    };
  }
  throw new Error(`Unsupported CompanyAlert delivery outcome: ${outcome}`);
}

/**
 * Finalise a claimed recipient atomically across all rendered alert sections.
 * If this transaction fails, the pre-provider `ambiguous` ledger stays in
 * place and the next run cannot resend the accepted/unknown message as if it
 * were new.
 *
 * @param {object} db
 * @param {object[]} dedupWrites
 * @param {'accepted'|'ambiguous'|'failed'} outcome
 * @param {number} nowMs
 * @param {{provider?: string, messageId?: string, reason?: string}} [provider]
 * @param {{serverTimestamp?: () => unknown, increment?: (n: number) => unknown}} [fieldValues]
 */
export async function finalizeRecipientDelivery(
  db,
  dedupWrites,
  outcome,
  nowMs,
  provider = {},
  fieldValues = {},
) {
  const writes = (dedupWrites || []).filter((write) => write?.ref && (write.sentJobs || []).length > 0);
  if (writes.length === 0) return 0;
  if (!db || typeof db.runTransaction !== 'function') {
    throw new Error('Firestore transaction support is required for CompanyAlert delivery finalization');
  }
  return db.runTransaction(async (tx) => {
    const snapshots = [];
    for (const write of writes) snapshots.push(await tx.get(write.ref));
    let updated = 0;
    for (let index = 0; index < writes.length; index += 1) {
      const write = writes[index];
      const snapshot = snapshots[index];
      if (!snapshot?.exists) continue;
      const data = snapshot.data() || {};
      const plan = planDeliveryWriteback(data, write.sentJobs, outcome, nowMs, provider);
      const update = {
        deliveryLedger: plan.deliveryLedger,
        deliveryLastOutcome: plan.deliveryLastOutcome,
        deliveryLastOutcomeAt: plan.deliveryLastOutcomeAt,
        deliveryLastOutcomeReason: plan.deliveryLastOutcomeReason,
      };
      if (plan.sentJobIds) update.sentJobIds = plan.sentJobIds;
      if (plan.resetDeferredAttemptState) {
        // A successful delivery is a new, consent-approved send boundary. Do
        // not carry a previous consent-defer terminal into the next alert.
        update.deliveryDeferredAttempts = 0;
        update.deliveryDeferredState = null;
      }
      if (plan.matchCountDelta > 0) {
        update.lastMatchedAt = typeof fieldValues.serverTimestamp === 'function'
          ? fieldValues.serverTimestamp()
          : nowMs;
        update.matchCount = typeof fieldValues.increment === 'function'
          ? fieldValues.increment(plan.matchCountDelta)
          : (Number(data.matchCount) || 0) + plan.matchCountDelta;
      }
      tx.update(write.ref, update);
      updated += 1;
    }
    return updated;
  });
}

const SYNTHETIC_PROVIDER_MESSAGE_ID = /^(?:mj|mg|mailtrap|maileroo|resend|cf)-\d+$/;

/**
 * A cascade `sent` item is accepted only when the provider returned both its
 * provider name and a non-generated message id. The low-level cascade still
 * has legacy fallbacks for HTTP 200 empty bodies; this sender boundary turns
 * those fallbacks into ambiguous, retry-blocking outcomes instead of claiming
 * that `{}` was an acceptance.
 */
export function hasExplicitProviderAcceptance(item) {
  const provider = String(item?.provider || '').trim();
  const messageId = String(item?.messageId || '').trim();
  return Boolean(provider && messageId && !SYNTHETIC_PROVIDER_MESSAGE_ID.test(messageId));
}

/**
 * Separate explicit acceptance, hard failure and ambiguous provider outcomes.
 * @param {{sent?: object[], failed?: object[]}|null|undefined} result
 * @returns {{sent: object[], failed: object[]}}
 */
export function classifyProviderOutcomes(result) {
  const sent = [];
  const failed = [...(result?.failed || [])];
  for (const item of result?.sent || []) {
    if (hasExplicitProviderAcceptance(item)) {
      sent.push(item);
    } else {
      failed.push({
        ...item,
        error: 'provider acknowledgement missing',
        ambiguousDelivery: true,
        providerAcknowledgementMissing: true,
      });
    }
  }
  return { sent, failed };
}

/**
 * Map the normalized cascade result back to one recipient's durable outcome.
 * @param {object} email
 * @param {{sent?: object[], failed?: object[]}} result
 * @returns {{outcome: 'accepted'|'ambiguous'|'failed', provider?: string, messageId?: string, reason?: string}}
 */
export function deliveryOutcomeForEmail(email, result) {
  const recipient = String(email?.to || '').toLowerCase().trim();
  const failed = (result?.failed || []).find((item) => String(item?.recipient?.email || item?.to || '').toLowerCase().trim() === recipient);
  if (failed) {
    return {
      outcome: failed.ambiguousDelivery ? 'ambiguous' : 'failed',
      provider: failed.provider,
      messageId: failed.messageId,
      reason: failed.ambiguousDelivery ? 'provider-outcome-ambiguous' : 'provider-rejected',
    };
  }
  const sent = (result?.sent || []).find((item) => String(item?.recipient?.email || item?.to || '').toLowerCase().trim() === recipient);
  if (sent) return { outcome: 'accepted', provider: sent.provider, messageId: sent.messageId, reason: 'provider-acknowledged' };
  return { outcome: 'ambiguous', reason: 'cascade-outcome-missing' };
}

/**
 * The URL the RFC 8058 `List-Unsubscribe` header must carry.
 *
 * ONE section → the per-alert link, exactly as before grouping: unfollowing
 * that employer IS "stop sending me this", and it is the narrowest action that
 * honours the click (it leaves the reader's keyword alerts alone).
 *
 * SEVERAL sections → the all-alerts link. One-click has to stop the message the
 * reader is looking at, and unfollowing an arbitrary one of six employers would
 * not: the next run mails them again, the Unsubscribe button looks broken, and
 * that is how a mailbox provider learns to file this sender under spam. There
 * is no "stop all company follows" token — the two HMAC shapes in
 * scripts/lib/job-alert-unsub-urls.mjs are per-alert and all-alerts — so
 * all-alerts is the honest reading, and the body keeps the per-employer link
 * inside every section for the reader who wants the narrower thing.
 *
 * Both URLs stay pure HMAC and work with no session; whichever this returns is
 * also rendered in the body, which tests/company-alert.test.ts pins.
 *
 * @param {Array<{unsubscribeUrl?: string, [key: string]: unknown}>} renderedSections Sections the email ACTUALLY rendered.
 * @param {string} unsubscribeAllUrl
 * @returns {string}
 */
export function pickOneClickUnsubscribeUrl(renderedSections, unsubscribeAllUrl) {
  const sections = renderedSections || [];
  return sections.length === 1 && sections[0]?.unsubscribeUrl
    ? sections[0].unsubscribeUrl
    : unsubscribeAllUrl;
}

/**
 * Which sends may write their dedup records back.
 *
 * A failed send must NOT mark its jobs as sent: the next run would skip them
 * and the reader never hears about the job at all — a permanent, invisible
 * loss. Grouping makes that check per RECIPIENT, which is now exactly the unit
 * of one message: either the whole email went out, or none of its employers
 * count as delivered.
 *
 * `ambiguousDelivery` (#4911) is NOT an accepted `sentJobIds` outcome. The
 * provider may already have accepted the message, so re-sending it would risk
 * a duplicate; the durable delivery ledger records `ambiguous` and blocks a
 * blind retry. Keeping it out of `sentJobIds` preserves the distinction between
 * accepted, failed and unknown outcomes for later reconciliation.
 *
 * Pure — no IO.
 *
 * @param {object[]} emails      What was handed to the cascade (`to` per item).
 * @param {object[]} failedItems `result.failed` from sendEmailCascade.
 * @returns {object[]} the subset whose `sentJobIds` may be persisted.
 */
export function selectPersistableSends(emails, failedItems) {
  const blocked = new Set(
    (failedItems || [])
      .map((f) => String(f?.recipient?.email || f?.to || '').toLowerCase().trim())
      .filter(Boolean),
  );
  return (emails || []).filter((e) => e && !blocked.has(String(e.to || '').toLowerCase().trim()));
}

function loadJobs() {
  if (!fs.existsSync(JOBS_PATH)) {
    console.warn(`   ⚠️  ${JOBS_PATH} missing — run scripts/assemble-jobs-dataset.mjs first.`);
    return [];
  }
  const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf-8'));
  return Array.isArray(jobs) ? jobs : [];
}

function loadNewJobs(nowMs, allJobs = loadJobs()) {
  return selectNewlyPublishedJobs(allJobs, nowMs);
}

async function sendBatch(emails) {
  const { sendEmailCascade, logProviderSummary } = await import('./lib/email-cascade.mjs');
  const cascadeEmails = emails.map((e) => ({
    payload: {
      from: FROM_EMAIL,
      to: [e.to],
      subject: e.subject,
      html: e.html,
      text: e.text,
      tags: [
        // NAMED campaign_id (not just `type`): the Resend webhook
        // (functions/src/newsletterResendWebhookCore.js) reads `tags.campaign_id`
        // by name and has no positional fallback the way emailCascade.js's
        // campaignIdTag() does for Mailgun/Mailjet/Mailtrap (it defaults to
        // tags[0], which happened to be `type` here — that's the only reason
        // those providers were ever attributed correctly). Without this tag,
        // every company-alert event routed through Resend fell back to an
        // `unknown:<messageId>` campaign_id, unrecoverable by
        // report-email-engagement.mjs's classifyEmailType and permanently
        // counted as `unattributed` (2026-08-25 investigation). Same value as
        // COMPANY_ALERT_TEMPLATE_ID that campaignIdTag()'s fallback already
        // produced on the other providers, so this doesn't split the type into
        // two buckets — it makes Resend consistent with the rest.
        { name: 'campaign_id', value: COMPANY_ALERT_TEMPLATE_ID },
        // The template's identity in the only registry this repo has for one.
        { name: 'type', value: COMPANY_ALERT_TEMPLATE_ID },
        // The HEADLINE alert — the employer the subject names. A grouped send
        // covers several alerts and an ESP tag holds one value; picking the
        // headline keeps the tag meaning the same thing it always meant
        // ("which followed employer triggered this"), and `sections` below
        // carries the part the single id cannot.
        { name: 'alert_id', value: e.alertId },
        { name: 'sections', value: String(e.sectionCount) },
      ],
      headers: {
        'Feedback-ID': `${COMPANY_ALERT_TEMPLATE_ID}:${e.alertId}:frontaliere-ticino`,
        // RFC 8058 one-click unsubscribe, same contract as the digest — and the
        // SAME URL the body renders (per-alert for a 1-section email, all-alerts
        // for a grouped one; see where `unsubscribeUrl` is chosen below). A
        // header that unsubscribed from something the body never offered is an
        // unsubscribe the reader cannot verify.
        'List-Unsubscribe': `<${e.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    },
    recipient: { email: e.to },
    meta: { type: COMPANY_ALERT_TEMPLATE_ID, alertId: e.alertId },
  }));
  // No scheduledAt: "immediate" is the whole point — deferring to a preferred
  // send hour (what the digest does) would undo the feature.
  const result = await sendEmailCascade(cascadeEmails, { concurrency: 3 });
  logProviderSummary();
  return { ...result, ...classifyProviderOutcomes(result) };
}

/**
 * Load the alert docs this sender may own, narrowed server-side.
 *
 * `active` stays in the query and stays first: `frequency` alone is not
 * servable by the indexes that exist (measured 2026-08-24 —
 * FAILED_PRECONDITION). The fallback re-issues the digest's wide query if
 * Firestore ever refuses the narrowed one, so an index regression degrades
 * into a more expensive run rather than into unsent alerts.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @returns {Promise<FirebaseFirestore.QuerySnapshot>}
 */
async function loadImmediateAlertDocs(db) {
  const base = db.collectionGroup('alerts').where('active', '==', true);
  try {
    return await base.where('frequency', '==', IMMEDIATE_FREQUENCY).get();
  } catch (err) {
    // gRPC FAILED_PRECONDITION is 9; some firebase-admin versions surface the
    // string form instead, and the message wording is not something to rely on
    // alone. Any of the three is enough to prefer a costlier run over a
    // missed alert; anything else is a real error and must propagate.
    const msg = String(err?.message || '');
    if (!msg.includes('index') && err?.code !== 9 && err?.code !== 'failed-precondition') throw err;
    console.warn(`   \u26a0\ufe0f Narrowed alert query refused (${msg.slice(0, 120)}) — falling back to the wide scan.`);
    return base.get();
  }
}

async function main() {
  console.log('🏢 CompanyAlert — immediate sender');

  if (process.env.ENABLE_JOB_ALERTS !== 'true') {
    console.log('   ⏭️  ENABLE_JOB_ALERTS is not "true" — skipping (same master switch as the digest).');
    return;
  }

  const now = Date.now();
  const allJobs = loadJobs();
  const newJobs = loadNewJobs(now, allJobs);
  console.log(`   Newly published jobs in the last ${IMMEDIATE_WINDOW_MS / 3600000}h: ${newJobs.length}`);
  if (newJobs.length === 0) console.log('   No fresh jobs — checking durable deferred backlog.');

  const db = await getFirestoreAdmin();

  // Narrowed server-side on the cadence half of isImmediateCompanyAlert —
  // see the header note for the production measurement and the fallback.
  const snap = await loadImmediateAlertDocs(db);
  let alerts = snap.docs
    .filter((d) => d.ref.parent.parent?.parent?.id === 'job_alert_subscribers')
    .map((d) => {
      const data = d.data();
      const parentEmail = d.ref.parent.parent?.id || data.email;
      return { id: d.id, ref: d.ref, ...data, email: data.email || parentEmail };
    })
    .filter(isImmediateCompanyAlert);

  const quarantinedAlerts = alerts
    .map((alert) => ({ alert, reason: companyAlertQuarantineReason(alert) }))
    .filter((item) => item.reason);
  if (quarantinedAlerts.length > 0) {
    const reasons = [...new Set(quarantinedAlerts.map((item) => item.reason))].join(', ');
    console.warn(`   🧰 CompanyAlert quarantine: ${quarantinedAlerts.length} alert(s), reason(s): ${reasons}`);
    alerts = alerts.filter((alert) => !companyAlertQuarantineReason(alert));
  }

  // Do not let a malformed fresh job disappear inside the matcher. It is
  // excluded from matching, and the reason is emitted as a sanitised count so
  // operators can repair the source row without logging its identity or text.
  const quarantinedJobs = alerts.flatMap((alert) => companyAlertJobQuarantines(alert, newJobs));
  if (quarantinedJobs.length > 0) {
    const reasons = [...new Set(quarantinedJobs.map((item) => item.reason))].join(', ');
    console.warn(`   🧰 CompanyAlert job quarantine: ${quarantinedJobs.length} offer row(s), reason(s): ${reasons}`);
  }

  // #5684 — `paused` is the preference centre's pause button, orthogonal to
  // `active` (the soft-delete flag) per the #4298 follow-up. send-job-alerts.mjs
  // has filtered on it since then; this sender never did, so a reader who
  // paused a followed employer in the centre kept receiving that employer's
  // immediate alerts. The centre renders CompanyAlert rows (`companyLabel`,
  // `frequencyImmediate`) with the same pause control as any other alert, so
  // the control was visibly there and inert — the shape of defect that ends at
  // the provider's abuse desk rather than in a bug report.
  const beforePauseFilter = alerts.length;
  alerts = alerts.filter((a) => a.paused !== true);
  if (beforePauseFilter !== alerts.length) {
    console.log(`   ⏸️  Paused CompanyAlerts skipped: ${beforePauseFilter - alerts.length}`);
  }

  if (ALLOWED_EMAILS) {
    alerts = alerts.filter((a) => ALLOWED_EMAILS.has(String(a.email || '').toLowerCase()));
    console.log(`   ⚠️  TARGET_EMAIL active — ${alerts.length} alert(s) in scope`);
  }
  console.log(`   Immediate CompanyAlerts: ${alerts.length}`);
  if (alerts.length === 0) return;

  // Consent/suppression, from both documents. The newsletter side is
  // isCrossChannelStop: address-level hard signals plus the explicit newsletter
  // opt-out. A known-good state requires newsletter `confirmed` and job-alert
  // `active`; missing/pending/unknown is DEFERRED, never fail-open.
  const emailsInScope = [...new Set(alerts.map((a) => String(a.email || '').toLowerCase()))];
  const consentByEmail = new Map();
  const LOOKUP_CHUNK_SIZE = 200;
  for (let i = 0; i < emailsInScope.length; i += LOOKUP_CHUNK_SIZE) {
    const chunk = emailsInScope.slice(i, i + LOOKUP_CHUNK_SIZE);
    try {
      const refs = chunk.flatMap((e) => [
        db.collection('newsletter_subscribers').doc(e),
        db.collection('job_alert_subscribers').doc(e),
      ]);
      const snaps = await db.getAll(...refs);
      chunk.forEach((e, idx) => {
        const [nlDoc, jaDoc] = snaps.slice(idx * 2, idx * 2 + 2);
        consentByEmail.set(e, classifyRecipientConsent(
          nlDoc && { exists: nlDoc.exists, data: nlDoc.data() || {} },
          jaDoc && { exists: jaDoc.exists, data: jaDoc.data() || {} },
        ));
      });
    } catch (err) {
      // Fail-closed and observable: the next run retries the lookup, and no
      // recipient in a failed chunk reaches the provider by accident.
      for (const email of chunk) {
        consentByEmail.set(email, { action: 'defer', reason: 'suppression-lookup-failed' });
      }
      console.warn(`   ⚠️  suppression lookup failed for ${chunk.length} address(es) — deferred for retry (${String(err?.message || err).slice(0, 120)})`);
    }
  }
  const suppressionCounts = { suppress: 0, defer: 0 };
  const beforeConsentFilter = alerts.length;
  const deferredDeliveryWrites = [];
  const consentDeferredAlerts = [];
  alerts = alerts.filter((alert) => {
    const decision = consentByEmail.get(String(alert.email || '').toLowerCase())
      || { action: 'defer', reason: 'consent-decision-missing' };
    if (decision.action === 'suppress') suppressionCounts.suppress += 1;
    if (decision.action === 'defer') {
      suppressionCounts.defer += 1;
      consentDeferredAlerts.push({ alert, reason: decision.reason });
    }
    return decision.action === 'send';
  });
  if (suppressionCounts.suppress > 0) {
    console.log(`   🚫 Suppressed (known stop state): ${suppressionCounts.suppress} alert(s) skipped`);
  }
  if (suppressionCounts.defer > 0) {
    console.warn(`   ⏳ Consent/suppression unknown: ${suppressionCounts.defer} alert(s) deferred for recovery`);
  }
  for (const { alert, reason } of consentDeferredAlerts) {
    const sections = buildRecipientSections([alert], newJobs, now, DEDUP_WINDOW_MS, allJobs);
    deferredDeliveryWrites.push(...planDeferredDeliveryWrites(
      sections.length > 0 ? sections : [{ alert, jobs: [] }],
      now,
      reason,
    ));
  }
  if (beforeConsentFilter !== alerts.length && alerts.length === 0) {
    await persistDeferredDeliveryWrites(db, deferredDeliveryWrites, DRY_RUN);
    console.log('   No recipient has a verified sendable consent state — nothing to send.');
    return;
  }

  // ── ONE EMAIL PER RECIPIENT ──────────────────────────────────────────────
  // Sorted so the PER_RUN_CAP cut is deterministic: a run that hits the cap and
  // a retry of that run must defer the SAME addresses, or a recipient could sit
  // just past the boundary on every attempt and never be mailed at all.
  const alertsByRecipient = groupAlertsByRecipient(alerts);
  const recipients = sortCompanyAlertRecipients(alertsByRecipient);
  console.log(`   Recipients in scope: ${recipients.length} (from ${alerts.length} alert(s))`);

  const emailsToSend = [];
  const claimId = `company-alert-${now}-${process.pid || 'worker'}`;
  let capLogged = false;
  for (let i = 0; i < recipients.length; i += 1) {
    const recipient = recipients[i];
    const plannedSections = buildRecipientSections(alertsByRecipient.get(recipient), newJobs, now, DEDUP_WINDOW_MS, allJobs);
    if (plannedSections.length === 0) continue;
    if (plannedSections.some((section) => !section.alert?.ref)) {
      console.warn('   🧰 CompanyAlert quarantine: alert reference missing before send; recipient deferred');
      continue;
    }
    if (emailsToSend.length >= PER_RUN_CAP) {
      if (!capLogged) {
        console.log(`   📉 PER_RUN_CAP (${PER_RUN_CAP} recipients) reached — deferred recipients are persisted for the next run`);
        capLogged = true;
      }
      deferredDeliveryWrites.push(...planDeferredDeliveryWrites(plannedSections, now, 'per-run-cap'));
      continue;
    }
    // Record the candidate cards that the same allocator will omit before the
    // pre-send claim. They are intentionally not claimed, but they still need
    // a durable deferred key once the novelty window closes.
    const renderableSections = allocateCompanyAlertCards(plannedSections);
    const renderableKeysByAlert = new Map(
      renderableSections.map((section) => [
        section.alert.id,
        new Set((section.jobs || []).map(jobDedupKey).filter(Boolean)),
      ]),
    );
    const cardDeferredSections = plannedSections
      .map((section) => {
        const renderedKeys = renderableKeysByAlert.get(section.alert.id) || new Set();
        const omittedJobs = section.jobs.filter((job) => !renderedKeys.has(jobDedupKey(job)));
        return omittedJobs.length > 0 ? { ...section, jobs: omittedJobs } : null;
      })
      .filter(Boolean);
    deferredDeliveryWrites.push(...planDeferredDeliveryWrites(cardDeferredSections, now, 'card-cap'));

    let sections = plannedSections;
    if (!DRY_RUN) {
      sections = await claimRecipientSections(db, plannedSections, now, claimId);
    }
    if (sections.length === 0) continue;

    const headline = sections[0];
    // The headline alert's locale governs the WHOLE message. A recipient is one
    // person with one reading language; when their alerts disagree (possible —
    // the locale is stamped per alert at creation) rendering half the sections
    // in German would be worse than picking the language of the employer whose
    // job triggered the send.
    const locale = headline.locale;
    const autologinCode = generateAutologinCode(recipient);
    // Two decorators, one perimeter (#5725). Both add the campaign parameters;
    // only `wrapJobUrl` can add the `ne`/`ac` autologin pair, and only because
    // it says why. The shared builder is fail-closed: anything it does not
    // recognise as a session-gated destination comes back with utm_* and no
    // credential, so `wrapUrl` needs no argument to be safe — it is safe by
    // default, which is the change.
    const wrapUrl = (raw) => makeAuthenticatedUrl(raw, recipient, {
      autologinCode,
      utmMedium: 'email',
      preserveExistingUtmMedium: true,
    });
    // A job DETAIL page is not public: components/community/JobBoard.tsx swaps
    // the listing for the sign-in gate when `hasAccess` is false. The company
    // HUB above is, and loses the credential.
    const wrapJobUrl = (raw) => makeAuthenticatedUrl(raw, recipient, {
      autologinCode,
      utmMedium: 'email',
      preserveExistingUtmMedium: true,
      sessionGated:
        'job detail page — components/community/JobBoard.tsx renders the sign-in gate '
        + 'instead of the listing when hasAccess is false',
    });
    // «Gestisci le aziende seguite» → the page that actually manages them.
    //
    // It used to point at /preferenze-newsletter/ because that link is
    // token-HMAC and works with no session, while /aziende-seguite/ reads the
    // signed-in user. `wrapUrl` closes that gap: it appends the `ne`+`ac`
    // autologin pair, and App.tsx's autologin effect is route-independent — it
    // exchanges the code and signs the reader in wherever they land. So the deep
    // link arrives authenticated on the page that lists exactly what the email
    // is about.
    //
    // Since #5725 that no longer happens because `wrapUrl` decorates everything:
    // it happens because /aziende-seguite/ is IN the autologin allowlist
    // (`followed-companies` in functions/src/lib/newsletterUrls.js), for exactly
    // the reason this comment gives. The company hub and the job-board landing
    // are not, and they lose the credential.
    //
    // The preferences page stays reachable: the unsubscribe links below are
    // pure HMAC and never depend on a session, so a failed exchange still
    // leaves a working way out — which is the part that must never break.
    const manageUrl = wrapUrl(
      `${BASE_URL}${followedCompaniesPath(locale)}?utm_source=${COMPANY_ALERT_TEMPLATE_ID}&utm_campaign=alert_${headline.alert.id}`,
    );
    const unsubscribeAllUrl = makeAllAlertsUnsubscribeUrl(recipient);

    // The template is handed EVERY candidate section and hands back the ones it
    // rendered, already trimmed to the card budget. Reading the dedup set off
    // the return value rather than off this input is the whole guarantee that a
    // job cannot be marked sent without having been rendered.
    const built = buildCompanyAlertEmail({
      sections: sections.map((section) => ({
        alertId: section.alert.id,
        companyName: section.companyName,
        companySlug: String(section.alert.specificCompanyKey),
        jobs: section.jobs,
        // Per-section unsubscribe: pure HMAC, no session needed, one per alert.
        unsubscribeUrl: makeAlertUnsubscribeUrl(section.alert.id, recipient),
      })),
      email: recipient,
      locale,
      manageUrl,
      unsubscribeAllUrl,
      wrapUrl,
      wrapJobUrl,
      baseUrl: BASE_URL,
      now,
    });

    const rendered = built.sections;
    const byAlertId = new Map(sections.map((section) => [section.alert.id, section]));

    if (!rendered || rendered.length === 0) continue;

    // RFC 8058 one-click target — see pickOneClickUnsubscribeUrl. Derived from
    // the RENDERED sections, not the candidates: an email whose second section
    // was dropped by the card budget is a one-section email and must carry the
    // per-alert link, not the global one.
    const oneClickUnsubscribeUrl = pickOneClickUnsubscribeUrl(rendered, unsubscribeAllUrl);

    emailsToSend.push({
      to: recipient,
      alertId: headline.alert.id,
      sectionCount: rendered.length,
      subject: built.subject,
      html: built.html,
      text: built.text,
      unsubscribeUrl: oneClickUnsubscribeUrl,
      // One writeback per RENDERED section. A section the card budget dropped
      // has no entry here, so its jobs stay unsent and surface next run.
      dedupWrites: rendered
        .map((section) => {
          const source = byAlertId.get(section.alertId);
          return source?.alert?.ref
            ? { ref: source.alert.ref, sentMap: source.sentMap, sentJobs: section.jobs, matchCount: section.jobs.length }
            : null;
        })
        .filter(Boolean),
    });

    if (rendered.length < sections.length) {
      console.log(`   📦 ${recipient}: ${sections.length} employer(s) with new jobs, ${rendered.length} in this email — the rest roll into the next run`);
    }
  }

  await persistDeferredDeliveryWrites(db, deferredDeliveryWrites, DRY_RUN);

  if (emailsToSend.length === 0) {
    console.log('   No new jobs for any followed employer — nothing to send.');
    return;
  }

  const totalSections = emailsToSend.reduce((sum, e) => sum + e.sectionCount, 0);
  console.log(`   ✉️  ${emailsToSend.length} email(s) covering ${totalSections} followed employer(s)`);

  if (DRY_RUN) {
    console.log(`   🔵 DRY RUN — would send ${emailsToSend.length} email(s)`);
    for (const e of emailsToSend) console.log(`      → ${e.to} (${e.sectionCount} section(s)): ${e.subject}`);
    return;
  }

  // A claimed ledger entry is only a recoverable reservation. Before crossing
  // the provider boundary, atomically mark every rendered job in the email as
  // an ambiguous attempt. If the process dies after this point, a later run
  // must reconcile the provider result instead of blindly sending a duplicate.
  const attemptedEmails = [];
  for (const email of emailsToSend) {
    const marked = await markRecipientDeliveryAttempted(db, email.dedupWrites, now, claimId);
    if (marked !== email.dedupWrites.length) {
      console.warn('   ⚠️  Claim ownership changed before provider attempt — email skipped for recovery');
      continue;
    }
    attemptedEmails.push(email);
  }
  if (attemptedEmails.length === 0) {
    console.log('   No email retained a complete provider-attempt claim — nothing sent.');
    return;
  }

  let result;
  try {
    result = await sendBatch(attemptedEmails);
  } catch (error) {
    // The provider boundary did not return a classified result. Preserve the
    // pre-send claim as ambiguous before surfacing the run failure; a retry
    // must not assume that a transport exception means "never accepted".
    console.error(`   ⚠️  Provider cascade aborted — recording ambiguous delivery state (${String(error?.message || error).slice(0, 120)})`);
    for (const email of attemptedEmails) {
      await finalizeRecipientDelivery(
        db,
        email.dedupWrites,
        'ambiguous',
        now,
        { reason: 'cascade-aborted-before-classification' },
      );
    }
    throw error;
  }
  console.log(`   ✅ Accepted ${result.sent?.length || 0} · ❌ failed ${result.failed?.length || 0}`);

  const { FieldValue } = await import('firebase-admin/firestore');
  const fieldValues = {
    serverTimestamp: () => FieldValue.serverTimestamp(),
    increment: (n) => FieldValue.increment(n),
  };
  let updatedAlerts = 0;
  let acceptedEmails = 0;
  let ambiguousEmails = 0;
  let failedEmails = 0;
  for (const email of attemptedEmails) {
    const delivery = deliveryOutcomeForEmail(email, result);
    if (delivery.outcome === 'accepted') acceptedEmails += 1;
    else if (delivery.outcome === 'ambiguous') ambiguousEmails += 1;
    else failedEmails += 1;
    updatedAlerts += await finalizeRecipientDelivery(
      db,
      email.dedupWrites,
      delivery.outcome,
      now,
      delivery,
      fieldValues,
    );
  }
  console.log(`   📊 Delivery ledger finalized — accepted ${acceptedEmails}, ambiguous ${ambiguousEmails}, failed ${failedEmails}; ${updatedAlerts} alert(s) updated`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('❌ send-company-alerts failed:', err);
    process.exit(1);
  });
}
