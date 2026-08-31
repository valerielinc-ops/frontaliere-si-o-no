#!/usr/bin/env node
/**
 * Dormant-tier win-back campaign runner (#4299).
 *
 * Two-email re-engagement sequence for the `engagement_level === 'dormant'`
 * cohort (score 0-9, functions/src/lib/engagementScore.js), ahead of the SAME
 * sunset policy scripts/newsletter-sunset.mjs uses — see the classifier in
 * scripts/lib/dormantWinback.mjs for the full policy, thresholds, and why
 * this is a DIFFERENT, broader population than that script's zombie-sunset
 * track (the two are mutually exclusive by construction; a subscriber is
 * only ever run through one campaign).
 *
 *   stage1  → send the "here's what you missed" digest, stamp dormant_winback_stage1_sent_at
 *   stage2  → send the "are you still there?" message (services/winbackEmail.mjs), stamp dormant_winback_stage2_sent_at
 *   sunset  → status = 'inactive' (soft, excluded from sends, resubscribable) — same transition newsletter-sunset.mjs uses
 *   reactivate → engagement recovered mid-sequence; clear the stage timestamps (status untouched — this campaign never set it)
 *
 * Usage:
 *   node scripts/newsletter-winback-campaign.mjs                  # DRY-RUN scan (Firestore read-only, no writes, no email)
 *   node scripts/newsletter-winback-campaign.mjs --apply          # apply stage/sunset/reactivate writes, mark stage timestamps — no email
 *   node scripts/newsletter-winback-campaign.mjs --apply --send   # also send the stage1/stage2 emails via the provider cascade
 *   node scripts/newsletter-winback-campaign.mjs --preview --stage 1 [--locale it] [--interest jobs]  # render stage1 HTML to stdout — no Firestore, no send
 *   node scripts/newsletter-winback-campaign.mjs --preview --stage 2 [--locale it]                    # render stage2 HTML to stdout — no Firestore, no send
 *
 * `--preview` never touches Firestore and never sends — safe to run locally
 * any time. Only `--apply --send` performs a real send; per repo policy this
 * must run in CI, never invoked locally.
 *
 * NOTE: argValue() only supports `--flag value` (space-separated), not
 * `--flag=value` — matches scripts/newsletter-sunset.mjs's own convention.
 */
import { classifyDormantWinback } from './lib/dormantWinback.mjs';
import { buildDormantWinbackStage1Email } from '../services/dormantWinbackStage1Email.mjs';
import { buildWinbackEmail } from '../services/winbackEmail.mjs';
import { commitInChunks } from './lib/firestore-batch.mjs';
import { localeOf } from './lib/subscriberLocale.mjs';
import { localizeArticle, loadArticlePerformanceWinners } from './lib/articleContent.mjs';
import { inferInterest, selectWinnerCandidates, INTERESTS } from '../services/newsletter-segments.mjs';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const APPLY = process.argv.includes('--apply');
const SEND = process.argv.includes('--send');
const PREVIEW = process.argv.includes('--preview');
const PREVIEW_STAGE = argValue('--stage') || '1';
const PREVIEW_LOCALE = argValue('--locale') || 'it';
const PREVIEW_INTEREST = argValue('--interest') || INTERESTS.GENERAL;
const FROM_EMAIL = process.env.NEWSLETTER_FROM || 'Frontaliere Ticino <newsletter@frontaliereticino.ch>';

// Fallback article id when no performance-ranked winner localizes for a
// subscriber's locale/interest — mirrors scripts/send-newsletter.mjs's
// DEFAULT_ARTICLE_ID so stage 1 is never sent with an empty article list.
const DEFAULT_ARTICLE_ID = 'comuni-migliori-frontalieri';

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

/**
 * Resolve up to 3 localized "here's what you missed" articles for a
 * subscriber, preferring their inferred interest's cluster, falling back to
 * DEFAULT_ARTICLE_ID so the digest is never empty.
 * @param {string} interest one of INTERESTS
 * @param {string} locale
 * @returns {Array<{title:string, excerpt:string, url:string}>}
 */
function resolveStage1Articles(interest, locale) {
  const winners = loadArticlePerformanceWinners();
  const slugs = selectWinnerCandidates(interest, winners, { limit: 5 });
  const articles = [];
  for (const slug of slugs) {
    const localized = localizeArticle(slug, locale);
    if (localized) articles.push(localized);
    if (articles.length >= 3) break;
  }
  if (articles.length === 0) {
    const fallback = localizeArticle(DEFAULT_ARTICLE_ID, locale);
    if (fallback) articles.push(fallback);
  }
  return articles;
}

