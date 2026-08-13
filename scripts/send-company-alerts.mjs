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
 * ── NO NEW FIRESTORE QUERY SHAPE ──────────────────────────────────────────
 * The alert load is byte-for-byte the digest's:
 *   db.collectionGroup('alerts').where('active','==',true)
 * and the company/immediate selection is done IN MEMORY. Filtering on
 * `specificCompanyKey` server-side would need a new composite index, and
 * `firestore.indexes.json` is NOT applied by CI (deploy-firestore-rules.yml
 * ships `firestore:rules` only) — the query would go live and fail with
 * FAILED_PRECONDITION after a green merge. Same reasoning as #5151's
 * `findCompanyAlert`. Do not "optimise" this into a `where` clause without
 * also shipping the index by hand.
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

import { buildAlertProfile, scoreJobForAlert } from '../services/jobAlertMatching.mjs';
import { buildCompanyAlertEmail, COMPANY_ALERT_TEMPLATE_ID, COMPANY_ALERT_MAX_TOTAL_CARDS } from '../services/companyAlertEmail.mjs';
import { nlNormLocale } from '../services/newsletter-template.mjs';
import { isCrossChannelStop, isJobAlertExcluded } from '../services/emailSuppression.mjs';
import { generateAutologinCode, makeAuthenticatedUrl } from '../services/newsletterUrls.mjs';
import { normalizeSentMap, filterUnsentJobs, mergeSentJobs, DEDUP_WINDOW_MS } from './lib/alert-sent-jobs.mjs';
import { makeAlertUnsubscribeUrl, makeAllAlertsUnsubscribeUrl, BASE_URL } from './lib/job-alert-unsub-urls.mjs';
import { commitInChunks, FIRESTORE_BATCH_SIZE } from './lib/firestore-batch.mjs';
import { isImmediateCompanyAlert } from './lib/company-alert-routing.mjs';
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
const PER_RUN_CAP = 300;

/**
 * Chunk size for the post-send `sentJobIds` writeback.
 *
 * The item handed to `commitInChunks` is a RECIPIENT, and its applyFn adds one
 * `batch.update` per rendered section — up to COMPANY_ALERT_MAX_TOTAL_CARDS of
 * them, since a section needs at least one card to exist. commitInChunks
 * assumes at most one op per item to keep its slice length a safe bound on
 * ops-per-batch, so the bound is restored here by dividing: 400 / 20 = 20
 * recipients per batch, i.e. never more than 400 ops, the same ceiling the
 * shared helper enforces for single-op callers.
 *
 * Per-recipient batching is not an optimisation, it is atomicity: all of one
 * email's alerts land in ONE batch, so a chunk boundary can never mark half an
 * email's employers as sent and leave the other half to be re-mailed on the
 * next run — a duplicate for exactly the jobs the reader already received.
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
    return seen > 0 && seen >= cutoff;
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
 * @returns {Array<{alert: object, locale: string, sentMap: object, jobs: object[], companyName: string, freshestMs: number}>}
 */
