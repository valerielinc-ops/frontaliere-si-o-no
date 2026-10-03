#!/usr/bin/env node
/**
 * Send the one-shot reminder for authenticated application-intent records.
 *
 * A record is created by an explicit "Apply" click. It is never treated as
 * proof that an application was submitted. This sender is deliberately
 * separate from the recurring saved-jobs digest: one delivery is claimed per
 * intent, with a 48-hour delay and a separate unsubscribe preference. Its
 * HTML/text template also includes the shared dataControllerFooterLine.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCantonResolvers } from '../build-plugins/shared/cantonResolvers.mjs';
import { isCrossChannelStop } from '../services/emailSuppression.mjs';
import { SLUG_TABLES } from '../services/routeSlugs.data.ts';
import { localePathPrefix } from './lib/articleContent.mjs';
import { verifiedEmailForUid } from './lib/verifiedAccountEmail.mjs';
import {
  APPLICATION_INTENTS_COLLECTION,
  APPLICATION_INTENT_APPLICATION_MODES,
} from '../functions/src/applicationIntentCore.js';
import {
  canSendApplicationIntentReminder,
  isApplicationIntentAccountDeleted,
} from '../functions/src/applicationIntentPrivacy.js';
import {
  applicationIntentUid,
  buildApplicationIntentEntry,
  isApplicationIntentReminderEligible,
  rankSimilarApplicationJobs,
  snapshotData,
  APPLICATION_INTENT_REMINDER_DELIVERIES_COLLECTION,
  MAX_APPLICATION_INTENT_RECOMMENDATIONS,
} from './lib/applicationIntentReminder.mjs';
import {
  buildApplicationIntentReminderEmailHtml,
  buildApplicationIntentReminderEmailText,
  getApplicationIntentReminderStrings,
} from './lib/applicationIntentReminderEmail.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const BASE_URL = 'https://frontaliereticino.ch';
const FROM_EMAIL = 'Frontaliere Ticino <alerts@frontaliereticino.ch>';
const DRY_RUN = process.argv.includes('--dry-run')
  || process.env.EFFECTIVE_DRY_RUN === 'true';
const TARGET_EMAIL_RAW = (process.env.TARGET_EMAIL || '').trim().toLowerCase();
const MAX_APPLICATION_INTENTS_PER_EMAIL = 5;
const UNSUB_PATH = '/disiscrivi-promemoria-candidature/';

if (TARGET_EMAIL_RAW) {
  console.log(`🎯 TARGET_EMAIL set — limiting send to: ${TARGET_EMAIL_RAW}`);
}

const cantonSlugFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'canton-url-slugs.json'), 'utf8'));
const municipalitiesFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'canton-municipalities.json'), 'utf8'));
const { resolveCantonSection, resolveJobCanton } = createCantonResolvers({ cantonSlugFile, municipalitiesFile });

function jobPageUrl(job, locale = 'it') {
  const cantonCode = resolveJobCanton({ canton: job.canton, location: job.location });
  const boardPath = resolveCantonSection(locale, cantonCode);
  const slug = job.slugByLocale?.[locale] || job.slugByLocale?.it || job.slug || '';
  return slug
    ? `${BASE_URL}${localePathPrefix(locale)}/${boardPath}/${slug}/`
    : `${BASE_URL}${localePathPrefix(locale)}/${resolveCantonSection(locale, 'TI')}/`;
}

function profileUrl(locale = 'it') {
  const slug = SLUG_TABLES[locale]?.profile || SLUG_TABLES.it.profile;
  return `${BASE_URL}${localePathPrefix(locale)}/${slug}/`;
}

function makeUnsubscribeUrl(uid, email, locale = 'it') {
  const secret = process.env.NEWSLETTER_SECRET;
  if (!secret) return profileUrl(locale);
  const token = createHmac('sha256', secret)
    .update(`application_intent_reminder_unsub:${uid}`)
    .digest('hex');
  return `${BASE_URL}${UNSUB_PATH}?uid=${encodeURIComponent(uid)}&email=${encodeURIComponent(email)}&token=${token}`;
}

let _jobsForTest = null;
export function __setJobsForTest(jobs) {
  _jobsForTest = jobs;
}

function loadJobsById() {
  const jobs = _jobsForTest || JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
  return new Map(jobs.map((job) => [job.id, job]));
}

function snapshotExists(snapshot) {
  return typeof snapshot?.exists === 'function' ? snapshot.exists() : snapshot?.exists === true;
}

function snapshotDataSafe(snapshot) {
  return snapshotData(snapshot) || {};
}

function intentDeliveryRef(db, intentId) {
  return db.collection(APPLICATION_INTENT_REMINDER_DELIVERIES_COLLECTION).doc(intentId);
}

function deliveryExists(snapshot) {
  return typeof snapshot?.exists === 'function' ? snapshot.exists() : snapshot?.exists === true;
}

/**
 * The outcome of a send lives in the delivery ledger, not on the intent, so a
 * reminded intent stays eligible by its own data until it expires (90 days).
 * Drop intents that already have a ledger row (sent, sending or unknown)
 * before the per-email cap: otherwise the five oldest reminded intents fill
 * every later selection, the claim returns nothing, and a sixth click is
 * never reminded. The claim transaction stays the idempotency boundary.
 */