/**
 * Build + send stage1 ("what you missed") emails via the provider cascade.
 * @param {Array<{email:string, locale:string, interest:string}>} items
 * @returns {Promise<Set<string>>} lowercased emails that FAILED to send
 */
export async function sendStage1(items) {
  const { sendEmailCascade, logProviderSummary } = await import('./lib/email-cascade.mjs');
  const cascade = items.map((w) => {
    const articles = resolveStage1Articles(w.interest, w.locale);
    const { subject, html, text, unsubscribeUrl } = buildDormantWinbackStage1Email({ email: w.email, locale: w.locale, articles });
    return {
      payload: {
        from: FROM_EMAIL,
        to: [w.email],
        subject,
        html,
        text,
        // campaign_id tag (#6317/#6765): when the cascade lands on anything
        // other than Maileroo (mailgun/mailjet/resend/mailtrap), its webhook
        // reads campaign_id off this tag — Maileroo's own per-message ref
        // fallback (functions/src/lib/mailerooRef.js defaultCampaignId) never
        // applies to those, so without it the send fell to the
        // `unknown:<messageId>` fallback and was filed `unattributed`.
        tags: [{ name: 'campaign_id', value: 'winback_stage1' }],
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      },
      recipient: { email: w.email },
      meta: { type: 'dormant_winback_stage1' },
    };
  });
  const result = await sendEmailCascade(cascade, { concurrency: 3 });
  logProviderSummary();
  return new Set(
    (result.failed || []).map((f) => String(f?.recipient?.email || f?.payload?.to?.[0] || '').toLowerCase()),
  );
}

/**
 * Build + send stage2 ("are you still there?") emails — reuses
 * services/winbackEmail.mjs's copy/branding as-is (same idiom as
 * scripts/newsletter-sunset.mjs's sendWinbacks).
 * @param {Array<{email:string, locale:string}>} items
 * @returns {Promise<Set<string>>} lowercased emails that FAILED to send
 */
export async function sendStage2(items) {
  const { sendEmailCascade, logProviderSummary } = await import('./lib/email-cascade.mjs');
  const cascade = items.map((w) => {
    const { subject, html, text, unsubscribeUrl } = buildWinbackEmail({ email: w.email, locale: w.locale });
    return {
      payload: {
        from: FROM_EMAIL,
        to: [w.email],
        subject,
        html,
        text,
        tracking: false,
        // campaign_id tag (#6317/#6765): forceProvider below is Resend,
        // whose webhook only reads campaign_id off this tag — Maileroo's
        // per-message ref fallback (functions/src/lib/mailerooRef.js
        // defaultCampaignId) never applies here, so without it every send
        // fell to the `unknown:<messageId>` fallback and was filed
        // `unattributed`.
        tags: [{ name: 'campaign_id', value: 'winback_stage2' }],
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      },
      recipient: { email: w.email },
      meta: { type: 'dormant_winback_stage2' },
    };
  });
  // forceProvider: 'resend' (#6198) — Maileroo's tracking param is a single
  // flag (opens+clicks together), so tracking:false above would also blind
  // the open-rate measurement. Resend's send fn already sets open_tracking
  // and click_tracking independently, so it's the only cascade provider that
  // can honor "clicks off, opens on". Volume is weekly/low (dormant cohort
  // only); the shared cascade enforces Resend's free-plan 100/day ceiling.
  const result = await sendEmailCascade(cascade, { concurrency: 3, forceProvider: 'resend' });
  logProviderSummary();
  return new Set(
    (result.failed || []).map((f) => String(f?.recipient?.email || f?.payload?.to?.[0] || '').toLowerCase()),
  );
}

function subscriberInterest(data) {
  return inferInterest({
    sourceComponent: data.source_component || null,
    sourceRouteFamily: data.source_route_family || null,
    job_slug: data.job_slug || null,
    job_search_query: data.job_search_query || null,
    job_company: data.job_company || null,
  });
}

