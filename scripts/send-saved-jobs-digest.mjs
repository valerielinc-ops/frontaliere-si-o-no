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
 * functions/src/savedJobsDigestUnsubscribe.js) or the newsletter document
 * records a cross-channel stop — a bounce/complaint/provider suppression, or
 * the explicit newsletter opt-out (isCrossChannelStop, #5688).
 *
 * The propagation runs ONE way and that is deliberate. This channel's
 * unsubscribe is scoped to `savedJobsDigest` and must never touch
 * `newsletter_subscribers` or `job_alert_subscribers/*`; a newsletter opt-out,
 * which is worded as "stop emailing me" and not as "stop one of the emails",
 * reaches here (see functions/src/lib/emailSuppression.js).
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
import { isCrossChannelStop } from '../services/emailSuppression.mjs';
import { deriveSavedJobsAlertCriteria } from '../services/savedJobsAlertCriteria.ts';
// Shared with send-job-alerts.mjs's coverage numbers (#5536 measurement,
// 2.548-job sample): resolveLogoUrl joins the SAME manifest that measurement
// used (data/company-logos-manifest.json, 453 companies), and parseDateField
// is the DD/MM/YY-safe date reader (#2630) — re-parsing postedDate locally
// would risk the same day/month swap that fix closed.
// formatSalary/emailTagChip/normalizeContract are shared with
// send-job-alerts.mjs (#6104/#6xxx "align saved-jobs digest to the job-alert
// layout") so the two job-card renderers can't drift apart.
import { resolveLogoUrl, parseDateField, formatSalary, emailTagChip, normalizeContract } from '../services/newsletter-content.mjs';
import { renderRecommendedBlock } from '../services/newsletter/recommendedBlock.mjs';
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

// Brand palette — same tokens/values as buildAlertEmail in send-job-alerts.mjs
// so the job-alert and saved-jobs-digest emails read as one product.
const BRAND_ORANGE = '#f97316';
const BRAND_DARK = '#0f172a';
const DARK_CARD = '#1e293b';
const LIGHT_BG = '#f1f5f9';
const WHITE = '#ffffff';
const MUTED = '#64748b';
const CARD_BG = '#f8fafc';
const MUTED_ON_DARK = '#94a3b8';

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
    sectionLabel: '📌 Salvati',
    sectionTitle: 'I lavori che hai messo da parte',
    sectionDesc: 'Dal più recente al più vecchio, con l\'annuncio ancora attivo dove disponibile.',
    manageCta: 'Vai ai salvati →',
    newBadge: '✨ NUOVA',
    expiredBadge: 'Annuncio scaduto',
    at: 'presso',
    postedOn: 'Pubblicato il',
    viewJob: 'Vedi annuncio →',
    manageLink: 'Gestisci i salvati nella tua area personale',
    recoTitle: '✨ Potrebbero interessarti anche',
    closer: 'Ricevi questa email perché hai salvato almeno un lavoro. Puoi disiscriverti in ogni momento.',
    closerSign: 'Alla prossima. ☕',
    footerSentTo: (email) => `Questa email è stata inviata a ${email} perché hai almeno un lavoro salvato su Frontaliere Ticino.`,
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
    sectionLabel: '📌 Saved',
    sectionTitle: 'The jobs you set aside',
    sectionDesc: 'Most recent first, with the live listing where still available.',
    manageCta: 'Go to saved jobs →',
    newBadge: '✨ NEW',
    expiredBadge: 'Listing expired',
    at: 'at',
    postedOn: 'Posted on',
    viewJob: 'View listing →',
    manageLink: 'Manage saved jobs in your account',
    recoTitle: '✨ You might also like',
    closer: "You're getting this because you saved at least one job. You can unsubscribe anytime.",
    closerSign: 'See you next week. ☕',
    footerSentTo: (email) => `This email was sent to ${email} because you have at least one saved job on Frontaliere Ticino.`,
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
    sectionLabel: '📌 Gespeichert',
    sectionTitle: 'Die Stellen, die Sie sich gemerkt haben',
    sectionDesc: 'Neueste zuerst, mit dem noch aktiven Angebot, wo verfügbar.',
    manageCta: 'Zu den gespeicherten Stellen →',
    newBadge: '✨ NEU',
    expiredBadge: 'Angebot abgelaufen',
    at: 'bei',
    postedOn: 'Veröffentlicht am',
    viewJob: 'Angebot ansehen →',
    manageLink: 'Gespeicherte Stellen in Ihrem Konto verwalten',
    recoTitle: '✨ Das könnte Sie auch interessieren',
    closer: 'Sie erhalten diese E-Mail, weil Sie mindestens eine Stelle gespeichert haben. Sie können sich jederzeit abmelden.',
    closerSign: 'Bis nächste Woche. ☕',
    footerSentTo: (email) => `Diese E-Mail wurde an ${email} gesendet, weil Sie mindestens eine Stelle auf Frontaliere Ticino gespeichert haben.`,
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
    sectionLabel: '📌 Enregistrées',
    sectionTitle: 'Les offres que vous avez mises de côté',
    sectionDesc: "Les plus récentes d'abord, avec l'annonce encore active si disponible.",
    manageCta: 'Voir mes offres enregistrées →',
    newBadge: '✨ NOUVELLE',
    expiredBadge: 'Offre expirée',
    at: 'chez',
    postedOn: 'Publié le',
    viewJob: "Voir l'offre →",
    manageLink: 'Gérer vos offres enregistrées dans votre compte',
    recoTitle: '✨ Pourrait aussi vous intéresser',
    closer: 'Vous recevez cet e-mail car vous avez enregistré au moins une offre. Vous pouvez vous désabonner à tout moment.',
    closerSign: 'À la semaine prochaine. ☕',
    footerSentTo: (email) => `Cet e-mail a été envoyé à ${email} car vous avez au moins une offre enregistrée sur Frontaliere Ticino.`,
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

const POSTED_DATE_LOCALE = { it: 'it-CH', en: 'en-GB', de: 'de-CH', fr: 'fr-CH' };

// `postedDate` alone is 98.67% covered on real inventory (#5536 measurement,
// 2.548-job sample) — no fallback to crawledAt/validThrough here on purpose:
// those are build-time-derived windows, not source dates, and #5536 is
// explicit that a synthetic value must never be presented as one. Missing or
// unparseable → '' → caller omits the line entirely (conditional, never a
// placeholder).
function formatPostedDate(raw, locale) {
  if (!raw) return '';
  const ts = parseDateField(raw);
  if (!Number.isFinite(ts)) return '';
  const localeTag = POSTED_DATE_LOCALE[locale] || POSTED_DATE_LOCALE.it;
  try {
    return new Date(ts).toLocaleDateString(localeTag, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

// Card fields, each independently conditional (#5536): a card that shows a
// hole for a missing field is worse than a card without that field.
//   - logo:     data/company-logos-manifest.json join, 72.9% of jobs — falls
//               back to a coloured initial-letter avatar, never a blank box.
//   - location: `location` (100%) preferred over `canton` alone (99.96%).
//   - date:     `postedDate` (98.67%), see formatPostedDate above.
//   - sector:   `sector` (88.30%) preferred, `category` (100%) as fallback so
//               the tag is present whenever ANY classification exists.
//
// Card chrome (dark card, whole-card link, badge row) is deliberately aligned
// with buildAlertEmail's jobCards in send-job-alerts.mjs — same avatar size,
// same NEW/salary/contract/location badge set in the same order, same
// palette — so the saved-jobs reminder and the job alert read as one
// product. postedDate/sector stay saved-digest-only additions (job-alert
// doesn't carry them) rendered as a small detail line under the badges.
function renderJobCard(entry, locale, s, { expired }) {
  const url = expired ? `${BASE_URL}/cerca-lavoro-ticino/` : entry.url;
  const titleBadge = expired
    ? `<span style="display:inline-block;background:rgba(239,68,68,0.2);color:#fca5a5;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;margin-left:8px;">${s.expiredBadge}</span>`
    : '';

  const locationLabel = entry.location || entry.canton || '';
  const dateLabel = expired ? '' : formatPostedDate(entry.postedDate, locale);
  const sectorLabel = entry.sector || entry.category || '';

  const logoSrc = expired ? null : resolveLogoUrl(entry);
  const initial = (entry.company || '?').trim().charAt(0).toUpperCase() || '?';
  const avatarHtml = logoSrc
    ? `<img src="${logoSrc}" alt="${escapeHtml(entry.company || '')}" width="44" height="44" style="display:block;width:44px;height:44px;border-radius:10px;background:#ffffff;object-fit:contain;padding:4px;box-sizing:border-box;">`
    : `<div style="width:44px;height:44px;border-radius:10px;background:linear-gradient(135deg,${BRAND_DARK},#334155);text-align:center;line-height:44px;font-size:18px;font-weight:800;color:${BRAND_ORANGE};">${escapeHtml(initial)}</div>`;

  const metaLine = `${s.at} ${escapeHtml(entry.company)}${locationLabel ? ` · ${escapeHtml(locationLabel)}` : ''}`;

  // Badge row — same fields/order/palette as send-job-alerts.mjs's jobCards:
  // NEW, salary, contract, location. formatSalary/normalizeContract return
  // null/falsy for an expired entry (no live salaryMin/contract survives to
  // it), so those chips drop out on their own without a separate branch.
  const badges = [];
  if (!expired) {
    const firstSeen = entry.firstSeenAt ? new Date(entry.firstSeenAt).getTime() : 0;
    if (firstSeen > 0 && (Date.now() - firstSeen) < 48 * 60 * 60 * 1000) {
      badges.push(emailTagChip(s.newBadge, 'green'));
    }
  }
  const salaryLabel = formatSalary(entry, locale);
  if (salaryLabel) badges.push(emailTagChip(escapeHtml(salaryLabel), 'blue'));
  if (entry.contract) badges.push(emailTagChip(escapeHtml(normalizeContract(entry.contract, locale))));
  if (locationLabel) badges.push(emailTagChip(escapeHtml(locationLabel)));
  const badgesHtml = badges.length ? `<div style="margin-top:6px;">${badges.join(' ')}</div>` : '';

  const detailParts = [];
  if (dateLabel) detailParts.push(`${escapeHtml(s.postedOn)} ${escapeHtml(dateLabel)}`);
  if (sectorLabel) detailParts.push(escapeHtml(sectorLabel));
  const detailHtml = detailParts.length
    ? `<div style="font-size:12px;color:${MUTED_ON_DARK};margin-top:6px;">${detailParts.join(' &middot; ')}</div>`
    : '';

  return `
    <tr><td style="padding:0 0 10px;">
      <a target="_blank" rel="noopener noreferrer" href="${url}" style="text-decoration:none;display:block;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:${DARK_CARD};border-radius:12px;">
          <tr>
            <td width="58" style="padding:16px 0 16px 18px;vertical-align:top;">${avatarHtml}</td>
            <td style="padding:16px 18px 16px 14px;vertical-align:top;">
              <div style="font-size:15px;font-weight:700;color:#f1f5f9;">${escapeHtml(entry.title)}${titleBadge}</div>
              <div style="font-size:13px;color:${MUTED_ON_DARK};margin-top:2px;">${metaLine}</div>
              ${badgesHtml}
              ${detailHtml}
              <div style="margin-top:8px;font-size:13px;color:${BRAND_ORANGE};font-weight:600;">${s.viewJob}</div>
            </td>
          </tr>
        </table>
      </a>
    </td></tr>`;
}

// Structure aligned with buildAlertEmail in send-job-alerts.mjs: dark top
// bar, dark hero, white section header, white panel holding the (dark) job
// cards, closer card, dark footer with the same social row + copyright line.
// Two deliberate differences from job-alert, both requested (#6104): the
// revenue block sits right after the hero — above the job cards, i.e. above
// the fold — instead of after them, and there is a single unsubscribe link
// (this channel has no "alerts" to unsubscribe from individually).
function buildEmailHtml({ locale, s, savedEntries, recommendations, manageUrl, unsubUrl, email }) {
  const cardsHtml = savedEntries.map((e) => renderJobCard(e, locale, s, { expired: e.expired })).join('');
  const recoHtml = recommendations.length
    ? `
    <tr><td style="padding:20px 0 8px;font-size:16px;font-weight:800;color:${BRAND_DARK};">${escapeHtml(s.recoTitle)}</td></tr>
    ${recommendations.map((e) => renderJobCard(e, locale, s, { expired: false })).join('')}`
    : '';

  // Recommended (revenue) block — config-driven affiliate/sponsor slot
  // (#4450/#4449), same shared renderer as job-alert/newsletter/drip.
  // Placed ABOVE the fold (right after the hero, before the saved-job
  // cards) rather than below the cards like job-alert — deliberate for this
  // channel, per #6104.
  const recommendedBlockHtml = renderRecommendedBlock({
    locale,
    interest: 'jobs',
    acquisitionSource: 'saved-jobs-digest',
    campaign: 'saved-jobs-digest',
  });

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(s.heroTitle)} — Frontaliere Ticino</title>
<style>
body{margin:0;padding:0;background:${LIGHT_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;}
table{border-collapse:collapse;}
@media only screen and (max-width:620px){
  .outer-table{width:100%!important;}
  .section-pad{padding-left:16px!important;padding-right:16px!important;}
}
</style>
</head>
<body>
  <div style="display:none!important;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(s.preheader)}&nbsp;&#8203;&#8203;&#8203;&#8203;</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${LIGHT_BG};">
    <tr><td align="center" style="padding:0;">
      <table class="outer-table" width="620" cellpadding="0" cellspacing="0" style="width:100%;max-width:620px;">

        <!-- Top bar -->
        <tr><td style="background:${BRAND_DARK};padding:14px 28px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:15px;font-weight:800;color:${WHITE};letter-spacing:-0.3px;">
                <span style="color:${BRAND_ORANGE};">●</span> Frontaliere Ticino
              </td>
              <td align="right" style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">
                <a target="_blank" rel="noopener noreferrer" href="${manageUrl}" style="color:${BRAND_ORANGE};text-decoration:none;">${escapeHtml(s.manageCta)}</a>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Hero -->
        <tr><td style="background:${BRAND_DARK};padding:20px 28px 28px;" class="section-pad">
          <div style="font-size:22px;font-weight:800;color:${WHITE};margin:0;">${escapeHtml(s.heroTitle)}</div>
          <div style="font-size:13px;color:${MUTED_ON_DARK};margin-top:6px;">${escapeHtml(s.heroDesc)}</div>
        </td></tr>

        ${recommendedBlockHtml}

        <!-- Section header -->
        <tr><td class="section-pad" style="background:${WHITE};padding:24px 28px 8px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:${BRAND_ORANGE};font-weight:700;margin:0 0 2px;">${escapeHtml(s.sectionLabel)}</div>
          <div style="font-size:18px;font-weight:800;color:${BRAND_DARK};margin:0;">${escapeHtml(s.sectionTitle)}</div>
          <div style="font-size:13px;color:${MUTED};margin:4px 0 0;">${escapeHtml(s.sectionDesc)}</div>
        </td></tr>

        <!-- Job cards -->
        <tr><td class="section-pad" style="background:${WHITE};padding:8px 28px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            ${cardsHtml}
            ${recoHtml}
            <tr><td style="text-align:center;padding-top:14px;">
              <a target="_blank" rel="noopener noreferrer" href="${manageUrl}" style="display:inline-block;background:transparent;border:2px solid ${BRAND_ORANGE};color:${BRAND_ORANGE};font-weight:700;font-size:13px;text-decoration:none;padding:11px 28px;border-radius:8px;">${escapeHtml(s.manageCta)}</a>
            </td></tr>
          </table>
        </td></tr>

        <!-- Closer -->
        <tr><td class="section-pad" style="background:${WHITE};padding:0 28px 20px;">
          <div style="background:${CARD_BG};border-radius:12px;padding:18px 20px;text-align:center;">
            <div style="font-size:14px;color:#334155;line-height:1.5;margin:0 0 8px;">${escapeHtml(s.closer)}</div>
            <div style="font-size:12px;color:${BRAND_ORANGE};font-weight:700;">${escapeHtml(s.closerSign)}</div>
          </div>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:${BRAND_DARK};padding:28px;text-align:center;">
          <div style="font-size:11px;color:${MUTED_ON_DARK};margin:0 0 14px;line-height:1.5;">
            ${escapeHtml(s.footerSentTo(email))}
          </div>
          <div style="margin-bottom:12px;">
            <a target="_blank" rel="noopener noreferrer" href="https://www.facebook.com/profile.php?id=61588174947294" style="display:inline-block;margin:0 6px;font-size:18px;text-decoration:none;">📘</a>
            <a target="_blank" rel="noopener noreferrer" href="https://www.linkedin.com/company/frontaliere-ticino" style="display:inline-block;margin:0 6px;font-size:18px;text-decoration:none;">💼</a>
            <a target="_blank" rel="noopener noreferrer" href="${BASE_URL}" style="display:inline-block;margin:0 6px;font-size:18px;text-decoration:none;">🌐</a>
          </div>
          <div style="font-size:12px;color:${MUTED_ON_DARK};margin:4px 0;">
            <a target="_blank" rel="noopener noreferrer" href="${manageUrl}" style="color:${BRAND_ORANGE};text-decoration:underline;font-weight:600;">${escapeHtml(s.manageLink)}</a>
          </div>
          <div style="font-size:12px;color:${MUTED_ON_DARK};margin:4px 0;">
            ${escapeHtml(s.unsubLine)} <a target="_blank" rel="noopener noreferrer" href="${unsubUrl}" style="color:${MUTED_ON_DARK};text-decoration:underline;">${escapeHtml(s.unsubLink)}</a>
          </div>
          <div style="font-size:12px;color:${MUTED_ON_DARK};margin-top:12px;">© ${new Date().getFullYear()} Frontaliere Ticino · 0% spam, 100% frontaliere</div>
          <div style="font-size:11px;color:${MUTED_ON_DARK};margin-top:6px;">${escapeHtml(dataControllerFooterLine(locale))}</div>
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
  lines.push(
    '',
    `${s.textViewAllLine} ${manageUrl}`,
    '',
    `${s.textUnsubLine} ${unsubUrl}`,
    '',
    `© ${new Date().getFullYear()} Frontaliere Ticino`,
    dataControllerFooterLine(locale),
  );
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
  const html = buildEmailHtml({ locale, s, savedEntries, recommendations, manageUrl, unsubUrl, email });
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

    // Newsletter-document cross-check. Two things, not one: the address-level
    // hard signals (bounce / complaint / provider list) and the explicit
    // newsletter opt-out. Until #5688 this read only the first half, so a
    // person who clicked "disiscriviti" kept getting this weekly reminder —
    // the same defect the two alert senders had, from the same cause (the
    // predicate answered "does this mailbox work", not "did they ask us to
    // stop"). The channel's OWN opt-out is separate and checked above
    // (`users/{uid}.savedJobsDigest.optedOut`); it does not propagate back to
    // the newsletter, which is why savedJobsDigestUnsubscribe.js writes only
    // under `users/{uid}`.
    const subscriberDoc = await db.collection('newsletter_subscribers').doc(email.toLowerCase()).get();
    if (subscriberDoc.exists && isCrossChannelStop(subscriberDoc.data() || {})) {
      skippedCount++;
      continue;
    }

    const savedEntries = entries
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
      .slice(0, MAX_SAVED_LISTED)
      .map((entry) => {
        const job = jobsById.get(entry.id);
        // Expired path: the job left data/jobs.json, so none of the card's
        // new fields (logo/location/date/sector) have a live source — only
        // `entry.category`, already persisted on the saved-job doc itself
        // (services/savedJobsService.ts), survives to feed the sector tag.
        if (!job) {
          return {
            ...entry,
            expired: true,
            url: null,
            company: entry.company,
            title: entry.title,
            canton: entry.canton,
            sector: entry.category,
          };
        }
        return {
          ...entry,
          expired: false,
          url: jobPageUrl(job, locale),
          title: jobTitle(job, locale),
          company: job.company || entry.company,
          canton: job.canton || entry.canton,
          location: job.location || job.addressLocality || null,
          postedDate: job.postedDate || null,
          sector: job.sector || job.category || entry.category || null,
          companyKey: job.companyKey || null,
          // Salary/contract/firstSeenAt (#6104): same badge fields as
          // send-job-alerts.mjs's jobCards — live-only, so only carried on
          // the non-expired path (a departed job has no current salary to
          // present as still valid).
          firstSeenAt: job.firstSeenAt || null,
          salaryMin: job.salaryMin ?? null,
          salaryMax: job.salaryMax ?? null,
          currency: job.currency || null,
          baseSalary: job.baseSalary || null,
          contract: job.contract || null,
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
            location: job.location || job.addressLocality || null,
            postedDate: job.postedDate || null,
            sector: job.sector || job.category || null,
            companyKey: job.companyKey || null,
            url: jobPageUrl(job, locale),
            firstSeenAt: job.firstSeenAt || null,
            salaryMin: job.salaryMin ?? null,
            salaryMax: job.salaryMax ?? null,
            currency: job.currency || null,
            baseSalary: job.baseSalary || null,
            contract: job.contract || null,
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

export { main, jobPageUrl, makeUnsubscribeUrl, loadJobsById, renderJobCard, formatPostedDate, getStrings };