export async function withoutRecordedDelivery(db, entries) {
  const kept = [];
  for (const entry of entries) {
    if (!entry?.intentId) continue;
    const snapshot = await intentDeliveryRef(db, entry.intentId).get();
    if (!deliveryExists(snapshot)) kept.push(entry);
  }
  return kept;
}

/**
 * Atomically claim the exact intent ids that will appear in this email.
 * Existing `sent`, `sending` and `unknown` rows win; this is the idempotency
 * boundary against concurrent Actions runs and provider retries. A provider
 * outcome that cannot be classified is terminal until an explicit
 * reconciliation process can inspect it, so a stale claim is never reused
 * automatically and an accepted email cannot be duplicated.
 */
export async function claimApplicationIntentReminderDeliveries(db, {
  uid,
  intentIds,
  campaignId,
  now = new Date(),
} = {}) {
  const ids = [...new Set((intentIds || []).map((value) => String(value || '').trim()).filter(Boolean))];
  if (!uid || !campaignId || ids.length === 0) return [];
  return db.runTransaction(async (transaction) => {
    const refs = ids.map((intentId) => intentDeliveryRef(db, intentId));
    const snapshots = [];
    for (const ref of refs) snapshots.push(await transaction.get(ref));
    const claimable = [];
    for (let index = 0; index < snapshots.length; index++) {
      const snapshot = snapshots[index];
      if (!deliveryExists(snapshot)) {
        claimable.push(ids[index]);
      }
    }
    for (const intentId of claimable) {
      const data = {
        uid,
        intent_id: intentId,
        campaign_id: campaignId,
        state: 'sending',
        claimed_at: now,
      };
      const existing = snapshots[ids.indexOf(intentId)];
      if (deliveryExists(existing)) transaction.set(intentDeliveryRef(db, intentId), data, { merge: true });
      else transaction.create(intentDeliveryRef(db, intentId), data);
    }
    return claimable;
  });
}

export async function markApplicationIntentReminderSent(db, {
  intentIds,
  campaignId,
  messageId = null,
  provider = null,
  sentAt = new Date(),
} = {}) {
  const ids = [...new Set((intentIds || []).map((value) => String(value || '').trim()).filter(Boolean))];
  await Promise.all(ids.map((intentId) => db.collection(APPLICATION_INTENT_REMINDER_DELIVERIES_COLLECTION)
    .doc(intentId)
    .set({
      campaign_id: campaignId,
      state: 'sent',
      message_id: messageId,
      provider,
      sent_at: sentAt,
    }, { merge: true })));
}

/** Release only definite provider failures; ambiguous delivery stays claimed. */
export async function releaseApplicationIntentReminderClaims(db, { intentIds } = {}) {
  const ids = [...new Set((intentIds || []).map((value) => String(value || '').trim()).filter(Boolean))];
  await db.runTransaction(async (transaction) => {
    const refs = ids.map((intentId) => intentDeliveryRef(db, intentId));
    const snapshots = [];
    for (const ref of refs) snapshots.push(await transaction.get(ref));
    snapshots.forEach((snapshot, index) => {
      if (!deliveryExists(snapshot)) return;
      if (snapshotDataSafe(snapshot).state === 'sending') transaction.delete(refs[index]);
    });
  });
}

/**
 * Persist an ambiguous provider outcome as terminal. It must be reconciled
 * explicitly before any future send can be considered; automatic retries are
 * unsafe because the provider may already have accepted the message.
 */