async function main() {
  // --preview: render a single stage's HTML to stdout — no Firestore, no send.
  if (PREVIEW) {
    const stage = String(PREVIEW_STAGE);
    const email = 'preview@frontaliereticino.ch';
    if (stage === '2') {
      const { subject, html } = buildWinbackEmail({ email, locale: PREVIEW_LOCALE });
      console.error(`🎯 Preview dormant win-back stage 2 (locale=${PREVIEW_LOCALE})`);
      console.error(`Subject: ${subject}`);
      console.log(html);
      return;
    }
    const articles = resolveStage1Articles(PREVIEW_INTEREST, PREVIEW_LOCALE);
    const { subject, html } = buildDormantWinbackStage1Email({ email, locale: PREVIEW_LOCALE, articles });
    console.error(`🎯 Preview dormant win-back stage 1 (locale=${PREVIEW_LOCALE}, interest=${PREVIEW_INTEREST}, articles=${articles.length})`);
    console.error(`Subject: ${subject}`);
    console.log(html);
    return;
  }

  await initFirebase();
  const { FieldValue } = await import('firebase-admin/firestore');
  const now = Date.now();

  const snap = await db.collection('newsletter_subscribers').get();
  const stage1 = [];
  const stage2 = [];
  const sunset = [];
  const reactivate = [];

  snap.forEach((doc) => {
    if (doc.id === '_meta_') return;
    const data = doc.data() || {};
    const { action } = classifyDormantWinback(data, now);
    const email = data.email || doc.id;
    if (action === 'stage1') stage1.push({ ref: doc.ref, email, locale: localeOf(data), interest: subscriberInterest(data) });
    else if (action === 'stage2') stage2.push({ ref: doc.ref, email, locale: localeOf(data) });
    else if (action === 'sunset') sunset.push({ ref: doc.ref, email });
    else if (action === 'reactivate') reactivate.push({ ref: doc.ref, email });
  });

  console.log(`📊 Dormant win-back scan: ${snap.size} subscribers`);
  console.log(`   stage 1 to send  : ${stage1.length}`);
  console.log(`   stage 2 to send  : ${stage2.length}`);
  console.log(`   to sunset        : ${sunset.length}`);
  console.log(`   to reactivate    : ${reactivate.length}`);

  if (!APPLY) {
    console.log('\n🔍 DRY-RUN — no writes, no emails. Re-run with --apply (and --send to email).');
    for (const w of stage1.slice(0, 10)) console.log(`   [stage1] ${w.email} (${w.locale}, ${w.interest})`);
    for (const w of stage2.slice(0, 10)) console.log(`   [stage2] ${w.email} (${w.locale})`);
    for (const s of sunset.slice(0, 10)) console.log(`   [sunset] ${s.email}`);
    for (const r of reactivate.slice(0, 10)) console.log(`   [reactivate] ${r.email}`);
    return;
  }

  // 1. Reactivate first — cheapest, and frees mistakenly-included users immediately.
  if (reactivate.length) {
    await commitInChunks(db, reactivate, (batch, it) => {
      batch.set(it.ref, {
        dormant_winback_stage1_sent_at: FieldValue.delete(),
        dormant_winback_stage2_sent_at: FieldValue.delete(),
      }, { merge: true });
    });
    console.log(`✅ Reactivated (sequence reset) ${reactivate.length}`);
  }

  // 2. Sunset the grace-expired non-responders — same status transition as
  //    scripts/newsletter-sunset.mjs, tagged with the campaign source for
  //    debugging/reporting only (NEWSLETTER_EXCLUDED_STATUSES only reads `status`).
  if (sunset.length) {
    await commitInChunks(db, sunset, (batch, it) => {
      batch.set(it.ref, { status: 'inactive', inactive_at: FieldValue.serverTimestamp(), sunset_source: 'dormant_winback' }, { merge: true });
    });
    console.log(`🌙 Sunset (→ inactive) ${sunset.length}`);
  }

  // 3. Stage 1 + stage 2 sends — stamp the timestamp ONLY for confirmed sends
  //    (so each grace clock starts when the user actually received their chance).
  if (stage1.length) {
    if (!SEND) {
      console.log(`✉️  ${stage1.length} stage-1 candidate(s) — --send not set, NOT sending/marking.`);
    } else {
      const failedEmails = await sendStage1(stage1);
      const confirmed = stage1.filter((w) => !failedEmails.has(w.email.toLowerCase()));
      await commitInChunks(db, confirmed, (batch, w) => {
        batch.set(w.ref, { dormant_winback_stage1_sent_at: FieldValue.serverTimestamp() }, { merge: true });
      });
      console.log(`✉️  Stage 1 sent ${confirmed.length}/${stage1.length} (failed ${stage1.length - confirmed.length})`);
    }
  }

  if (stage2.length) {
    if (!SEND) {
      console.log(`✉️  ${stage2.length} stage-2 candidate(s) — --send not set, NOT sending/marking.`);
    } else {
      const failedEmails = await sendStage2(stage2);
      const confirmed = stage2.filter((w) => !failedEmails.has(w.email.toLowerCase()));
      await commitInChunks(db, confirmed, (batch, w) => {
        batch.set(w.ref, { dormant_winback_stage2_sent_at: FieldValue.serverTimestamp() }, { merge: true });
      });
      console.log(`✉️  Stage 2 sent ${confirmed.length}/${stage2.length} (failed ${stage2.length - confirmed.length})`);
    }
  }
}

main().catch((err) => {
  console.error('[newsletter-winback-campaign] fatal:', err?.stack || err?.message || err);
  process.exit(1);
});
