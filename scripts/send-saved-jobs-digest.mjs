#!/usr/bin/env node
/**
 * send-saved-jobs-digest.mjs — weekly reminder email for users' saved jobs.
 *
 * Queries the `savedJobs` collectionGroup (users/{uid}/savedJobs/{jobId}),
 * groups by uid, and sends one email per user listing what they saved —
 * with an "expired" badge for listings pruned from data/jobs.json since —
 * plus a small "potrebbero interessarti anche" block derived from the same
 * dominant category/canton used by the in-app nudge
 * (services/savedJobsAlertCriteria.ts, shared with the browser bundle).
 *
 * Opt-out, not opt-in: any user with ≥1 saved job receives it, unless
 * `users/{uid}.savedJobsDigest.optedOut === true` (set by
 * functions/src/savedJobsDigestUnsubscribe.js) or their email is address-
 * suppressed. This channel's unsubscribe is scoped to `savedJobsDigest`
 * only — it must never touch `newsletter_subscribers` or
 * `job_alert_subscribers/*` (see functions/src/lib/emailSuppression.js).
 *
 * Env:
 *   GOOGLE_APPLICATION_CREDENTIALS — Firebase service account for Firestore
 *   NEWSLETTER_SECRET — HMAC secret for the unsubscribe token (shared with
 *     jobAlertUnsubscribe/newsletterManageSubscription — same secret, distinct
 *     per-channel token prefix so tokens don't cross channels)
 *   TARGET_EMAIL — limit send to one address (test mode)
 *   --dry-run — build emails but don't send
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCantonResolvers } from '../build-plugins/shared/cantonResolvers.mjs';
import { isSavedJobsDigestExcluded } from '../services/emailSuppression.mjs';
import { deriveSavedJobsAlertCriteria } from '../services/savedJobsAlertCriteria.ts';
import { buildDeliveryDocId } from '../functions/src/lib/deliveryDocId.js';
import { dataControllerFooterLine } from '../functions/src/lib/dataControllerIdentity.js';
// localePathPrefix aliased to the local name this script has always used —
// the implementation is the canonical shared helper (also used by
// send-newsletter.mjs, send-job-alerts.mjs, AGENTS.md #6).
import { localePathPrefix } from './lib/articleContent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const BASE_URL = 'https://frontaliereticino.ch';
const IMAGE_CDN_BASE = 'https://cdn.frontaliereticino.ch';
const FROM_EMAIL = 'Frontaliere Ticino <alerts@frontaliereticino.ch>';
const DRY_RUN = process.argv.includes('--dry-run');
const MAX_SAVED_LISTED = 20; // hard UI cap, matches SAVED_JOBS_CAP order of magnitude
const MAX_RECOMMENDATIONS = 3;

const TARGET_EMAIL_RAW = (process.env.TARGET_EMAIL || '').trim().toLowerCase();
if (TARGET_EMAIL_RAW) {
  console.log(`🎯 TARGET_EMAIL set — limiting send to: ${TARGET_EMAIL_RAW}`);
}

// Same apex-domain requirement as jobAlertUnsubscribe/newsletterManageSubscription
// — List-Unsubscribe URL must live on the sending domain or the URL↔From-domain
// mismatch trips spam filters. Proxied to the savedJobsDigestUnsubscribe Cloud
// Function by the Cloudflare Worker (infra/cloudflare-worker/locale-router.js).
const UNSUB_URL = `${BASE_URL}/disiscrivi-promemoria-salvati/`;

const cantonSlugFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'canton-url-slugs.json'), 'utf8'));
const municipalitiesFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'canton-municipalities.json'), 'utf8'));
const { resolveCantonSection, resolveJobCanton } = createCantonResolvers({ cantonSlugFile, municipalitiesFile });

function jobPageUrl(job, locale) {
  const cantonCode = resolveJobCanton({ canton: job.canton, location: job.location });
  const jobBoardPath = resolveCantonSection(locale, cantonCode);
  const localizedJobBoardPath = `${localePathPrefix(locale)}/${jobBoardPath}`;
  const slug = job.slugByLocale?.[locale] || job.slugByLocale?.it || job.slug || '';
  return slug ? `${BASE_URL}${localizedJobBoardPath}/${slug}` : `${BASE_URL}/cerca-lavoro-ticino/`;
}

function jobTitle(job, locale) {
  return job.titleByLocale?.[locale] || job.titleByLocale?.it || job.title || '';
}

// ── Firebase Admin SDK (lazy init, same pattern as send-job-alerts.mjs) ─────

let _db = null;

export function __setFirestoreAdminForTest(fakeDb) {
  _db = fakeDb;
}

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
    if (cred.project_id) {
      initializeApp({ credential: cert(cred) });
    } else {
      const { applicationDefault } = await import('firebase-admin/app');
      initializeApp({ credential: applicationDefault(), projectId: 'frontaliere-ticino' });
    }
  }
  _db = getFirestore();
  return _db;
}

// ── data/jobs.json, indexed by id ────────────────────────────────────────

function loadJobsById() {
  const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
  const byId = new Map();
  for (const job of jobs) byId.set(job.id, job);
  return byId;
}

// ── Scoped unsubscribe token — must match generateSavedJobsDigestUnsubToken
// in functions/src/savedJobsDigestUnsubscribe.js exactly. Recomputed inline
// (not imported) because functions/ has no bundler and cannot be imported
// from scripts/ — same constraint documented in
// functions/src/lib/emailSuppression.js (shim/re-export, never the reverse). ──

function makeUnsubscribeUrl(uid, email) {
  const secret = process.env.NEWSLETTER_SECRET;
  if (!secret) return `${BASE_URL}/area-personale/`;
  const token = createHmac('sha256', secret).update(`saved_jobs_digest_unsub:${uid}`).digest('hex');
  return `${UNSUB_URL}?uid=${encodeURIComponent(uid)}&email=${encodeURIComponent(email)}&token=${token}`;
}

// ── i18n strings ──────────────────────────────────────────────────────────

const EMAIL_STRINGS = {
  it: {
    subject: (n) => `📌 I tuoi ${n} lavor${n === 1 ? 'o salvato' : 'i salvati'} — promemoria settimanale`,
    preheader: 'Un riepilogo settimanale di quello che hai messo da parte.',
    heroTitle: 'I tuoi lavori salvati',
    heroDesc: 'Promemoria settimanale — nessuno di questi è andato perso.',
    expiredBadge: 'Annuncio scaduto',
    at: 'presso',
    viewJob: 'Vedi annuncio →',
    manageLink: 'Gestisci i salvati nella tua area personale',
    recoTitle: '✨ Potrebbero interessarti anche',
    closer: 'Ricevi questa email perché hai salvato almeno un lavoro. Puoi disiscriverti in ogni momento.',
    closerSign: 'Alla prossima. ☕',
    unsubLine: 'Disiscriviti da questo promemoria (i tuoi altri alert non vengono toccati):',
    unsubLink: 'Disiscriviti dal promemoria settimanale',
    textViewAllLine: 'Gestisci i salvati:',
    textUnsubLine: 'Disiscriviti da questo promemoria:',
  },
  en: {
    subject: (n) => `📌 Your ${n} saved job${n === 1 ? '' : 's'} — weekly reminder`,
    preheader: 'A weekly recap of what you bookmarked.',
    heroTitle: 'Your saved jobs',
    heroDesc: "Weekly reminder — none of these are lost.",
    expiredBadge: 'Listing expired',
    at: 'at',
    viewJob: 'View listing →',
    manageLink: 'Manage saved jobs in your account',
    recoTitle: '✨ You might also like',
    closer: "You're getting this because you saved at least one job. You can unsubscribe anytime.",
    closerSign: 'See you next week. ☕',
    unsubLine: 'Unsubscribe from this reminder (your other alerts stay untouched):',
    unsubLink: 'Unsubscribe from the weekly reminder',
    textViewAllLine: 'Manage saved jobs:',
    textUnsubLine: 'Unsubscribe from this reminder:',
  },
  de: {
    subject: (n) => `📌 Ihre ${n} gespeicherte${n === 1 ? '' : 'n'} Stelle${n === 1 ? '' : 'n'} — wöchentliche Erinnerung`,
    preheader: 'Eine wöchentliche Übersicht Ihrer gemerkten Stellen.',
    heroTitle: 'Ihre gespeicherten Stellen',
    heroDesc: 'Wöchentliche Erinnerung — keine davon ist verloren.',
    expiredBadge: 'Angebot abgelaufen',
    at: 'bei',
    viewJob: 'Angebot ansehen →',
    manageLink: 'Gespeicherte Stellen in Ihrem Konto verwalten',
    recoTitle: '✨ Das könnte Sie auch interessieren',
    closer: 'Sie erhalten diese E-Mail, weil Sie mindestens eine Stelle gespeichert haben. Sie können sich jederzeit abmelden.',
    closerSign: 'Bis nächste Woche. ☕',
    unsubLine: 'Von dieser Erinnerung abmelden (Ihre anderen Alerts bleiben unberührt):',
    unsubLink: 'Von der wöchentlichen Erinnerung abmelden',
    textViewAllLine: 'Gespeicherte Stellen verwalten:',
    textUnsubLine: 'Von dieser Erinnerung abmelden:',
  },
  fr: {
    subject: (n) => `📌 Vos ${n} offre${n === 1 ? '' : 's'} enregistrée${n === 1 ? '' : 's'} — rappel hebdomadaire`,
    preheader: 'Un récapitulatif hebdomadaire de ce que vous avez mis de côté.',
    heroTitle: 'Vos offres enregistrées',
    heroDesc: "Rappel hebdomadaire — aucune n'est perdue.",
    expiredBadge: 'Offre expirée',
    at: 'chez',
    viewJob: "Voir l'offre →",
    manageLink: 'Gérer vos offres enregistrées dans votre compte',
    recoTitle: '✨ Pourrait aussi vous intéresser',
    closer: 'Vous recevez cet e-mail car vous avez enregistré au moins une offre. Vous pouvez vous désabonner à tout moment.',
    closerSign: 'À la semaine prochaine. ☕',
    unsubLine: 'Se désabonner de ce rappel (vos autres alertes restent actives) :',
    unsubLink: 'Se désabonner du rappel hebdomadaire',
    textViewAllLine: 'Gérer les offres enregistrées :',
    textUnsubLine: 'Se désabonner de ce rappel :',
  },
};

function getStrings(locale) {
  return EMAIL_STRINGS[locale] || EMAIL_STRINGS.it;
}

// ── Email rendering ──────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderJobCard(entry, locale, s, { expired }) {
  const url = expired ? `${BASE_URL}/cerca-lavoro-ticino/` : entry.url;
  const badge = expired
    ? `<span style="display:inline-block;background:#fee2e2;color:#b91c1c;font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;margin-left:8px;">${s.expiredBadge}</span>`
    : '';
  return `
    <tr>
      <td style="padding:14px 0;border-bottom:1px solid #e2e8f0;">
        <div style="font-size:16px;font-weight:600;color:#0f172a;">${escapeHtml(entry.title)}${badge}</div>
        <div style="font-size:14px;color:#64748b;margin-top:2px;">${s.at} ${escapeHtml(entry.company)}${entry.canton ? ` · ${escapeHtml(entry.canton)}` : ''}</div>
        <a href="${url}" style="display:inline-block;margin-top:8px;font-size:14px;color:#f97316;font-weight:600;text-decoration:none;">${s.viewJob}</a>
      </td>
    </tr>`;
}

function buildEmailHtml({ locale, s, savedEntries, recommendations, manageUrl, unsubUrl }) {
  const cardsHtml = savedEntries.map((e) => renderJobCard(e, locale, s, { expired: e.expired })).join('');
  const recoHtml = recommendations.length
    ? `
    <tr><td style="padding:24px 0 8px;font-size:16px;font-weight:700;color:#0f172a;">${s.recoTitle}</td></tr>
    ${recommendations.map((e) => renderJobCard(e, locale, s, { expired: false })).join('')}`
    : '';

  return `<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(s.preheader)}</div>
  <table role="presentation" width="100%" style="background:#f1f5f9;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" style="max-width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#f97316;padding:24px 32px;">
          <div style="color:#ffffff;font-size:20px;font-weight:700;">${escapeHtml(s.heroTitle)}</div>
          <div style="color:#ffedd5;font-size:14px;margin-top:4px;">${escapeHtml(s.heroDesc)}</div>
        </td></tr>
        <tr><td style="padding:8px 32px 24px;">
          <table role="presentation" width="100%">${cardsHtml}${recoHtml}</table>
          <div style="margin-top:24px;">
            <a href="${manageUrl}" style="color:#f97316;font-weight:600;text-decoration:none;font-size:14px;">${s.manageLink}</a>
          </div>
        </td></tr>
        <tr><td style="padding:20px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;">
          <div style="font-size:13px;color:#64748b;">${escapeHtml(s.closer)}</div>
          <div style="font-size:13px;color:#64748b;margin-top:4px;">${escapeHtml(s.closerSign)}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:16px;">
            ${escapeHtml(s.unsubLine)} <a href="${unsubUrl}" style="color:#94a3b8;">${escapeHtml(s.unsubLink)}</a>
          </div>
          <div style="font-size:11px;color:#94a3b8;margin-top:10px;">${escapeHtml(dataControllerFooterLine(locale))}</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildEmailText({ locale, s, savedEntries, recommendations, manageUrl, unsubUrl }) {
  const lines = [s.heroTitle, ''];
  for (const e of savedEntries) {
    lines.push(`- ${e.title} (${s.at} ${e.company})${e.expired ? ` [${s.expiredBadge}]` : ''}: ${e.expired ? `${BASE_URL}/cerca-lavoro-ticino/` : e.url}`);
  }
  if (recommendations.length) {
    lines.push('', s.recoTitle);
    for (const e of recommendations) lines.push(`- ${e.title} (${s.at} ${e.company}): ${e.url}`);
  }
  lines.push('', `${s.textViewAllLine} ${manageUrl}`, '', `${s.textUnsubLine} ${unsubUrl}`, '', dataControllerFooterLine(locale));
  return lines.join('\n');
}

// ── Sending ───────────────────────────────────────────────────────────────

// Delivery record (#4862): mirrors send-job-alerts.mjs's persistJobAlertDelivery
// — this channel previously called sendEmailCascade with no onSent at all, so
// its sends never left a campaign_deliveries doc anywhere and were invisible to
// scripts/report-send-hour-impact.mjs's collectionGroup('campaign_deliveries')
// query. Written under users/{uid}/campaign_deliveries/{deliveryDocId} since
// uid (not email) is this channel's subscriber key (see makeUnsubscribeUrl).
async function persistSavedJobsDigestDelivery({ uid, email, campaignId }, sendResult) {
  if (!uid || !email || !campaignId) return;
  try {
    const db = await getFirestoreAdmin();
    const deliveryDocId = buildDeliveryDocId(campaignId, email);
    await db.collection('users').doc(uid)
      .collection('campaign_deliveries').doc(deliveryDocId).set({
      email: email.toLowerCase().trim(),
      campaign_id: campaignId,
      message_id: sendResult?.messageId || null,
      provider: sendResult?.provider || null,
      scheduled_for: sendResult?.scheduledFor ?? null,
      sent_at: new Date(),
    }, { merge: true });
  } catch (e) {
    console.warn('⚠️ Saved-jobs-digest delivery persist failed:', e?.message);
  }
}

async function sendDigest({ uid, email, locale, savedEntries, recommendations, campaignId }) {
  const s = getStrings(locale);
  const manageUrl = `${BASE_URL}${localePathPrefix(locale)}/area-personale/`;
  const unsubUrl = makeUnsubscribeUrl(uid, email);
  const html = buildEmailHtml({ locale, s, savedEntries, recommendations, manageUrl, unsubUrl });
  const text = buildEmailText({ locale, s, savedEntries, recommendations, manageUrl, unsubUrl });
  const subject = s.subject(savedEntries.length);

  if (DRY_RUN) {
    console.log(`   📝 [dry-run] would send to ${email} (${locale}) — subject: ${subject}`);
    return { sent: true, dryRun: true };
  }

  const { sendEmailCascade } = await import('./lib/email-cascade.mjs');
  const result = await sendEmailCascade([
    {
      payload: {
        from: FROM_EMAIL,
        to: [email],
        subject,
        html,
        text,
        tags: [
          { name: 'type', value: 'saved-jobs-digest' },
          { name: 'campaign_id', value: campaignId },
        ],
        headers: {
          'Feedback-ID': `saved-jobs-digest:${uid}:frontaliere-ticino`,
          'List-Unsubscribe': `<${unsubUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      },
      recipient: { email },
      meta: { type: 'saved-jobs-digest', uid, campaignId },
    },
  ], {
    concurrency: 1,
    onSent: (item, sendResult) => persistSavedJobsDigestDelivery({ uid, email, campaignId }, sendResult),
  });

  return { sent: result.sent.length > 0, failed: result.failed };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const db = await getFirestoreAdmin();
  const jobsById = loadJobsById();
  // One campaignId per run (#4862) — all recipients of a given weekly send
  // share it, same convention as send-newsletter.mjs's weekly_{monday}.
  const campaignId = `saved-jobs-digest-${new Date().toISOString().split('T')[0]}`;

  console.log('📌 Saved-jobs digest — querying collectionGroup(savedJobs)…');
  const snap = await db.collectionGroup('savedJobs').get();
  if (snap.empty) {
    console.log('   No saved jobs found — nothing to send.');
    return;
  }

  const byUid = new Map();
  for (const docSnap of snap.docs) {
    const uid = docSnap.ref.parent.parent?.id;
    if (!uid) continue;
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push({ id: docSnap.id, ...docSnap.data() });
  }

  console.log(`   ${byUid.size} user(s) with ≥1 saved job`);

  let sentCount = 0;
  let skippedCount = 0;

  for (const [uid, entries] of byUid) {
    if (entries.length === 0) {
      skippedCount++;
      continue;
    }

    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      skippedCount++;
      continue;
    }
    const userData = userDoc.data() || {};
    const email = (userData.email || '').trim();
    const locale = userData.locale || 'it';

    if (!email) {
      skippedCount++;
      continue;
    }
    if (userData.savedJobsDigest?.optedOut === true) {
      skippedCount++;
      continue;
    }
    if (TARGET_EMAIL_RAW && email.toLowerCase() !== TARGET_EMAIL_RAW) {
      continue;
    }

    // Address-suppression cross-check (bounces/complaints) — same principle
    // as isNewsletterExcluded/isJobAlertExcluded, one shared suppression list.
    const subscriberDoc = await db.collection('newsletter_subscribers').doc(email.toLowerCase()).get();
    const subscriberStatus = subscriberDoc.exists ? subscriberDoc.data()?.status : null;
    if (isSavedJobsDigestExcluded(subscriberStatus)) {
      skippedCount++;
      continue;
    }

    const savedEntries = entries
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
      .slice(0, MAX_SAVED_LISTED)
      .map((entry) => {
        const job = jobsById.get(entry.id);
        if (!job) return { ...entry, expired: true, url: null, company: entry.company, title: entry.title, canton: entry.canton };
        return {
          ...entry,
          expired: false,
          url: jobPageUrl(job, locale),
          title: jobTitle(job, locale),
          company: job.company || entry.company,
          canton: job.canton || entry.canton,
        };
      });

    // "Potrebbero interessarti anche" — dominant category/canton from the
    // saved set, same derivation the in-app nudge uses (#4467 addendum).
    const criteria = deriveSavedJobsAlertCriteria(
      entries.map((e) => ({ category: e.category ?? null, canton: e.canton ?? null, savedAt: e.savedAt || 0 })),
    );
    const savedIds = new Set(entries.map((e) => e.id));
    const recommendations = [];
    if (criteria.category || criteria.cantonCode) {
      for (const job of jobsById.values()) {
        if (recommendations.length >= MAX_RECOMMENDATIONS) break;
        if (savedIds.has(job.id)) continue;
        const categoryMatch = criteria.category ? job.category === criteria.category : true;
        const cantonMatch = criteria.cantonCode ? job.canton === criteria.cantonCode : true;
        if (categoryMatch && cantonMatch) {
          recommendations.push({
            id: job.id,
            title: jobTitle(job, locale),
            company: job.company,
            canton: job.canton,
            url: jobPageUrl(job, locale),
          });
        }
      }
    }

    console.log(`   ✉️  ${email} (${locale}) — ${savedEntries.length} saved, ${recommendations.length} recommended`);
    const result = await sendDigest({ uid, email, locale, savedEntries, recommendations, campaignId });
    if (result.sent) sentCount++;
    else skippedCount++;
  }

  console.log(`\n📊 Done — sent ${sentCount}, skipped ${skippedCount}${DRY_RUN ? ' (dry-run)' : ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('❌ send-saved-jobs-digest.mjs failed:', error);
    process.exitCode = 1;
  });
}

export { main, jobPageUrl, makeUnsubscribeUrl, loadJobsById };
