#!/usr/bin/env node
/**
 * Backfill `job_alert_subscribers/{email}/alerts/backfill-jobgate` from
 * `newsletter_subscribers` docs with `source_channel === 'job_gate'`.
 *
 * Rationale: a user who signed up to unlock a job's detail (the "job_gate"
 * newsletter flow) is actively job-hunting even though they never explicitly
 * created an alert. `job_gate` is a `CONFIRMED_NEWSLETTER_SOURCES` entry
 * (services/newsletterSubscribers.ts:187) — single opt-in, no double
 * confirmation needed — so these subscribers are already mailable.
 *
 * The backfilled alert is deliberately near-empty (`keywords: []`,
 * `locations: []`, `cantonFilter: null`): `buildAlertProfile`
 * (services/jobAlertMatching.mjs:148-208) already pulls `job_category`,
 * `job_search_query`, `job_slug`, `sector_interest`, `job_location` straight
 * off the linked `newsletter_subscribers/{email}` doc via soft tokens +
 * sector + preferred-location signals — duplicating them onto the alert
 * would be redundant. Setting `keywords`/`cantonFilter` would instead turn
 * them into HARD filters (scoreJobForAlert lines 342-348, 377-384), which is
 * NOT what an inferred, non-explicit alert should do — a subscriber with a
 * sparse job_category could end up matching nothing.
 *
 * Idempotent: fixed alert id `backfill-jobgate` per subscriber, `merge:true`.
 * Safe to re-run.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
 *   node scripts/backfill-jobalerts-from-newsletter.mjs [--dry-run]
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isNewsletterExcluded } from '../services/emailSuppression.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
export const MAX_ALERTS_PER_USER = 3; // services/jobAlertService.ts:68
export const ALERT_ID = 'backfill-jobgate';

export function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

/**
 * Pure eligibility check for one `newsletter_subscribers` doc.
 * @returns {'invalid-email'|'suppressed'|'no-signal'|null} skip reason, null = eligible.
 */
export function shouldSkipSubscriber(email, data) {
  if (!email || !email.includes('@')) return 'invalid-email';
  if (isNewsletterExcluded(data?.status)) return 'suppressed';
  const category = String(data?.job_category || '').trim();
  const location = String(data?.job_location || '').trim();
  if (!category && !location) return 'no-signal';
  return null;
}

/**
 * Pure payload builder — no Firestore I/O, no serverTimestamp (caller stamps
 * `createdAt`/`backfilled_at`/`updated_at` after this returns, so the shape
 * stays testable without mocking firebase-admin).
 */
export function buildAlertPayload(email, data, existingBackfill) {
  return {
    email,
    userId: data?.user_id || null,
    keywords: [],
    locations: [],
    contractTypes: [],
    sectors: [],
    cantonFilter: null,
    frequency: 'daily',
    locale: data?.preferred_locale || data?.locale || 'it',
    sourceJobSlug: data?.job_slug || null,
    sourceJobUrl: null,
    sourceJobTitle: null,
    specificJobId: null,
    specificCompanyKey: null,
    active: true,
    matchCount: existingBackfill?.matchCount || 0,
    lastMatchedAt: existingBackfill?.lastMatchedAt || null,
    // Provenance — lets a future audit tell inferred alerts apart from
    // explicit ones without needing a separate collection.
    backfilled_from: 'newsletter_subscribers_job_gate',
  };
}

let _db = null;
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

async function main() {
  const db = await getFirestoreAdmin();
  const { FieldValue } = await import('firebase-admin/firestore');

  console.log(`🔎 Querying newsletter_subscribers where source_channel == 'job_gate'${DRY_RUN ? ' (dry-run)' : ''}`);
  const snap = await db.collection('newsletter_subscribers').where('source_channel', '==', 'job_gate').get();
  console.log(`   Found ${snap.size} job_gate subscribers`);

  const counts = { created: 0, 'invalid-email': 0, suppressed: 0, 'no-signal': 0, capped: 0 };

  for (const doc of snap.docs) {
    const data = doc.data();
    const email = normalizeEmail(data.email || doc.id);

    const skipReason = shouldSkipSubscriber(email, data);
    if (skipReason) {
      counts[skipReason]++;
      continue;
    }

    const subscriberRef = db.collection('job_alert_subscribers').doc(email);
    const alertsRef = subscriberRef.collection('alerts');
    const existingActive = await alertsRef.where('email', '==', email).where('active', '==', true).get();
    const existingBackfillDoc = existingActive.docs.find((d) => d.id === ALERT_ID);
    if (!existingBackfillDoc && existingActive.size >= MAX_ALERTS_PER_USER) {
      counts.capped++;
      continue;
    }

    const alertPayload = buildAlertPayload(email, data, existingBackfillDoc?.data());

    if (DRY_RUN) {
      console.log(` [dry] ${existingBackfillDoc ? 'merge' : 'create'} job_alert_subscribers/${email}/alerts/${ALERT_ID} (category=${data.job_category || '∅'}, location=${data.job_location || '∅'})`);
    } else {
      const parentPayload = {
        email,
        userId: alertPayload.userId,
        locale: alertPayload.locale,
        updated_at: FieldValue.serverTimestamp(),
        created_at: FieldValue.serverTimestamp(),
      };
      const existingParent = await subscriberRef.get();
      if (existingParent.exists) delete parentPayload.created_at;
      await subscriberRef.set(parentPayload, { merge: true });

      await alertsRef.doc(ALERT_ID).set(
        {
          ...alertPayload,
          backfilled_at: FieldValue.serverTimestamp(),
          ...(existingBackfillDoc ? {} : { createdAt: FieldValue.serverTimestamp() }),
        },
        { merge: true },
      );
    }
    counts.created++;
  }

  console.log('');
  console.log(` ✅ Alerts created/updated : ${counts.created}${DRY_RUN ? ' (dry)' : ''}`);
  console.log(` ⏭️  Skipped (suppressed)   : ${counts.suppressed}`);
  console.log(` ⏭️  Skipped (no signal)    : ${counts['no-signal']}`);
  console.log(` ⏭️  Skipped (at cap)       : ${counts.capped}`);
  console.log(` ⏭️  Skipped (invalid email): ${counts['invalid-email']}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Backfill failed:', err);
      process.exit(1);
    });
}