export async function markApplicationIntentReminderUnknown(db, {
  intentIds,
  campaignId,
  error = null,
  at = new Date(),
} = {}) {
  const ids = [...new Set((intentIds || []).map((value) => String(value || '').trim()).filter(Boolean))];
  const lastError = error ? String(error.message || error).slice(0, 500) : null;
  await Promise.all(ids.map((intentId) => db.collection(APPLICATION_INTENT_REMINDER_DELIVERIES_COLLECTION)
    .doc(intentId)
    .set({
      campaign_id: campaignId,
      state: 'unknown',
      unknown_at: at,
      ...(lastError ? { last_error: lastError } : {}),
    }, { merge: true })));
}

export async function markApplicationIntentReminderSkipped(db, { intentId, intentRef, reason, now = new Date() } = {}) {
  if (!intentId && !intentRef) return;
  const ref = intentRef || db.collection(APPLICATION_INTENTS_COLLECTION).doc(intentId);
  await ref.set({
    reminder: {
      state: 'skipped',
      skippedReason: reason || 'not_eligible',
      skippedAt: now,
    },
    updatedAt: now,
  }, { merge: true });
}

function recommendationEntry(job, locale) {
  return {
    id: job.id,
    title: job.titleByLocale?.[locale] || job.titleByLocale?.it || job.title || '',
    company: job.company || '',
    canton: job.canton || null,
    location: job.location || job.addressLocality || null,
    category: job.category || null,
    sector: job.sector || job.category || null,
    companyKey: job.companyKey || null,
    firstSeenAt: job.firstSeenAt || null,
    salaryMin: job.salaryMin ?? null,
    salaryMax: job.salaryMax ?? null,
    currency: job.currency || null,
    baseSalary: job.baseSalary || null,
    contract: job.contract || null,
    url: jobPageUrl(job, locale),
  };
}

function applicationMode(entry, rawData) {
  const candidate = String(entry?.applicationMode || rawData?.application_mode || 'external').trim();
  return APPLICATION_INTENT_APPLICATION_MODES.includes(candidate) ? candidate : 'external';
}

async function loadCompletedInternalApplicationKeys(db, uid, entries) {
  if (!entries.some((entry) => entry.applicationMode === 'in_house' || entry.applicationMode === 'forward_email')) {
    return new Set();
  }
  const snapshot = await db.collection('applications').where('candidateUid', '==', uid).get();
  const keys = new Set();
  for (const application of snapshot.docs || []) {
    const data = application.data() || {};
    for (const key of [data.jobId, data.job_id, data.jobSlug, data.job_slug, data.slug]) {
      if (key != null && String(key).trim()) keys.add(String(key).trim());
    }
  }
  return keys;
}

function completedInternalApplication(entry, completedKeys) {
  if (!completedKeys?.size) return false;
  const job = entry.sourceJob || {};
  const keys = [
    job.id,
    job.slug,
    ...Object.values(job.slugByLocale || {}),
    entry.id,
  ].filter(Boolean).map(String);
  return keys.some((key) => completedKeys.has(key));
}

let _db = null;
export function __setFirestoreAdminForTest(fakeDb) {
  _db = fakeDb;
}

