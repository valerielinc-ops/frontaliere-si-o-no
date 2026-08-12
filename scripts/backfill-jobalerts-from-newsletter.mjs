#!/usr/bin/env node
/**
 * REPORT ONLY — THIS SCRIPT CANNOT CREATE AN ALERT (#5705).
 *
 * It used to write `job_alert_subscribers/{email}/alerts/backfill-newsletter`
 * for every `newsletter_subscribers` doc carrying an inferred job signal. That
 * pass, plus the two live triggers that share its logic, produced 7.167 alerts
 * against 578 created by an actual person, 6.308 of them still active on
 * 2026-08-12 — a daily mailing built out of a weekly-newsletter consent, and an
 * nLPD complaint.
 *
 * Two independent things now stop it, so that neither one alone is load-bearing:
 *
 *  1. the shared consent gate — `shouldSkipSubscriber` requires an affirmative,
 *     job-alert-scoped consent (`hasAffirmativeJobAlertConsent`,
 *     functions/src/jobAlertBackfillCore.js), which nothing in this codebase
 *     records today, so every subscriber returns `'no-job-alert-consent'`;
 *  2. **by construction, here**: not one Firestore write call of any kind is
 *     left in this file — no document write, no batch, no server timestamp.
 *     Relaxing the gate, or calling this script with any flag whatsoever,
 *     cannot resurrect 7.000 alerts, because the code that wrote them no
 *     longer exists. `tests/backfill-jobalerts-from-newsletter.test.ts` pins
 *     that absence token by token, so it cannot creep back unnoticed.
 *
 * The file keeps its historical name because three docblocks and one test
 * reference it, and a rename would be churn without a reader; the first line
 * says what it does now.
 *
 * What it still does, and why that is worth keeping: it counts the population
 * per skip reason. `no-job-alert-consent` is, by the ordering in
 * `shouldSkipSubscriber`, exactly the set that WOULD have been enrolled under
 * the old rule — the live size of the travaso — and `consent names job alerts`
 * measures one of the three questions issue #5705 asks the owner to decide on.
 * Nothing here reads the `alerts` subcollection: the fate of the 6.308 already
 * created is the owner's decision, not this script's.
 *
 * Historic rationale for the tiers, preserved because the tier code is still
 * what classifies a subscriber (it just no longer authorises anything):
 * a subscriber who left a `job_category`/`job_location` signal
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
 * lazily, gated on `getSignalTier` (tiers 1/2 only, NOT the 4th URL
 * fallback below — a job-board URL alone must never skip this read, since
 * `resolveSignalTier` prefers the richer tier-3 signal over tier 4 when
 * both are available). A 4th tier derives a canton from the job-board URL
 * the subscriber landed on (`consent_source_url`/`source_page`) when tiers
 * 1/2/3 all found nothing — see `jobAlertBackfillCore.js` for the full
 * tier rationale.
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
 * Usage — read-only, and there is no flag that changes that:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
 *   node scripts/backfill-jobalerts-from-newsletter.mjs
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  MAX_ALERTS_PER_USER,
  ALERT_ID,
  normalizeEmail,
  getSignalTier,
  shouldSkipSubscriber,
  consentNamesJobAlerts,
  hasAffirmativeJobAlertConsent,
  buildAlertPayload,
  resolveSignalTier,
} from './lib/jobalert-backfill-core.mjs';

export {
  MAX_ALERTS_PER_USER,
  ALERT_ID,
  normalizeEmail,
  getSignalTier,
  shouldSkipSubscriber,
  consentNamesJobAlerts,
  hasAffirmativeJobAlertConsent,
  buildAlertPayload,
  resolveSignalTier,
};

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

  console.log('🔎 Querying all newsletter_subscribers (report only — this script never writes)');
  const snap = await db.collection('newsletter_subscribers').get();
  console.log(`   Found ${snap.size} subscribers`);

  const counts = {
    eligible: 0,
    'invalid-email': 0,
    suppressed: 0,
    'no-signal': 0,
    'no-job-alert-consent': 0,
  };
  // The consent question issue #5705 puts to the owner, measured on the
  // subscriber side: how many were ever told, in the formula stored on their
  // own document, that job alerts were part of it — and of those, how many
  // actually opted in affirmatively to a notice that was displayed.
  const consent = { namesJobAlerts: 0, affirmative: 0, noConsentTextAtAll: 0 };
  const byChannel = {};

  for (const doc of snap.docs) {
    const data = doc.data();
    const email = normalizeEmail(data.email || doc.id);
    const channel = data.source_channel || 'unknown';
    byChannel[channel] = byChannel[channel] || { eligible: 0, skipped: 0 };

    if (!data.consent_text) consent.noConsentTextAtAll++;
    if (consentNamesJobAlerts(data.consent_text)) consent.namesJobAlerts++;
    if (hasAffirmativeJobAlertConsent(data)) consent.affirmative++;

    // Lazy tier-3 lookup: only pay for the extra `private/personalization`
    // read when tiers 1/2 (flat job_category/location_interest/geo_city)
    // alone resolve nothing — cheap for the majority who already carry
    // those fields. Gated on `getSignalTier` (tiers 1/2 ONLY), not on
    // `shouldSkipSubscriber`/`resolveSignalTier` — those also resolve tier
    // 4 (URL) from the same flat data, and tier 4 alone finding a canton
    // must never skip this read: resolveSignalTier checks tier 3 before
    // tier 4, so a subscriber with both a job-board URL AND real browsing
    // data (job_category/sector, not just canton) deserves the richer
    // signal, not just whatever tier 4 found first.
    let personalization = null;
    if (getSignalTier(data) === 'none') {
      const personalizationSnap = await db
        .collection('newsletter_subscribers')
        .doc(email)
        .collection('private')
        .doc('personalization')
        .get();
      if (personalizationSnap.exists) {
        personalization = personalizationSnap.data();
      }
    }
    const skipReason = shouldSkipSubscriber(email, data, personalization);
    if (skipReason) {
      counts[skipReason]++;
      byChannel[channel].skipped++;
      continue;
    }

    // Eligible under BOTH the tier and the consent gate. Nothing is written
    // here — see the header: the write path was removed, not disabled.
    // `buildAlertPayload` is still called so the report can name the tier the
    // alert WOULD have carried, which is what makes this line auditable.
    // The address is deliberately NOT printed: a report about who did not
    // consent to being mailed is a poor place to put a list of addresses.
    const alertPayload = buildAlertPayload(email, data, null, personalization);
    console.log(`   would qualify for ${ALERT_ID} (${alertPayload.backfilled_from}, channel ${channel})`);
    byChannel[channel].eligible++;
    counts.eligible++;
  }

  console.log('');
  console.log(` ✅ Eligible (tier + consent) : ${counts.eligible}  — nothing was written`);
  console.log(` ⏭️  Skipped (no job-alert consent) : ${counts['no-job-alert-consent']}  ← the travaso this guard stops`);
  console.log(` ⏭️  Skipped (suppressed)     : ${counts.suppressed}`);
  console.log(` ⏭️  Skipped (no signal)      : ${counts['no-signal']}`);
  console.log(` ⏭️  Skipped (invalid email)  : ${counts['invalid-email']}`);
  console.log('');
  console.log(' Consent coverage on newsletter_subscribers (issue #5705):');
  console.log(`   consent_text names the job-alert channel : ${consent.namesJobAlerts}`);
  console.log(`   affirmative job-alert consent on record  : ${consent.affirmative}`);
  console.log(`   no consent_text stored at all            : ${consent.noConsentTextAtAll}`);
  console.log('');
  console.log(' By source_channel (eligible/skipped):');
  for (const [channel, c] of Object.entries(byChannel).sort((a, b) => b[1].eligible - a[1].eligible)) {
    console.log(`   ${channel.padEnd(20)} ${String(c.eligible).padStart(5)} / ${c.skipped}`);
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
