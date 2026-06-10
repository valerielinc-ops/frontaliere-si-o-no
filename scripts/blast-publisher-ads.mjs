#!/usr/bin/env node
/**
 * blast-publisher-ads.mjs — targeted newsletter blast for newly-paid SPONSORED ads.
 *
 * For each sponsored ad that is paid and not yet blasted, finds the matching
 * newsletter subscribers (services/publisherBlastMatch.mjs) and emails them a
 * short alert, then stamps `blastSentAt` on the ad (idempotency — never blast twice).
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

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function main() {
  const { admin, db } = await initDb();

  // Sponsored + paid + not yet blasted.
  const snap = await db
    .collection('publisher_jobs')
    .where('tier', '==', 'sponsored')
    .where('status', '==', 'paid')
    .get();
  const ads = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((a) => !a.blastSentAt);

  if (ads.length === 0) {
    console.log('[blast] no un-blasted sponsored paid ads — nothing to do.');
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
    const audience = matchSubscribersForAd(ad, subscribers, { minScore: 5, max: PER_AD_CAP });
    console.log(`[blast] ad "${ad.title}" (${ad.id}) → ${audience.length} matched subscriber(s)`);
    if (!SEND) continue;
    if (audience.length === 0) {
      await db.collection('publisher_jobs').doc(ad.id).set(
        { blastSentAt: admin.firestore.FieldValue.serverTimestamp(), blastCount: 0 },
        { merge: true },
      );
      continue;
    }

    const subject = `Nuova offerta: ${ad.title}`;
    const adHtml = (email) =>
      `<h2>${esc(ad.title)}</h2>` +
      `<p>${esc(ad.company?.name || '')}${ad.sector ? ' · ' + esc(ad.sector) : ''}</p>` +
      `<p><a href="${SITE}/lavoro">Vedi l'offerta su Frontaliere Ticino</a></p>` +
      `<hr><p style="font-size:12px;color:#666">Ricevi questa email perché corrisponde alle tue ricerche di lavoro su Frontaliere Ticino. ` +
      `<a href="${SITE}/?action=unsubscribe&email=${encodeURIComponent(email)}">Disiscriviti</a>.</p>`;

    let adSent = 0;
    let interrupted = false;
    for (const r of audience) {
      if (sentTotal >= PER_RUN_CAP) {
        console.warn(`[blast] per-run cap ${PER_RUN_CAP} reached — pausing ad ${ad.id} (resumes next run).`);
        interrupted = true;
        break;
      }
      try {
        const { error } = await resend.emails.send({ from: FROM_EMAIL, to: r.email, subject, html: adHtml(r.email) });
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