export function buildRecipientSections(alerts, newJobs, nowMs, dedupWindowMs = DEDUP_WINDOW_MS) {
  const sections = [];
  for (const alert of alerts || []) {
    const locale = nlNormLocale(alert.locale);
    // The SAME matcher the digest uses. `scoreJobForAlert` treats
    // specificCompanyKey as a hard filter that folds brand aliases on both
    // sides (#5151) — re-implementing "job belongs to this employer" here
    // would be the fifth copy of the normalisation that PR spent its review
    // deleting.
    const profile = buildAlertProfile(alert, null, {});
    const matched = (newJobs || []).filter((job) => scoreJobForAlert(job, profile, locale) > 0);
    if (matched.length === 0) continue;

    const sentMap = normalizeSentMap(alert.sentJobIds);
    const unsent = filterUnsentJobs(matched, sentMap, nowMs, dedupWindowMs)
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
 * `ambiguousDelivery` (#4911) is the one case that inverts. The cascade sets it
 * when a provider ACCEPTED the message and then failed on the response, so the
 * email may well be sitting in the inbox already; re-sending it is how the
 * reader gets the duplicate this whole change exists to remove. The flag was
 * added precisely so callers could tell "never sent" from "unknown, do not
 * resend blindly" — so an ambiguous send is treated as delivered here, and the
 * cost of being wrong is bounded: only those jobs are missed, and the next ad
 * from the same employer still arrives.
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
      .filter((f) => !f?.ambiguousDelivery)
      .map((f) => String(f?.recipient?.email || f?.to || '').toLowerCase().trim())
      .filter(Boolean),
  );
  return (emails || []).filter((e) => e && !blocked.has(String(e.to || '').toLowerCase().trim()));
}

function loadNewJobs(nowMs) {
  if (!fs.existsSync(JOBS_PATH)) {
    console.warn(`   ⚠️  ${JOBS_PATH} missing — run scripts/assemble-jobs-dataset.mjs first.`);
    return [];
  }
  const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf-8'));
  if (!Array.isArray(jobs)) return [];
  return selectNewlyPublishedJobs(jobs, nowMs);
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
  return result;
}

async function main() {
  console.log('🏢 CompanyAlert — immediate sender');

  if (process.env.ENABLE_JOB_ALERTS !== 'true') {
    console.log('   ⏭️  ENABLE_JOB_ALERTS is not "true" — skipping (same master switch as the digest).');
    return;
  }

  const now = Date.now();
  const newJobs = loadNewJobs(now);
  console.log(`   Newly published jobs in the last ${IMMEDIATE_WINDOW_MS / 3600000}h: ${newJobs.length}`);
  if (newJobs.length === 0) {
    console.log('   Nothing new — no work.');
    return;
  }

  const db = await getFirestoreAdmin();

  // Same query shape as scripts/send-job-alerts.mjs — see the header note.
  const snap = await db.collectionGroup('alerts').where('active', '==', true).get();
  let alerts = snap.docs
    .filter((d) => d.ref.parent.parent?.parent?.id === 'job_alert_subscribers')
    .map((d) => {
      const data = d.data();
      const parentEmail = d.ref.parent.parent?.id || data.email;
      return { id: d.id, ref: d.ref, ...data, email: data.email || parentEmail };
    })
    .filter(isImmediateCompanyAlert);

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

  // Suppression, from both documents. The newsletter side is isCrossChannelStop:
  // the address-level hard signals (dead or hostile mailbox) AND the explicit
  // newsletter opt-out, in status or stamp. This sender had the same defect as
  // send-job-alerts.mjs and for the same reason (#5688) — it read the newsletter
  // document with isAddressSuppressed(), which asks whether the mailbox works,
  // not whether the person asked us to stop. Followed-employer alerts are their
  // own consent, so an alert-level opt-out does not reach back the other way;
  // the asymmetry is deliberate.
  const emailsInScope = [...new Set(alerts.map((a) => String(a.email || '').toLowerCase()))];
  const suppressed = new Set();
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
        if (nlDoc.exists && isCrossChannelStop(nlDoc.data() || {})) suppressed.add(e);
        if (jaDoc.exists && isJobAlertExcluded((jaDoc.data() || {}).status)) suppressed.add(e);
      });
    } catch (err) {
      // Fail-open but observable — identical policy to the digest's batched
      // lookup: a transient read blip must not drop valid recipients.
      console.warn(`   ⚠️  suppression lookup failed for ${chunk.length} address(es): ${err?.message || err}`);
    }
  }
  if (suppressed.size > 0) {
    const before = alerts.length;
    alerts = alerts.filter((a) => !suppressed.has(String(a.email || '').toLowerCase()));
    console.log(`   🚫 Suppressed (newsletter opt-out / bounced / complained / provider list): ${before - alerts.length} alert(s) skipped`);
  }

  // ── ONE EMAIL PER RECIPIENT ──────────────────────────────────────────────
  // Sorted so the PER_RUN_CAP cut is deterministic: a run that hits the cap and
  // a retry of that run must defer the SAME addresses, or a recipient could sit
  // just past the boundary on every attempt and never be mailed at all.
  const alertsByRecipient = groupAlertsByRecipient(alerts);
  const recipients = [...alertsByRecipient.keys()].sort();
  console.log(`   Recipients in scope: ${recipients.length} (from ${alerts.length} alert(s))`);

  const emailsToSend = [];
  for (let i = 0; i < recipients.length; i += 1) {
    if (emailsToSend.length >= PER_RUN_CAP) {
      console.log(`   📉 PER_RUN_CAP (${PER_RUN_CAP} recipients) reached — ${recipients.length - i} recipient(s) deferred to the next run`);
      break;
    }
    const recipient = recipients[i];
    const sections = buildRecipientSections(alertsByRecipient.get(recipient), newJobs, now, DEDUP_WINDOW_MS);
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
    });

    const rendered = built.sections;
    const byAlertId = new Map(sections.map((section) => [section.alert.id, section]));

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

  const result = await sendBatch(emailsToSend);
  console.log(`   ✅ Sent ${result.sent.length} · ❌ failed ${result.failed.length}`);

  // Persist the dedup map + counters, per alert, for the sends that went out —
  // see selectPersistableSends for the failure semantics (and why an ambiguous
  // delivery counts as sent). Grouping does NOT move the dedup record: it stays
  // on each alert, because "already sent" belongs to the subscription, not to
  // whichever email happened to carry it.
  const { FieldValue } = await import('firebase-admin/firestore');
  const toUpdate = selectPersistableSends(emailsToSend, result.failed)
    .filter((e) => e.dedupWrites.length > 0);
  // One item = one recipient = one email, and its whole writeback lands in a
  // single batch (DEDUP_CHUNK_SIZE keeps ops under the 400 cap). All-or-nothing
  // per email: a chunk that fails leaves every one of that email's employers
  // unmarked, so the next run re-sends the whole message rather than a
  // half-remembered fragment of it.
  await commitInChunks(db, toUpdate, (batch, e) => {
    for (const write of e.dedupWrites) {
      batch.update(write.ref, {
        lastMatchedAt: FieldValue.serverTimestamp(),
        matchCount: FieldValue.increment(write.matchCount),
        sentJobIds: mergeSentJobs(write.sentMap, write.sentJobs, now, DEDUP_WINDOW_MS),
      });
    }
  }, { chunkSize: DEDUP_CHUNK_SIZE });
  const updatedAlerts = toUpdate.reduce((sum, e) => sum + e.dedupWrites.length, 0);
  console.log(`   📊 Firestore updated — ${updatedAlerts} alert(s) across ${toUpdate.length} delivered email(s)`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('❌ send-company-alerts failed:', err);
    process.exit(1);
  });
}
