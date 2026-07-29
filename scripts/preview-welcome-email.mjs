#!/usr/bin/env node
/**
 * preview-welcome-email.mjs — local preview/test tool for the post-signup
 * welcome email (functions/src/lib/welcomeEmailTemplate.js +
 * functions/src/lib/welcomeSegment.js). Lets the owner see every
 * segment × locale combination rendered as real HTML, and optionally fire
 * ONE real test send through the shared email cascade — before
 * requestWelcomeEmail() in services/newsletterSubscribers.ts ever calls the
 * production newsletterSendWelcome Cloud Function for a real signup.
 *
 * Modes (mirrors send-onboarding-drip.mjs — NEVER a real local blast):
 *   --render-only (DEFAULT)     render HTML files to --out, send nothing
 *   --test --target-email <addr>   send ONE real email via the shared cascade
 *
 * Flags:
 *   --out <dir>       output dir for --render-only (default ./tmp-welcome-preview)
 *   --segment <job|salary|utility|publisher|general>   default: all five
 *   --locale <it|en|de|fr>       default: all four
 *   --email <addr>    pull a real newsletter_subscribers/{email} Firestore doc
 *                      and render with its real sanitized context instead of
 *                      the synthetic fixtures below
 *
 * HARD SAFETY RULES (non-negotiable):
 *   - no flag or combination of flags can ever send to more than ONE address
 *     — there is no --send, no bulk mode; this is a preview tool, not a sender
 *   - --test without --target-email exits non-zero with a clear error
 *   - --test NEVER writes to Firestore — no welcome_sent_at, no drip fields,
 *     nothing. It only renders the template and posts through the cascade.
 *   - default behavior with no flags is --render-only
 *
 * Required env: GOOGLE_APPLICATION_CREDENTIALS / ADC (Firebase Admin) only
 * when --email is used; at least one email-provider key for --test.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveWelcomeContext } from '../functions/src/lib/welcomeSegment.js';
import { buildWelcomeEmail } from '../functions/src/lib/welcomeEmailTemplate.js';
import { makeUnsubscribeUrl, makePreferencesUrl, wrapAuthenticatedHrefs } from '../services/newsletterUrls.mjs';

const WELCOME_SEGMENTS = ['job', 'salary', 'utility', 'publisher', 'general'];
const LOCALES = ['it', 'en', 'de', 'fr'];
const FROM_EMAIL = 'Frontaliere Ticino <newsletter@frontaliereticino.ch>';

// ── CLI args ─────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name) { return argv.includes(`--${name}`); }
function opt(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

const IS_TEST = flag('test');
const TARGET_EMAIL = opt('target-email');
const OUT_DIR = opt('out', './tmp-welcome-preview');
const SEGMENT_FILTER = opt('segment');
const LOCALE_FILTER = opt('locale');
const LOOKUP_EMAIL = opt('email');

if (SEGMENT_FILTER && !WELCOME_SEGMENTS.includes(SEGMENT_FILTER)) {
  console.error(`❌ --segment must be one of: ${WELCOME_SEGMENTS.join(', ')}`);
  process.exit(1);
}
if (LOCALE_FILTER && !LOCALES.includes(LOCALE_FILTER)) {
  console.error(`❌ --locale must be one of: ${LOCALES.join(', ')}`);
  process.exit(1);
}
if (IS_TEST && !TARGET_EMAIL) {
  console.error('❌ --test requires --target-email <addr> (never sends without an explicit single recipient)');
  process.exit(1);
}

const SEGMENTS_TO_RENDER = SEGMENT_FILTER ? [SEGMENT_FILTER] : WELCOME_SEGMENTS;
const LOCALES_TO_RENDER = LOCALE_FILTER ? [LOCALE_FILTER] : LOCALES;

// ── Firebase Admin (only needed for --email lookup) ───────────
let db;
async function initFirebase() {
  const admin = await import('firebase-admin');
  const a = admin.default || admin;
  if (!a.apps?.length) {
    a.initializeApp({
      credential: a.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  db = a.firestore();
}

async function fetchSubscriberDoc(email) {
  await initFirebase();
  const snap = await db.collection('newsletter_subscribers').doc(email.toLowerCase().trim()).get();
  if (!snap.exists) {
    console.error(`❌ No newsletter_subscribers doc found for ${email}`);
    process.exit(1);
  }
  const data = snap.data() || {};
  return { ...data, email: data.email || email };
}

// ── Synthetic fixture docs, one per segment ───────────────────
// Shaped exactly like a real newsletter_subscribers/{email} Firestore doc —
// same field names resolveWelcomeContext() reads (job_company,
// sector_interest, location_interest, source_cta, source, source_page,
// firstName). The 'job' fixture's job_company is the literal corrupted
// production value that sanitizeCompany() must reject (mid-sentence prose
// fragment scraped alongside a company name) — this proves the degrade-
// never-guess sanitizer nulls it out and the template falls back to its
// generic "le offerte per frontalieri" sentence instead of printing garbage.
function syntheticDocFor(segment) {
  switch (segment) {
    case 'job':
      return {
        email: 'preview-job@example.com',
        firstName: 'Marco',
        job_company: '"). Vorab erhältst du einen Überblick über Ablauf und Lernziele',
        sector_interest: 'Sanità / Ospedali',
        location_interest: 'lugano',
        source_page: '/lavoro/infermiere-lugano-ospedale-civico/',
        source_cta: 'job_board_email_unlock',
        source: 'job_board',
      };
    case 'salary':
      return {
        email: 'preview-salary@example.com',
        firstName: 'Giulia',
        source: 'post_calc_cta',
        source_cta: 'post_calc_newsletter_cta',
      };
    case 'utility':
      return {
        email: 'preview-utility@example.com',
        firstName: 'Luca',
        source: 'lamal_ssn_tool',
      };
    case 'publisher':
      return {
        email: 'preview-publisher@example.com',
        firstName: 'Anna',
        source_cta: 'publisher_gate_signup',
        source_route_family: 'publisher',
      };
    case 'general':
    default:
      return {
        email: 'preview-general@example.com',
        firstName: 'Sara',
        source: 'organic_footer',
      };
  }
}

function renderOne(doc, locale) {
  const ctx = resolveWelcomeContext(doc);
  const email = doc.email || 'preview@example.com';
  const unsubscribeUrl = makeUnsubscribeUrl(email);
  // Job alerts are auto-created at signup, so the live `job` email usually takes
  // the "already active" wording. --no-job-alert renders the other branch.
  const jobAlertActive = !flag('no-job-alert');
  const preferencesUrl = makePreferencesUrl(email, locale, { fallbackUnsigned: true });
  const { subject, preheader, html } = buildWelcomeEmail({
    segment: ctx.segment,
    locale,
    firstName: ctx.firstName,
    company: ctx.company,
    sectorKey: ctx.sectorKey,
    locationLabel: ctx.locationLabel,
    jobBackPath: ctx.jobBackPath,
    toolKey: ctx.toolKey,
    jobAlertActive,
    unsubscribeUrl,
    preferencesUrl,
    acquisitionSource: ctx.acquisitionSource,
  });
  // Mirror the sender: every internal link carries autologin credentials.
  const authedHtml = wrapAuthenticatedHrefs(html, email, { utmCampaign: `welcome_${ctx.segment}` });
  return { resolvedSegment: ctx.segment, subject, preheader, html: authedHtml };
}

async function runRenderOnly() {
  await mkdir(OUT_DIR, { recursive: true });
  const written = [];

  if (LOOKUP_EMAIL) {
    const data = await fetchSubscriberDoc(LOOKUP_EMAIL);
    for (const locale of LOCALES_TO_RENDER) {
      const label = `real-subscriber-${locale}`;
      const { resolvedSegment, subject, html } = renderOne(data, locale);
      const file = path.join(OUT_DIR, `${label}.html`);
      await writeFile(file, html, 'utf8');
      written.push({ file, resolvedSegment, subject });
    }
  } else {
    for (const segment of SEGMENTS_TO_RENDER) {
      const doc = syntheticDocFor(segment);
      for (const locale of LOCALES_TO_RENDER) {
        const label = `${segment}-${locale}`;
        const { resolvedSegment, subject, html } = renderOne(doc, locale);
        const file = path.join(OUT_DIR, `${label}.html`);
        await writeFile(file, html, 'utf8');
        written.push({ file, resolvedSegment, subject });
      }
    }
  }

  console.log(`📧 Welcome email preview — render-only, ${written.length} file(s) written to ${OUT_DIR}/`);
  for (const w of written) {
    console.log(`  ${path.basename(w.file)} — segment=${w.resolvedSegment} — "${w.subject}"`);
  }
  console.log('✅ Nothing sent. Open the HTML files above in a browser to review.');
}

async function runTest() {
  const doc = LOOKUP_EMAIL ? await fetchSubscriberDoc(LOOKUP_EMAIL) : syntheticDocFor(SEGMENT_FILTER || 'general');
  const locale = LOCALE_FILTER || 'it';
  const { resolvedSegment, subject, html } = renderOne(doc, locale);

  console.log(`🧪 Test welcome email: segment=${resolvedSegment} locale=${locale} → ${TARGET_EMAIL}`);
  console.log('   (--test mode: NO Firestore write happens, ever — render + single cascade send only)');

  const { sendEmailCascade, logProviderSummary } = await import('./lib/email-cascade.mjs');
  const { sent, failed } = await sendEmailCascade([{
    payload: {
      from: FROM_EMAIL,
      to: [TARGET_EMAIL],
      subject: `[TEST] ${subject}`,
      html,
      tags: [
        { name: 'campaign_id', value: 'welcome_email_test' },
        { name: 'type', value: 'lifecycle' },
      ],
    },
    recipient: { email: TARGET_EMAIL },
    meta: {},
  }]);
  logProviderSummary();

  if (failed.length) {
    console.error('❌ Test send failed:', failed[0]?.error);
    process.exit(1);
  }
  console.log(`✅ Test welcome email sent to ${TARGET_EMAIL} (messageId=${sent[0]?.messageId || 'n/a'})`);
}

async function main() {
  console.log(`📧 Welcome email preview tool — mode=${IS_TEST ? 'test' : 'render-only'}`);
  if (IS_TEST) return runTest();
  return runRenderOnly();
}

main().catch((e) => {
  console.error('❌ Welcome email preview failed:', e?.stack || e?.message || e);
  process.exit(1);
});