async function getFirestoreAdmin() {
  if (_db) return _db;
  const { initializeApp, cert, getApps, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (getApps().length === 0) {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (credPath && fs.existsSync(credPath)) {
      const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      initializeApp({ credential: cred.project_id ? cert(cred) : applicationDefault(), projectId: cred.project_id || 'frontaliere-ticino' });
    } else {
      initializeApp({ credential: applicationDefault(), projectId: 'frontaliere-ticino' });
    }
  }
  _db = getFirestore();
  return _db;
}

async function sendReminder({ db, uid, email, locale, entries, recommendations, campaignId }) {
  const manageUrl = profileUrl(locale);
  const unsubUrl = makeUnsubscribeUrl(uid, email, locale);
  const strings = getApplicationIntentReminderStrings(locale);
  const html = buildApplicationIntentReminderEmailHtml({
    locale,
    applicationIntentEntries: entries,
    recommendations,
    manageUrl,
    unsubUrl,
    email,
  });
  const text = buildApplicationIntentReminderEmailText({
    locale,
    applicationIntentEntries: entries,
    recommendations,
    manageUrl,
    unsubUrl,
  });
  const subject = strings.subject(entries.length);
  if (DRY_RUN) {
    console.log(`   📝 [dry-run] would send to ${email} (${locale}) — subject: ${subject}`);
    return { sent: true, dryRun: true };
  }

  const { sendEmailCascade } = await import('./lib/email-cascade.mjs');
  const intentIds = entries.map((entry) => entry.intentId).filter(Boolean);
  const result = await sendEmailCascade([{
    payload: {
      from: FROM_EMAIL,
      to: [email],
      subject,
      html,
      text,
      tags: [
        { name: 'type', value: 'application-intent-reminder' },
        { name: 'campaign_id', value: campaignId },
        { name: 'intent_count', value: String(entries.length) },
        { name: 'recommendation_count', value: String(recommendations.length) },
      ],
      headers: {
        'Feedback-ID': `application-intent-reminder:${uid}:frontaliere-ticino`,
        'List-Unsubscribe': `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    },
    recipient: { email },
    meta: { type: 'application-intent-reminder', uid, campaignId },
  }], {
    concurrency: 1,
    onSent: (_item, sendResult) => markApplicationIntentReminderSent(db, {
      intentIds,
      campaignId,
      messageId: sendResult?.messageId || null,
      provider: sendResult?.provider || null,
    }),
  });

  const sent = result.sent.length > 0;
  const failures = Array.isArray(result.failed) ? result.failed : [];
  if (sent) {
    await markApplicationIntentReminderSent(db, {
      intentIds,
      campaignId,
      messageId: result.sent[0]?.messageId || null,
      provider: result.sent[0]?.provider || null,
    });
  } else if (failures.length > 0 && failures.every((failure) => failure.ambiguousDelivery !== true)) {
    await releaseApplicationIntentReminderClaims(db, { intentIds });
  } else {
    await markApplicationIntentReminderUnknown(db, {
      intentIds,
      campaignId,
      error: failures[0]?.error || failures[0]?.message || 'provider outcome unavailable',
    });
  }
  return { sent, failed: result.failed };
}

/**
 * Without the HMAC secret makeUnsubscribeUrl falls back to the profile URL,
 * and the List-Unsubscribe one-click POST would reach a page that cannot
 * unsubscribe anyone. Same rule as send-saved-jobs-digest.mjs: refuse the run.
 */
export function assertUnsubscribeSecret(dryRun = DRY_RUN, env = process.env) {
  if (dryRun || env.NEWSLETTER_SECRET) return;
  throw new Error('NEWSLETTER_SECRET is not set: refusing to send without a working one-click unsubscribe link');
}

export async function main() {
  assertUnsubscribeSecret();
  const db = await getFirestoreAdmin();
  const jobsById = loadJobsById();
  const allJobs = [...jobsById.values()];
  const now = new Date();
  const nowMs = now.getTime();
  const campaignId = `application-intent-reminder-${now.toISOString().slice(0, 10)}`;

  console.log('📝 Application-intent reminders — querying intents…');
  const intentSnap = await db.collectionGroup(APPLICATION_INTENTS_COLLECTION).get();
  const byUid = new Map();
  for (const snapshot of intentSnap.docs || []) {
    const uid = applicationIntentUid(snapshot);
    if (!uid) continue;
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push(snapshot);
  }

  let sentCount = 0;
  let skippedCount = 0;
  // Per-account skip reasons, counts only (no address): a run that ends
  // "sent 0" must say why, not just how many.
  const skipReasons = new Map();
  const skip = (reason) => {
    skippedCount++;
    skipReasons.set(reason, (skipReasons.get(reason) || 0) + 1);
  };
  for (const [uid, snapshots] of byUid) {
    const userDoc = await db.collection('users').doc(uid).get();
    // A saved-jobs profile is not required for this channel. A signed-in user
    // can click Apply before ever saving a job; Auth is the identity source and
    // users/{uid} contributes only locale and purpose-specific preferences.
    const userData = snapshotExists(userDoc) ? userDoc.data() || {} : {};
    let email;
    try {
      email = await verifiedEmailForUid(uid, userData);
    } catch {
      skip('auth_lookup_failed');
      continue;
    }
    if (!email) {
      skip('no_verified_email');
      continue;
    }
    if (TARGET_EMAIL_RAW && email !== TARGET_EMAIL_RAW) {
      skip('not_target');
      continue;
    }

    const locale = userData.locale || 'it';
    let accountDeleted;
    try {
      accountDeleted = await isApplicationIntentAccountDeleted(db, uid);
    } catch {
      skip('deletion_read_failed');
      continue;
    }
    const subscriberDoc = await db.collection('newsletter_subscribers').doc(email).get();
    const subscriberData = snapshotExists(subscriberDoc) ? subscriberDoc.data() || {} : null;
    if (subscriberData && isCrossChannelStop(subscriberData)) {
      skip('cross_channel_stop');
      continue;
    }

    const eligible = [];
    const snapshotByIntentId = new Map();
    let allowedIntents = 0;
    let dueIntents = 0;
    for (const snapshot of snapshots) {
      const rawData = snapshotDataSafe(snapshot);
      if (!canSendApplicationIntentReminder({
        profile: userData,
        intent: rawData,
        userId: uid,
        accountDeleted,
        now: nowMs,
      })) continue;
      allowedIntents++;
      if (!isApplicationIntentReminderEligible(rawData, nowMs)) continue;
      dueIntents++;
      const entry = buildApplicationIntentEntry(snapshot, jobsById, locale, jobPageUrl, nowMs);
      if (!entry) continue;
      entry.applicationMode = applicationMode(entry, rawData);
      eligible.push(entry);
      snapshotByIntentId.set(entry.intentId, snapshot);
    }
    if (eligible.length === 0) {
      if (allowedIntents === 0) skip('intent_not_allowed');
      else if (dueIntents === 0) skip('intent_not_due_or_closed');
      else skip('job_not_live');
      continue;
    }

    let completedKeys = new Set();
    try {
      completedKeys = await loadCompletedInternalApplicationKeys(db, uid, eligible);
    } catch {
      // A failed completion read must fail closed for internal applications;
      // external redirects can still be considered independently.
      completedKeys = null;
    }
    const deliverable = [];
    for (const entry of eligible) {
      if (entry.applicationMode === 'external') {
        deliverable.push(entry);
        continue;
      }
      if (completedKeys === null) continue;
      if (completedInternalApplication(entry, completedKeys)) {
        if (!DRY_RUN) {
          await markApplicationIntentReminderSkipped(db, {
            intentId: entry.intentId,
            intentRef: snapshotByIntentId.get(entry.intentId)?.ref,
            reason: 'application_completed',
            now,
          });
        }
        continue;
      }
      deliverable.push(entry);
    }
    if (deliverable.length === 0) {
      skip('no_deliverable_intent');
      continue;
    }

    let undelivered;
    try {
      undelivered = await withoutRecordedDelivery(db, deliverable);
    } catch {
      skip('delivery_read_failed');
      continue;
    }
    if (undelivered.length === 0) {
      skip('already_delivered');
      continue;
    }

    undelivered.sort((a, b) => (a.intentAt || 0) - (b.intentAt || 0));
    const selectedEntries = undelivered.slice(0, MAX_APPLICATION_INTENTS_PER_EMAIL);
    const sourceJobs = selectedEntries.map((entry) => entry.sourceJob).filter(Boolean);
    const excludedJobIds = new Set(selectedEntries.map((entry) => entry.id));
    const recommendedJobs = rankSimilarApplicationJobs(sourceJobs, allJobs, {
      max: MAX_APPLICATION_INTENT_RECOMMENDATIONS,
      excludedJobIds,
    });
    const recommendations = recommendedJobs.map((job) => recommendationEntry(job, locale));

    let claimedIds = selectedEntries.map((entry) => entry.intentId).filter(Boolean);
    if (!DRY_RUN) {
      claimedIds = await claimApplicationIntentReminderDeliveries(db, {
        uid,
        intentIds: claimedIds,
        campaignId,
        now,
      });
      if (claimedIds.length === 0) {
        skip('claim_lost');
        continue;
      }
      const claimedSet = new Set(claimedIds);
      selectedEntries.splice(0, selectedEntries.length, ...selectedEntries.filter((entry) => claimedSet.has(entry.intentId)));
    }

    console.log(`   ✉️  ${email} (${locale}) — ${selectedEntries.length} intent(s), ${recommendations.length} recommended`);
    const result = await sendReminder({
      db,
      uid,
      email,
      locale,
      entries: selectedEntries,
      recommendations,
      campaignId,
    });
    if (result.sent) sentCount++;
    else skip('provider_not_accepted');
  }

  console.log(`\n📊 Done — sent ${sentCount}, skipped ${skippedCount}${DRY_RUN ? ' (dry-run)' : ''}`);
  if (skipReasons.size > 0) {
    const breakdown = [...skipReasons.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => `${reason}=${count}`)
      .join(', ');
    console.log(`   Skip reasons: ${breakdown}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('❌ send-application-intent-reminders.mjs failed:', error);
    process.exitCode = 1;
  });
}

export {
  applicationMode,
  jobPageUrl,
  loadJobsById,
  makeUnsubscribeUrl,
  recommendationEntry,
};
