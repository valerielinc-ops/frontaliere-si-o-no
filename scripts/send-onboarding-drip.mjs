#!/usr/bin/env node
/**
 * send-onboarding-drip.mjs — post-signup onboarding drip runner (#4451).
 *
 * A once-a-day GitHub Actions job (send-onboarding-drip.yml) that walks the
 * confirmed newsletter subscribers and sends the next due step of the 4-touch
 * onboarding sequence (day 0/3/7/14, see services/newsletter/onboardingDrip.mjs).
 *
 * State lives per-user on the newsletter_subscribers/{email} doc — drip_started_at,
 * drip_last_step, drip_last_sent_at, drip_segment, drip_completed — so there are
 * NO double sends: each run only sends step (drip_last_step + 1) and only once it
 * is due. Subscribers excluded via the canonical NEWSLETTER_EXCLUDED_STATUSES
 * (unsubscribed/inactive/bounced/complained/suppressed, see
 * services/emailSuppression.mjs) are skipped on `status` directly, not just the
 * isActive/active booleans. Sends go through the shared email cascade (scripts/lib/email-cascade.mjs),
 * so provider daily caps (Mailjet 200/day, etc.) are respected exactly like the
 * weekly newsletter. Per-user scheduled-send integrates with #3798 (reuses
 * scripts/lib/send-schedule.mjs — not a second scheduler).
 *
 * Modes (mirrors send-newsletter.mjs — NEVER a real local blast):
 *   --dry-run (default)  scan + report what WOULD send, no provider call, no writes
 *   --test --target-email <addr>   send one sample step to one address, no state writes
 *   --send               real run: send due steps + persist state
 *   --max <n>            cap emails this run (default 200; also bounded by cascade quota)
 *   --enroll-window-days <n>   only enroll subscribers confirmed within N days (default 4)
 *   --test-step <0-3>   which step to render in --test (default 0)
 *
 * Required env: GOOGLE_APPLICATION_CREDENTIALS / ADC, NEWSLETTER_SECRET (for
 * signed unsubscribe links), plus at least one email-provider key for --send/--test.
 */

import { subscriberFromFirestoreRow } from './lib/subscriberFromFirestoreRow.mjs';
import { inferInterest } from '../services/newsletter-segments.mjs';
import {
  buildDripEmail,
  resolveDripSegment,
  computeNextStep,
  DRIP_STEP_COUNT,
} from '../services/newsletter/onboardingDrip.mjs';
import { makeUnsubscribeUrl, makeOneClickUnsubscribeUrl, makePreferencesUrl } from '../services/newsletterUrls.mjs';
import { buildLifecycleEmailHeaders } from '../functions/src/lib/lifecycleEmailHeaders.js';
import {
  perUserSendTimeEnabled,
  resolveEffectivePreferredHour,
  computeScheduledSendAt,
} from './lib/send-schedule.mjs';
import { isNewsletterExcluded } from '../services/emailSuppression.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FROM_EMAIL = 'Frontaliere Ticino <newsletter@frontaliereticino.ch>';
const FROM_EMAIL = process.env.NEWSLETTER_FROM || DEFAULT_FROM_EMAIL;

