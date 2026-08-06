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
import { buildCompanyAlertEmail, COMPANY_ALERT_TEMPLATE_ID, COMPANY_ALERT_MAX_CARDS } from '../services/companyAlertEmail.mjs';
import { nlNormLocale } from '../services/newsletter-template.mjs';
import { isAddressSuppressed, isJobAlertExcluded } from '../services/emailSuppression.mjs';
import { generateAutologinCode, makeAuthenticatedUrl } from '../services/newsletterUrls.mjs';
import { normalizeSentMap, filterUnsentJobs, mergeSentJobs, DEDUP_WINDOW_MS } from './lib/alert-sent-jobs.mjs';
import { makeAlertUnsubscribeUrl, makeAllAlertsUnsubscribeUrl, BASE_URL } from './lib/job-alert-unsub-urls.mjs';
import { commitInChunks } from './lib/firestore-batch.mjs';
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
 * Per-run cap on emails, mirroring blast-publisher-ads.mjs's PER_RUN_CAP. The
 * workflow can fire many times an hour when several crawler groups land; this
 * bounds a pathological run (a crawler re-keying its whole slice so every job
 * looks first-seen) before it eats the shared cascade quota the digest and the
 * newsletter also draw on.
 */
const PER_RUN_CAP = 300;

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
        { name: 'alert_id', value: e.alertId },
      ],
      headers: {
        'Feedback-ID': `${COMPANY_ALERT_TEMPLATE_ID}:${e.alertId}:frontaliere-ticino`,
        // RFC 8058 one-click unsubscribe, same contract as the digest.
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

  if (ALLOWED_EMAILS) {
    alerts = alerts.filter((a) => ALLOWED_EMAILS.has(String(a.email || '').toLowerCase()));
    console.log(`   ⚠️  TARGET_EMAIL active — ${alerts.length} alert(s) in scope`);
  }
  console.log(`   Immediate CompanyAlerts: ${alerts.length}`);
  if (alerts.length === 0) return;

  // Hard address-level suppression (bounce / complaint / provider list). Same
  // two-collection check the digest performs — a dead or hostile mailbox must
  // not receive this channel either.
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
        if (nlDoc.exists && isAddressSuppressed((nlDoc.data() || {}).status)) suppressed.add(e);
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
    console.log(`   🚫 Hard-suppressed: ${before - alerts.length} alert(s) skipped`);
  }

  const emailsToSend = [];
  for (const alert of alerts) {
    if (emailsToSend.length >= PER_RUN_CAP) {
      console.log(`   📉 PER_RUN_CAP (${PER_RUN_CAP}) reached — remaining alerts deferred to the next run`);
      break;
    }
    const locale = nlNormLocale(alert.locale);
    // The SAME matcher the digest uses. `scoreJobForAlert` treats
    // specificCompanyKey as a hard filter that folds brand aliases on both
    // sides (#5151) — re-implementing "job belongs to this employer" here
    // would be the fifth copy of the normalisation that PR spent its review
    // deleting.
    const profile = buildAlertProfile(alert, null, {});
    const matched = newJobs.filter((job) => scoreJobForAlert(job, profile, locale) > 0);
    if (matched.length === 0) continue;

    const sentMap = normalizeSentMap(alert.sentJobIds);
    const unsent = filterUnsentJobs(matched, sentMap, now, DEDUP_WINDOW_MS);
    if (unsent.length === 0) {
      console.log(`   ⏭️  Alert ${alert.id}: ${matched.length} match(es), all already sent → skip`);
      continue;
    }

    const shown = unsent.slice(0, COMPANY_ALERT_MAX_CARDS);
    const recipient = String(alert.email || '').toLowerCase().trim();
    const autologinCode = generateAutologinCode(recipient);
    const wrapUrl = (raw) => makeAuthenticatedUrl(raw, recipient, {
      autologinCode,
      utmMedium: 'email',
      preserveExistingUtmMedium: true,
    });
    // «Gestisci le aziende seguite» → the page that actually manages them.
    //
    // It used to point at /preferenze-newsletter/ because that link is
    // token-HMAC and works with no session, while /aziende-seguite/ reads the
    // signed-in user. `wrapUrl` closes that gap: it appends the same `ne`+`ac`
    // autologin pair every other link in this email carries, and App.tsx's
    // autologin effect is route-independent — it exchanges the code and signs
    // the reader in wherever they land. So the deep link arrives authenticated
    // on the page that lists exactly what the email is about.
    //
    // The preferences page stays reachable: the unsubscribe links below are
    // pure HMAC and never depend on a session, so a failed exchange still
    // leaves a working way out — which is the part that must never break.
    const manageUrl = wrapUrl(
      `${BASE_URL}${followedCompaniesPath(locale)}?utm_source=${COMPANY_ALERT_TEMPLATE_ID}&utm_campaign=alert_${alert.id}`,
    );
    // Display name: the alert stores only the canonical slug, so de-slug from
    // the job the employer just posted (authoritative, correctly cased) and
    // fall back to a title-cased slug when the field is missing.
    const companyName = String(shown[0]?.company || '').trim()
      || String(alert.specificCompanyKey || '').split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    // ONE derivation, reused for the body link and the RFC 8058 header — the
    // two must be the same URL or a one-click unsubscribe and a clicked link
    // diverge.
    const unsubscribeUrl = makeAlertUnsubscribeUrl(alert.id, recipient);

    const { subject, html, text } = buildCompanyAlertEmail({
      companyName,
      companySlug: String(alert.specificCompanyKey),
      jobs: shown,
      email: recipient,
      locale,
      manageUrl,
      unsubscribeUrl,
      unsubscribeAllUrl: makeAllAlertsUnsubscribeUrl(recipient),
      wrapUrl,
      baseUrl: BASE_URL,
    });

    emailsToSend.push({
      to: recipient,
      alertId: alert.id,
      ref: alert.ref,
      subject,
      html,
      text,
      unsubscribeUrl,
      sentMap,
      sentJobs: shown,
      matchCount: shown.length,
    });
  }

  if (emailsToSend.length === 0) {
    console.log('   No new jobs for any followed employer — nothing to send.');
    return;
  }

  if (DRY_RUN) {
    console.log(`   🔵 DRY RUN — would send ${emailsToSend.length} email(s)`);
    for (const e of emailsToSend) console.log(`      → ${e.to}: ${e.subject}`);
    return;
  }

  const result = await sendBatch(emailsToSend);
  console.log(`   ✅ Sent ${result.sent.length} · ❌ failed ${result.failed.length}`);

  // Persist the dedup map + counters. A failed send must NOT mark its jobs as
  // sent, or the next run would skip them and the user never hears about the
  // job at all — the failure would be permanent and invisible.
  const failedTo = new Set(result.failed.map((f) => String(f.recipient?.email || '').toLowerCase()));
  const { FieldValue } = await import('firebase-admin/firestore');
  const toUpdate = emailsToSend.filter((e) => e.ref && !failedTo.has(e.to));
  await commitInChunks(db, toUpdate, (batch, e) => {
    batch.update(e.ref, {
      lastMatchedAt: FieldValue.serverTimestamp(),
      matchCount: FieldValue.increment(e.matchCount),
      sentJobIds: mergeSentJobs(e.sentMap, e.sentJobs, now, DEDUP_WINDOW_MS),
    });
  });
  console.log('   📊 Firestore updated');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('❌ send-company-alerts failed:', err);
    process.exit(1);
  });
}
