#!/usr/bin/env node
/**
 * seed-canary-publisher-ad.mjs — create (or refresh) the owner's CANARY sponsored
 * publisher ad + a job-specific job-alert, directly via Firebase Admin (no Stripe).
 *
 * The canary ad is a REAL sponsored listing: it enters the normal on-site funnel
 * (listing, search, SEO page, in-page apply) exactly like a paid ad — but every
 * BROADCAST surface (sponsor blast, weekly newsletter, job alerts) is gated to
 * the owner only by the `canary: true` flag (scripts/lib/canaryAd.mjs). This lets
 * us verify the entire paid-ad loop end-to-end without emailing real users.
 *
 * Ownership: the doc's `publisherUid` is the owner's real Firebase Auth uid, so
 * ONLY the owner can edit it from the dashboard (firestore.rules). Apply mode is
 * forward_email to the owner, so any real application also lands with the owner.
 *
 * Idempotent: fixed doc id (CANARY_AD_ID) and fixed alert id → re-running updates
 * in place. The 30-min publisher-jobs-sync projects it into the slice next run.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     node scripts/seed-canary-publisher-ad.mjs            # dry-run (prints plan)
 *   GOOGLE_APPLICATION_CREDENTIALS=... node scripts/seed-canary-publisher-ad.mjs --apply
 *   ... --remove                                           # delete canary ad + alert
 *
 * Auth: Firebase Admin (applicationDefault). Owner email: CANARY_OWNER_EMAIL or
 * the default in scripts/lib/canaryAd.mjs.
 */

import { OWNER_EMAIL } from './lib/canaryAd.mjs';
import { slugifyPublisher, truncatePublisherSlug } from './lib/publisherJobProjection.mjs';

const APPLY = process.argv.includes('--apply');
const REMOVE = process.argv.includes('--remove');

const CANARY_AD_ID = 'canary-owner-demo';
const CANARY_ALERT_ID = 'canary-owner-demo-jobalert';
const SITE = 'https://frontaliereticino.ch';

// One Ticino location → one billable unit, one /lavoro page.
const LOCATION = { label: 'Lugano', canton: 'TI' };

const TITLE = 'Specialista Marketing Digitale (Canary Test)';
const COMPANY_NAME = 'Frontaliere Ticino';

// ≥50 words plain description (server-side thin-content gate). Mirrored below as
// markdown to also exercise the sponsored rich-description rendering.
const DESCRIPTION = [
  'Annuncio dimostrativo interno usato per verificare end-to-end il funnel degli',
  'annunci sponsorizzati: pagina dedicata, ricerca, posizionamento in cima al',
  'listino, candidature in-house, dati strutturati SEO, blast newsletter, job',
  'alert e job alert specifica per questo annuncio. Cerchiamo una figura motivata',
  'per coordinare campagne digitali, analizzare metriche e ottimizzare la',
  'comunicazione verso i frontalieri del Canton Ticino. Questo annuncio e visibile',
  'pubblicamente ma le sue email vengono inviate esclusivamente al proprietario',
  'del sito per non disturbare gli utenti reali durante i test.',
].join(' ');

const DESCRIPTION_MD = [
  '## Chi siamo',
  'Annuncio canary del team Frontaliere Ticino per validare il giro completo degli annunci sponsorizzati.',
  '',
  '## Responsabilita',
  '- Coordinare le campagne digitali rivolte ai frontalieri',
  '- Analizzare metriche di traffico e conversione',
  '- Ottimizzare la comunicazione multicanale',
  '',
  '## Requisiti',
  '- Esperienza in **marketing digitale**',
  '- Ottime capacita analitiche e di scrittura',
  '',
  '## Offriamo',
  '- Ambiente dinamico e da remoto',
  '- Progetti ad alto impatto',
].join('\n');

