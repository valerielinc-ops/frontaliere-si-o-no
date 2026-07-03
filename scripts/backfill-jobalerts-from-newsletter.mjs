#!/usr/bin/env node
/**
 * Backfill `job_alert_subscribers/{email}/alerts/backfill-newsletter` from
 * ALL `newsletter_subscribers` docs, regardless of `source_channel`.
 *
 * One-off batch pass over EXISTING docs. Going forward, new docs are covered
 * automatically by the `onDocumentWritten` trigger in
 * `functions/index.js` → `functions/src/jobAlertBackfillTrigger.js`, which
 * shares the exact same decision logic via `functions/src/jobAlertBackfillCore.js`
 * (re-exported here through `scripts/lib/jobalert-backfill-core.mjs` so both
 * paths can never drift apart).
 *
 * Rationale: a subscriber who left a `job_category`/`job_location` signal
 * behind — no matter which CTA captured their email (job-detail unlock,
 * social sign-in on the job board, One Tap, generic footer signup, …) — is
 * signalling job-search intent even though they never explicitly created an
 * alert. Channel does not need to gate this: a live count against
 * `newsletter_subscribers` (2026-07-03, 5429 docs) showed the field-based
 * signal check already discriminates correctly per channel without any
 * per-channel branching — `job_gate` (753 eligible), `auth_google` (993),
 * `auth_linkedin` (466) carry real signal; generic/unrelated CTAs
 * (`analysis_gate`, `post_calc_cta`, `newsletter_page`, `lead_magnet`,
 * `calculator_paywall`, `offerwall`, `popup`'s pending majority, no-channel
 * docs) self-filter to ~0 because they never populate `job_category`/
 * `job_location` at signup. `tax_calendar_*`/`chatbot_*`/`job_board_auth`
 * source_channel values are dead code paths (`normalizeSourceChannel`,
 * services/newsletterSubscribers.ts, collapses them into `auth_google`/
 * `auth_facebook`/`job_gate` before storage) — 0 live docs, nothing to skip.
 * A location-only fallback tier (`location_interest`/`geo_city`, see
 * `jobAlertBackfillCore.js`) adds ~5 more — most no-signal docs have no geo
 * data either, but it's a correct zero-cost catch-all. A 3rd tier derives
 * signal from the `private/personalization` subcollection (`viewedJobs[]`,
 * `filterUsage`) for subscribers still unresolved after tiers 1/2 — read
 * lazily, only for the `no-signal` remainder, via `resolveSignalTier`.
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
import {
  MAX_ALERTS_PER_USER,
  ALERT_ID,
  normalizeEmail,
  shouldSkipSubscriber,
  buildAlertPayload,
  resolveSignalTier,
} from './lib/jobalert-backfill-core.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

export { MAX_ALERTS_PER_USER, ALERT_ID, normalizeEmail, shouldSkipSubscriber, buildAlertPayload, resolveSignalTier };

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

    let skipReason = shouldSkipSubscriber(email, data);
    // Lazy tier-3 lookup: only pay for the extra `private/personalization`
    // read when the flat fields alone resolve nothing — cheap for the
    // majority who already carry job_category/location_interest, an extra
    // read only for the "no-signal" remainder (see resolveSignalTier).
    let personalization = null;
    if (skipReason === 'no-signal') {
      const personalizationSnap = await db
        .collection('newsletter_subscribers')
        .doc(email)
        .collection('private')
        .doc('personalization')
        .get();
      if (personalizationSnap.exists) {
        personalization = personalizationSnap.data();
        skipReason = shouldSkipSubscriber(email, data, personalization);
      }
    }
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

    const alertPayload = buildAlertPayload(email, data, existingBackfillDoc?.data(), personalization);
    const { patch } = resolveSignalTier(data, personalization);
    byChannel[channel].created++;

    if (DRY_RUN) {
      console.log(` [dry] ${existingBackfillDoc ? 'merge' : 'create'} job_alert_subscribers/${email}/alerts/${ALERT_ID} (${alertPayload.backfilled_from})`);
    } else {
      const parentPayload = {
        email,
        userId: alertPayload.userId,
        locale: alertPayload.locale,
        ...(patch || {}),
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
