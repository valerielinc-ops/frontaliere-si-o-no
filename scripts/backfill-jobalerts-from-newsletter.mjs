#!/usr/bin/env node
/**
 * Backfill `job_alert_subscribers/{email}/alerts/backfill-newsletter` from
 * ALL `newsletter_subscribers` docs, regardless of `source_channel`.
 *
 * Rationale: a subscriber who left a `job_category`/`job_location` signal
 * behind — no matter which CTA captured their email (job-detail unlock,
 * social sign-in on the job board, One Tap, generic footer signup, …) — is
 * signalling job-search intent even though they never explicitly created an
 * alert. Channel does not need to gate this: a live count against
 * `newsletter_subscribers` (2026-07, 5429 docs) showed the field-based signal
 * check below already discriminates correctly per channel without any
 * per-channel branching — `job_gate` (753 eligible), `auth_google` (993),
 * `auth_linkedin` (466) carry real signal; generic/unrelated CTAs
 * (`analysis_gate`, `post_calc_cta`, `newsletter_page`, `lead_magnet`,
 * `calculator_paywall`, `offerwall`, `popup`'s pending majority, no-channel
 * docs) self-filter to ~0 because they never populate `job_category`/
 * `job_location` at signup. `tax_calendar_*`/`chatbot_*`/`job_board_auth`
 * source_channel values are dead code paths (`normalizeSourceChannel`,
 * services/newsletterSubscribers.ts, collapses them into `auth_google`/
 * `auth_facebook`/`job_gate` before storage) — 0 live docs, nothing to skip.
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
 * Idempotent: fixed alert id `backfill-newsletter` per subscriber,
 * `merge:true`. Re-running never reactivates an alert the user disabled
 * (`deleteAlert`, services/jobAlertService.ts:269-275, sets `active:false` +
 * `unsubscribed_at`) — the payload only defaults `active:true` on first
 * creation and otherwise carries the existing doc's `active` forward as-is.
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
export const ALERT_ID = 'backfill-newsletter';

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
 *
 * `existingBackfill` is the full prior `backfill-newsletter` doc data (or
 * null on first creation). Its `active` flag is carried forward as-is so a
 * re-run never undoes a user's explicit unsubscribe (`deleteAlert` sets
 * `active: false`) — only a brand-new doc defaults to `active: true`.
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
    active: existingBackfill ? existingBackfill.active !== false : true,
    matchCount: existingBackfill?.matchCount || 0,
    lastMatchedAt: existingBackfill?.lastMatchedAt || null,
    // Provenance — lets a future audit tell inferred alerts apart from
    // explicit ones, and see which signup channel triggered it.
    backfilled_from: `newsletter_subscribers:${data?.source_channel || 'unknown'}`,
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

  console.log(`🔎 Querying all newsletter_subscribers${DRY_RUN ? ' (dry-run)' : ''}`);
  const snap = await db.collection('newsletter_subscribers').get();
  console.log(`   Found ${snap.size} subscribers`);

  const counts = { created: 0, 'invalid-email': 0, suppressed: 0, 'no-signal': 0, capped: 0 };
  const byChannel = {};

  for (const doc of snap.docs) {
    const data = doc.data();
    const email = normalizeEmail(data.email || doc.id);
    const channel = data.source_channel || 'unknown';
    byChannel[channel] = byChannel[channel] || { created: 0, skipped: 0 };

    const skipReason = shouldSkipSubscriber(email, data);
    if (skipReason) {
      counts[skipReason]++;
      byChannel[channel].skipped++;
      continue;
    }

    const subscriberRef = db.collection('job_alert_subscribers').doc(email);
    const alertsRef = subscriberRef.collection('alerts');
    // Read every alert doc (not just active:true) so a user-disabled
    // backfill-newsletter doc is still found — otherwise it would look
    // "missing" and get silently recreated as active on re-run.
    const existingAlerts = await alertsRef.get();
    const existingBackfillDoc = existingAlerts.docs.find((d) => d.id === ALERT_ID);
    const activeOtherCount = existingAlerts.docs.filter((d) => d.id !== ALERT_ID && d.data().active === true).length;
    if (!existingBackfillDoc && activeOtherCount >= MAX_ALERTS_PER_USER) {
      counts.capped++;
      byChannel[channel].skipped++;
      continue;
    }

    const alertPayload = buildAlertPayload(email, data, existingBackfillDoc?.data());
    byChannel[channel].created++;

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
  console.log('');
  console.log(' By source_channel (created/skipped):');
  for (const [channel, c] of Object.entries(byChannel).sort((a, b) => b[1].created - a[1].created)) {
    console.log(`   ${channel.padEnd(20)} ${String(c.created).padStart(5)} / ${c.skipped}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Backfill failed:', err);
      process.exit(1);
    });
}