async function initAdmin() {
  const admin = await import('firebase-admin');
  const a = admin.default || admin;
  if (!a.apps?.length) {
    a.initializeApp({
      credential: a.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  return a;
}

async function main() {
  const admin = await initAdmin();
  const db = admin.firestore();

  // Resolve the owner's real Firebase Auth uid (gates edit permission).
  let ownerUid;
  try {
    const user = await admin.auth().getUserByEmail(OWNER_EMAIL);
    ownerUid = user.uid;
  } catch (e) {
    console.error(`❌ Could not resolve owner uid for ${OWNER_EMAIL}: ${e?.message || e}`);
    console.error('   (Auth user must exist — the owner has signed in at least once.)');
    process.exit(1);
  }

  const baseSlug = truncatePublisherSlug(slugifyPublisher(`${TITLE}-${LOCATION.label}-${COMPANY_NAME}`));
  const projectedJobId = `pub-${CANARY_AD_ID}-${slugifyPublisher(LOCATION.label)}`;
  const liveUrl = `${SITE}/lavoro/${baseSlug}/`;

  if (REMOVE) {
    console.log(`Plan: DELETE publisher_jobs/${CANARY_AD_ID} and the owner's canary job-alert.`);
    if (APPLY) {
      await db.collection('publisher_jobs').doc(CANARY_AD_ID).delete();
      await db.collection('job_alert_subscribers').doc(OWNER_EMAIL)
        .collection('alerts').doc(CANARY_ALERT_ID).delete();
      console.log('✅ Removed canary ad + alert. Next sync drops it from the slice.');
    } else {
      console.log('(dry-run — pass --apply to delete)');
    }
    return;
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const adDoc = {
    publisherUid: ownerUid,
    tier: 'sponsored',
    status: 'paid',            // Admin SDK bypasses rules; live at next sync.
    canary: true,              // Broadcast-restricted (owner-only) — the whole point.
    featured: true,            // Top-of-listing placement (verify ranking).
    title: TITLE,
    description: DESCRIPTION,
    descriptionMd: DESCRIPTION_MD,
    sourceLang: 'it',
    company: {
      name: COMPANY_NAME,
      companyKey: 'frontaliere-ticino',
      domain: 'frontaliereticino.ch',
      logoUrl: 'https://cdn.frontaliereticino.ch/images/brands/confederazione-ticino.png',
    },
    locations: [{
      label: LOCATION.label,
      canton: LOCATION.canton,
      address: { addressLocality: LOCATION.label, addressRegion: LOCATION.canton, addressCountry: 'CH', postalCode: '6900' },
    }],
    category: 'marketing',
    sector: 'Marketing',
    employmentType: 'FULL_TIME',
    contractType: 'permanent',
    salaryMin: 70000,
    salaryMax: 90000,
    currency: 'CHF',
    // forward_email → in-house apply form; applications forwarded to the owner.
    apply: { mode: 'forward_email', email: OWNER_EMAIL },
    // Pre-stamp blastSentAt:null so the (now-gated) sponsor blast can pick it up.
    blastSentAt: null,
    createdAt: now,
    updatedAt: now,
    paidAt: now,
  };

  const alertDoc = {
    email: OWNER_EMAIL,
    userId: ownerUid,
    keywords: [],
    locations: [],
    contractTypes: [],
    sectors: [],
    cantonFilter: null,
    frequency: 'daily',
    // Deliberate operator-picked cadence, not inferred — pin it so the
    // engagement-tier engine never re-tiers the canary away from daily.
    frequencyOverride: true,
    locale: 'it',
    // Job-specific scope: this alert fires ONLY for the canary job.
    specificJobId: projectedJobId,
    specificCompanyKey: null,
    sourceJobSlug: baseSlug,
    sourceJobUrl: liveUrl,
    sourceJobTitle: TITLE,
    active: true,
    createdAt: now,
    lastMatchedAt: null,
    matchCount: 0,
  };

  console.log('Plan:');
  console.log(`  owner            : ${OWNER_EMAIL} (uid ${ownerUid})`);
  console.log(`  publisher_jobs/${CANARY_AD_ID}: sponsored+paid+canary+featured`);
  console.log(`  projected job id : ${projectedJobId}`);
  console.log(`  live URL         : ${liveUrl}`);
  console.log(`  job-specific alert: job_alert_subscribers/${OWNER_EMAIL}/alerts/${CANARY_ALERT_ID} → specificJobId=${projectedJobId}`);

  if (!APPLY) {
    console.log('\n(dry-run — pass --apply to write to Firestore)');
    return;
  }

  await db.collection('publisher_jobs').doc(CANARY_AD_ID).set(adDoc, { merge: true });
  await db.collection('job_alert_subscribers').doc(OWNER_EMAIL)
    .set({ email: OWNER_EMAIL, userId: ownerUid, updated_at: now }, { merge: true });
  await db.collection('job_alert_subscribers').doc(OWNER_EMAIL)
    .collection('alerts').doc(CANARY_ALERT_ID).set(alertDoc, { merge: true });

  console.log('\n✅ Canary ad + job-specific alert written.');
  console.log('   Next publisher-jobs-sync (≤30 min) projects it into the slice; live after deploy (~1–2h).');
  console.log('   Broadcast (blast/newsletter/job-alerts) is gated to the owner only.');
}

main().catch((err) => {
  console.error('❌ seed-canary-publisher-ad failed:', err?.message || err);
  process.exit(1);
});
