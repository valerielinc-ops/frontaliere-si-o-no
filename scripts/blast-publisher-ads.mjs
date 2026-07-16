#!/usr/bin/env node
/**
 * blast-publisher-ads.mjs — targeted newsletter blast for newly-paid PAID ads
 * (tier `sponsored` or `azienda`).
 *
 * For each paid ad (sponsored OR azienda) not yet blasted, finds the matching
 * newsletter subscribers (services/publisherBlastMatch.mjs) and emails them a
 * short alert, then stamps `blastSentAt` on the ad (idempotency — never blast twice).
 *
 * Azienda is the Piano Azienda tier (CHF 299/mese) whose perks include
 * "priorità newsletter" — it MUST receive this blast just like sponsored.
 *
 * Free tier ads are NEVER blasted (no newsletter perk). Respects a per-run total
 * cap (free-tier ESP safety). Dry-run by default; --send actually emails.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node scripts/blast-publisher-ads.mjs            # dry-run (logs audience)
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node scripts/blast-publisher-ads.mjs --send      # send (CI only)
 *
 * Auth: Firebase Admin (applicationDefault); RESEND_API_KEY via Remote Config
 * (load-rc-env.mjs in CI, or env).
 */

import { matchSubscribersForAd } from '../services/publisherBlastMatch.mjs';
import { OWNER_EMAIL, isCanaryJob } from './lib/canaryAd.mjs';
import { buildBlastEmail } from '../services/publisherBlastEmail.mjs';
import { slugifyPublisher, truncatePublisherSlug, distinctLocations } from './lib/publisherJobProjection.mjs';
import { makeAuthenticatedActionUrl } from '../services/newsletterUrls.mjs';

const SEND = process.argv.includes('--send');
const PER_AD_CAP = 200;   // max recipients per ad
const PER_RUN_CAP = 300;  // free-tier ESP safety across the whole run
const FROM_EMAIL = 'Frontaliere Ticino <confirmation@frontaliereticino.ch>';
const SITE = 'https://frontaliereticino.ch';

async function initDb() {
  const admin = await import('firebase-admin');
  const a = admin.default || admin;
  if (!a.apps?.length) {
    a.initializeApp({
      credential: a.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  return { admin: a, db: a.firestore() };
}

async function main() {
  const { admin, db } = await initDb();

  // Paid (sponsored OR azienda) + not yet blasted. Both paid tiers carry the
  // newsletter-blast perk; azienda would be silently excluded by a bare
  // tier=='sponsored' gate (its "priorità newsletter" perk never delivered).
  const snap = await db
    .collection('publisher_jobs')
    .where('tier', 'in', ['sponsored', 'azienda'])
    .where('status', '==', 'paid')
    .get();
  const ads = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((a) => !a.blastSentAt);

  if (ads.length === 0) {
    console.log('[blast] no un-blasted paid ads (sponsored/azienda) — nothing to do.');
    return;
  }

  const subsSnap = await db.collection('newsletter_subscribers').get();
  const subscribers = subsSnap.docs.filter((d) => d.id !== '_meta_').map((d) => d.data());
  console.log(`[blast] ${ads.length} ad(s), ${subscribers.length} subscribers. mode=${SEND ? 'SEND' : 'DRY-RUN'}`);

  let resend = null;
  if (SEND) {
    // CI runs `node scripts/load-rc-env.mjs` first → RESEND_API_KEY is in env.
    const key = process.env.RESEND_API_KEY || '';
    if (!key) {
      console.error('[blast] RESEND_API_KEY missing (run load-rc-env first) — aborting send.');
      process.exit(1);
    }
    const { Resend } = await import('resend');
    resend = new Resend(key);
  }

  let sentTotal = 0;
  for (const ad of ads) {
    // Canary gate: a broadcast-restricted ad blasts to the OWNER ONLY (forced,
    // regardless of subscription/match), so the sponsor-blast path can be
    // verified end-to-end without emailing real subscribers a test listing.
    const audience = isCanaryJob(ad)
      ? [{ email: OWNER_EMAIL, locale: ad.sourceLang || 'it', score: 999 }]
      : matchSubscribersForAd(ad, subscribers, { minScore: 5, max: PER_AD_CAP });
    console.log(
      `[blast] ad "${ad.title}" (${ad.id})${isCanaryJob(ad) ? ' [CANARY → owner only]' : ''} → ${audience.length} matched subscriber(s)`,
    );
    if (!SEND) continue;
    if (audience.length === 0) {
      await db.collection('publisher_jobs').doc(ad.id).set(
        { blastSentAt: admin.firestore.FieldValue.serverTimestamp(), blastCount: 0 },
        { merge: true },
      );
      continue;
    }

    // Link to the SPECIFIC ad page (first location), slug derived exactly like
    // publisherJobProjection so it matches the emitted /lavoro/<slug>/ page —
    // not the generic /lavoro alias the old bare email used. Reuses the SAME
    // distinctLocations() the projection uses (handles bare-string locations and
    // skips empty entries) so the slug provably matches the live page; falls
    // back to the job-board listing if the ad somehow has no usable location.
    const firstLocationLabel = distinctLocations(ad.locations)[0]?.text || '';
    const adBaseSlug = truncatePublisherSlug(
      slugifyPublisher(`${ad.title}-${firstLocationLabel}-${ad.company?.name || ''}`),
    );
    const BLAST_UTM = 'utm_source=newsletter&utm_medium=email&utm_campaign=sponsored_blast';
    const adUrlFor = (locale) => {
      const prefix = locale === 'it' ? '' : `/${locale}`;
      return `${SITE}${prefix}/lavoro/${adBaseSlug}/?${BLAST_UTM}`;
    };

    let adSent = 0;
    let interrupted = false;
    for (const r of audience) {
      if (sentTotal >= PER_RUN_CAP) {
        console.warn(`[blast] per-run cap ${PER_RUN_CAP} reached — pausing ad ${ad.id} (resumes next run).`);
        interrupted = true;
        break;
      }
      const locale = ['it', 'en', 'de', 'fr'].includes(r.locale) ? r.locale : 'it';
      const { subject, html } = buildBlastEmail({
        ad,
        recipientEmail: r.email,
        locale,
        adUrl: adUrlFor(locale),
        unsubscribeUrl: makeAuthenticatedActionUrl('unsubscribe', r.email),
        // Same label the CTA slug is built from → card city and linked page agree.
        locationLabel: firstLocationLabel,
      });
      try {
        const { error } = await resend.emails.send({ from: FROM_EMAIL, to: r.email, subject, html });
        if (!error) { adSent++; sentTotal++; }
      } catch (e) {
        console.error(`[blast] send failed to ${r.email}: ${e?.message || e}`);
      }
    }
    // Only mark done when the FULL audience was processed — otherwise the next run
    // re-sends to everyone (acceptable dup risk) rather than dropping the remainder.
    if (!interrupted) {
      await db.collection('publisher_jobs').doc(ad.id).set(
        { blastSentAt: admin.firestore.FieldValue.serverTimestamp(), blastCount: adSent },
        { merge: true },
      );
    }
    console.log(`[blast] ad ${ad.id}: sent ${adSent}${interrupted ? ' (incomplete — not marked done)' : ''}`);
    if (sentTotal >= PER_RUN_CAP) break;
  }

  console.log(`[blast] done. total sent: ${sentTotal}`);
}

main().catch((err) => {
  console.error('[blast] FATAL:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