// ── CLI args ─────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name) { return argv.includes(`--${name}`); }
function opt(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

const IS_SEND = flag('send');
const IS_TEST = flag('test');
const IS_DRY_RUN = !IS_SEND && !IS_TEST; // default
const TARGET_EMAIL = opt('target-email');
const MAX = Number(opt('max', '200')) || 200;
const ENROLL_WINDOW_DAYS = Number(opt('enroll-window-days', '4')) || 4;
const TEST_STEP = Math.max(0, Math.min(DRIP_STEP_COUNT - 1, Number(opt('test-step', '0')) || 0));

// ── Firebase Admin ───────────────────────────────────────────
let db;
let adminSdk;
async function initFirebase() {
  const admin = await import('firebase-admin');
  const a = admin.default || admin;
  adminSdk = a;
  if (!a.apps?.length) {
    a.initializeApp({
      credential: a.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  db = a.firestore();
}

function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isUnsubscribedOrInactive(data) {
  if (!data) return true;
  // Canonical cross-sender exclusion set (services/emailSuppression.mjs):
  // unsubscribed/inactive + the address-level hard signals bounced/complained/
  // suppressed. Checked directly on `status` — not just isActive/active — so a
  // status left stale by a reactivation flow (e.g. scripts/mailtrap-suppression-retry.mjs
  // flips isActive/active back to true on retry) can never resume a drip whose
  // status hasn't actually cleared (#4679: onboarding drip kept retrying
  // already-suppressed addresses).
  if (isNewsletterExcluded(data.status)) return true;
  // BOTH spellings (#5673): the SPA "Disiscriviti" link wrote only
  // `unsubscribedAt` (camelCase) until this PR, and 458 documents measured on
  // 2026-08-12 still carry only that one. Reading the snake_case name alone
  // kept dripping onboarding mail at people who had opted out.
  if (data.unsubscribed_at || data.unsubscribedAt) return true;
  if (data.isActive === false) return true;
  if (data.active === false) return true;
  return false;
}

function isConfirmedActive(data) {
  return data.status === 'confirmed' || data.isActive === true || data.active === true;
}

/**
 * Resolve the drip state for a subscriber doc, or null when they are not
 * eligible for a send this run (unsubscribed, not confirmed, completed, or the
 * next step is not yet due). When eligible, returns the step to send.
 */
function resolveDueStep(data, now, enrollWindowMs) {
  if (isUnsubscribedOrInactive(data)) return null;
  if (!isConfirmedActive(data)) return null;
  if (data.drip_completed === true) return null;

  let startedAt = toDate(data.drip_started_at);
  let newlyEnrolled = false;
  if (!startedAt) {
    // Enrollment: only fresh signups (confirmed within the window) start the
    // drip — never back-blast the whole historical base on first deploy.
    const confirmedAt = toDate(data.confirmed_at) || toDate(data.confirmedAt) || toDate(data.created_at) || toDate(data.createdAt);
    if (!confirmedAt) return null;
    if (now.getTime() - confirmedAt.getTime() > enrollWindowMs) return null;
    startedAt = confirmedAt;
    newlyEnrolled = true;
  }

  const lastStep = Number.isInteger(data.drip_last_step) ? data.drip_last_step : -1;
  const nextStep = computeNextStep({ startedAtMs: startedAt.getTime(), lastStep, nowMs: now.getTime() });
  if (nextStep == null) return null;

  return { step: nextStep, startedAt, newlyEnrolled };
}

// ── Build the queue of due drip emails ───────────────────────
async function buildQueue(globalHour, now) {
  const snap = await db.collection('newsletter_subscribers').get();
  const queue = [];
  snap.forEach((doc) => {
    if (doc.id === '_meta_') return;
    const data = doc.data() || {};
    const due = resolveDueStep(data, now, ENROLL_WINDOW_DAYS * DAY_MS);
    if (!due) return;

    const subscriber = subscriberFromFirestoreRow({ ...data, email: data.email || doc.id });
    if (!subscriber) return;
    const locale = subscriber.locale || 'it';
    const interest = inferInterest(subscriber);
    const acquisitionSource = subscriber.source || subscriber.sourceComponent || subscriber.sourceChannel || null;

    const { subject, html, cardId } = buildDripEmail({
      step: due.step,
      locale,
      interest,
      acquisitionSource,
      unsubscribeUrl: makeUnsubscribeUrl(subscriber.email),
      // #5684 — the drip footer carries the preference centre alongside the
      // one-way unsubscribe, same as the weekly newsletter and the job alerts.
      preferencesUrl: makePreferencesUrl(subscriber.email, locale, { fallbackUnsigned: true }),
    });

    // Per-user scheduled send (#3798): reuse the shared resolver, never a
    // second scheduler. Falls back to immediate send when disabled / no signal.
    let scheduledAt = null;
    if (perUserSendTimeEnabled()) {
      const eff = resolveEffectivePreferredHour({ subscriberDoc: data, globalHour });
      if (eff?.hourUtc != null) {
        scheduledAt = computeScheduledSendAt({ preferredHourUtc: eff.hourUtc, email: subscriber.email, now });
      }
    }

    queue.push({
      docRef: doc.ref,
      email: subscriber.email,
      step: due.step,
      cardId,
      startedAt: due.startedAt,
      newlyEnrolled: due.newlyEnrolled,
      segment: resolveDripSegment(interest),
      payload: {
        from: FROM_EMAIL,
        to: [subscriber.email],
        subject,
        html,
        ...(scheduledAt ? { scheduledAt } : {}),
        headers: buildLifecycleEmailHeaders({
          email: subscriber.email,
          campaignId: `onboarding_drip_step_${due.step}`,
          oneClickUnsubscribeUrl: makeOneClickUnsubscribeUrl(subscriber.email),
        }),
        tags: [
          { name: 'campaign_id', value: `onboarding_drip_step_${due.step}` },
          { name: 'type', value: 'lifecycle' },
          { name: 'locale', value: locale },
        ],
      },
      recipient: { email: subscriber.email },
      meta: { step: due.step, cardId },
    });
  });
  return queue;
}

async function persistSent(item) {
  const patch = {
    drip_last_step: item.step,
    drip_segment: item.segment,
    drip_last_sent_at: adminSdk.firestore.FieldValue.serverTimestamp(),
    updated_at: adminSdk.firestore.FieldValue.serverTimestamp(),
  };
  if (item.newlyEnrolled) {
    patch.drip_started_at = adminSdk.firestore.Timestamp.fromDate(item.startedAt);
  }
  if (item.step >= DRIP_STEP_COUNT - 1) patch.drip_completed = true;
  await item.docRef.set(patch, { merge: true });
  await item.docRef.collection('events').add({
    email: item.email,
    event_type: 'onboarding_drip_sent',
    source_channel: 'onboarding_drip',
    meta: { step: item.step, card: item.cardId, segment: item.segment },
    timestamp: adminSdk.firestore.FieldValue.serverTimestamp(),
    occurred_at: new Date().toISOString(),
  });
}

// ── Modes ────────────────────────────────────────────────────
async function runTest() {
  if (!TARGET_EMAIL) {
    console.error('❌ --test requires --target-email <addr>');
    process.exit(1);
  }
  const { sendEmailCascade, logProviderSummary } = await import('./lib/email-cascade.mjs');
  const { subject, html, cardId } = buildDripEmail({
    step: TEST_STEP,
    locale: opt('locale', 'it'),
    interest: opt('interest', null),
    acquisitionSource: opt('acquisition-source', null),
    unsubscribeUrl: makeUnsubscribeUrl(TARGET_EMAIL),
    preferencesUrl: makePreferencesUrl(TARGET_EMAIL, opt('locale', 'it'), { fallbackUnsigned: true }),
  });
  console.log(`🧪 Test drip: step ${TEST_STEP} (${cardId}) → ${TARGET_EMAIL}`);
  const { sent, failed } = await sendEmailCascade([{
    payload: {
      from: FROM_EMAIL,
      to: [TARGET_EMAIL],
      subject: `[TEST] ${subject}`,
      html,
      tags: [{ name: 'campaign_id', value: `onboarding_drip_test_${TEST_STEP}` }, { name: 'type', value: 'lifecycle' }],
    },
    recipient: { email: TARGET_EMAIL },
    meta: {},
  }]);
  logProviderSummary();
  if (failed.length) {
    console.error('❌ Test send failed:', failed[0]?.error);
    process.exit(1);
  }
  console.log(`✅ Test drip sent to ${TARGET_EMAIL} (messageId=${sent[0]?.messageId || 'n/a'})`);
}

async function runScan() {
  await initFirebase();
  const now = new Date();

  // Global preferred-hour fallback (#3798) persisted by send-newsletter.mjs.
  let globalHour = null;
  try {
    const meta = await db.collection('newsletter_subscribers').doc('_meta_').get();
    const h = meta.exists ? meta.data()?.global_preferred_send_hour_utc : null;
    globalHour = Number.isInteger(h) ? h : null;
  } catch { /* immediate send if unavailable */ }

  const queue = await buildQueue(globalHour, now);
  const byStep = queue.reduce((acc, q) => { acc[q.step] = (acc[q.step] || 0) + 1; return acc; }, {});
  console.log(`📊 Onboarding drip: ${queue.length} subscribers due (by step: ${JSON.stringify(byStep)})`);

  const capped = queue.slice(0, MAX);
  if (capped.length < queue.length) {
    console.log(`⏱️  Capped to ${capped.length}/${queue.length} this run (--max ${MAX}); the rest go next run.`);
  }

  if (capped.length === 0) {
    console.log('✅ Nothing due. Done.');
    return;
  }

  if (IS_DRY_RUN) {
    const first = capped[0];
    console.log('🧪 Dry-run: no provider call, no state written.');
    console.log(`  would send: ${capped.length}`);
    console.log(`  sample: step ${first.step} (${first.cardId}) → ${first.email} | scheduledAt=${first.payload.scheduledAt || 'immediate'}`);
    return;
  }

  // ── Real send ──
  const { sendEmailCascade, logProviderSummary } = await import('./lib/email-cascade.mjs');
  const byEmail = new Map(capped.map((q) => [q.email.toLowerCase(), q]));
  const { sent, failed } = await sendEmailCascade(capped);
  logProviderSummary();

  let persisted = 0;
  for (const s of sent) {
    const item = byEmail.get(String(s.recipient?.email || '').toLowerCase());
    if (!item) continue;
    try { await persistSent(item); persisted += 1; }
    catch (e) { console.warn(`⚠️  persist failed for ${item.email}: ${e?.message}`); }
  }
  console.log(`✅ Onboarding drip: ${sent.length} sent, ${failed.length} failed, ${persisted} state-updated.`);
}

async function main() {
  console.log(`📧 Onboarding drip runner — mode=${IS_SEND ? 'send' : IS_TEST ? 'test' : 'dry-run'} max=${MAX} enrollWindowDays=${ENROLL_WINDOW_DAYS}`);
  if (IS_TEST) return runTest();
  return runScan();
}

main().catch((e) => {
  console.error('❌ Onboarding drip failed:', e?.stack || e?.message || e);
  process.exit(1);
});
