#!/usr/bin/env node
/**
 * FRO-333: Send Job Alert emails to subscribed users.
 *
 * Reads active job alerts from Firestore, matches them against jobs
 * added/updated in the last 24h, and sends email notifications via the
 * multi-provider email cascade (Mailgun → Resend → Unosend).
 *
 * Retry mechanism: When all providers exhaust their daily quota and emails
 * fail, they are written to the Firestore `job_alert_retry_queue` collection.
 * On the next run (daily at 07:00 UTC), retries are processed FIRST to get
 * priority on fresh provider quota. Max 2 retries per email (3 total attempts).
 *
 * Environment variables:
 *   RESEND_API_KEY            — Resend API key
 *   GOOGLE_APPLICATION_CREDENTIALS — Firebase service account for Firestore
 *
 * Usage:
 *   node scripts/send-job-alerts.mjs [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const BASE_URL = 'https://frontaliereticino.ch';
const FROM_EMAIL = 'Frontaliere Ticino <alerts@frontaliereticino.ch>';
const DRY_RUN = process.argv.includes('--dry-run');
const MATCH_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_RETRY_COUNT = 2; // Max 2 retries (original + 2 = 3 total attempts)
const RETRY_COLLECTION = 'job_alert_retry_queue';

// Testing allowlist: set to a Set of emails for admin-only testing,
// or null to enable for all users.
const ALLOWED_EMAILS = null;

// Cloud Function URL for one-click unsubscribe (RFC 8058)
const UNSUB_FUNCTION_URL = 'https://europe-west6-frontaliere-ticino.cloudfunctions.net/jobAlertUnsubscribe';

// Locale-aware job board URL paths (must match router.ts slug tables)
const JOB_BOARD_PATHS = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};

// ── i18n strings for email template ─────────────────────────
const EMAIL_STRINGS = {
  it: {
    subjectNew: (n) => `\ud83d\udd14 ${n} nuov${n === 1 ? 'a offerta' : 'e offerte'}`,
    subjectFor: 'per',
    subjectDefault: 'le tue offerte',
    preheader: (n, label) => `${n} nuove offerte: ${label}`,
    heroTitle: (n) => `\ud83d\udd14 ${n} nuov${n === 1 ? 'a offerta' : 'e offerte'} per te`,
    filters: 'Filtri',
    sectionLabel: '\ud83d\udcbc Lavoro',
    sectionTitle: 'Le offerte che fanno per te',
    sectionDesc: 'Selezionate in base ai tuoi filtri, aggiornate ogni giorno.',
    viewAll: 'Vedi tutte le offerte \u2192',
    closer: 'Conosci qualcuno che cerca lavoro in Ticino? Inoltra questa email.',
    closerSign: 'Alla prossima. \u2615',
    manageAlerts: 'Gestisci le tue alert',
    unsubThis: (filters) => `Non vuoi pi\u00f9 ricevere alert per <strong>${filters}</strong>?`,
    unsubThisLink: 'Disiscriviti da questa alert',
    unsubAll: 'Disiscriviti da tutte le alert',
    unsubJoke: '\u2014 giuro che non piangeremo. (Forse un po\'.)',
    newBadge: '\u2728 NUOVA',
    fallbackTitle: 'Offerta di lavoro',
    allOffers: 'tutte le offerte',
  },
  en: {
    subjectNew: (n) => `\ud83d\udd14 ${n} new job${n === 1 ? '' : 's'}`,
    subjectFor: 'for',
    subjectDefault: 'your alerts',
    preheader: (n, label) => `${n} new jobs: ${label}`,
    heroTitle: (n) => `\ud83d\udd14 ${n} new job${n === 1 ? '' : 's'} for you`,
    filters: 'Filters',
    sectionLabel: '\ud83d\udcbc Jobs',
    sectionTitle: 'Jobs that match your criteria',
    sectionDesc: 'Selected based on your filters, updated every day.',
    viewAll: 'View all jobs \u2192',
    closer: 'Know someone looking for a job in Ticino? Forward this email.',
    closerSign: 'See you next time. \u2615',
    manageAlerts: 'Manage your alerts',
    unsubThis: (filters) => `Don't want alerts for <strong>${filters}</strong> anymore?`,
    unsubThisLink: 'Unsubscribe from this alert',
    unsubAll: 'Unsubscribe from all alerts',
    unsubJoke: '\u2014 we promise we won\'t cry. (Maybe a little.)',
    newBadge: '\u2728 NEW',
    fallbackTitle: 'Job offer',
    allOffers: 'all offers',
  },
  de: {
    subjectNew: (n) => `\ud83d\udd14 ${n} neue Stelle${n === 1 ? '' : 'n'}`,
    subjectFor: 'f\u00fcr',
    subjectDefault: 'Ihre Alerts',
    preheader: (n, label) => `${n} neue Stellen: ${label}`,
    heroTitle: (n) => `\ud83d\udd14 ${n} neue Stelle${n === 1 ? '' : 'n'} f\u00fcr Sie`,
    filters: 'Filter',
    sectionLabel: '\ud83d\udcbc Stellen',
    sectionTitle: 'Passende Stellenangebote',
    sectionDesc: 'Ausgew\u00e4hlt nach Ihren Filtern, t\u00e4glich aktualisiert.',
    viewAll: 'Alle Stellen ansehen \u2192',
    closer: 'Kennen Sie jemanden, der im Tessin arbeiten m\u00f6chte? Leiten Sie diese E-Mail weiter.',
    closerSign: 'Bis zum n\u00e4chsten Mal. \u2615',
    manageAlerts: 'Alerts verwalten',
    unsubThis: (filters) => `Keine Alerts mehr f\u00fcr <strong>${filters}</strong>?`,
    unsubThisLink: 'Von diesem Alert abmelden',
    unsubAll: 'Von allen Alerts abmelden',
    unsubJoke: '\u2014 wir weinen bestimmt nicht. (Vielleicht ein bisschen.)',
    newBadge: '\u2728 NEU',
    fallbackTitle: 'Stellenangebot',
    allOffers: 'alle Angebote',
  },
  fr: {
    subjectNew: (n) => `\ud83d\udd14 ${n} nouvelle${n === 1 ? '' : 's'} offre${n === 1 ? '' : 's'}`,
    subjectFor: 'pour',
    subjectDefault: 'vos alertes',
    preheader: (n, label) => `${n} nouvelles offres: ${label}`,
    heroTitle: (n) => `\ud83d\udd14 ${n} nouvelle${n === 1 ? '' : 's'} offre${n === 1 ? '' : 's'} pour vous`,
    filters: 'Filtres',
    sectionLabel: '\ud83d\udcbc Emploi',
    sectionTitle: 'Les offres qui vous correspondent',
    sectionDesc: 'S\u00e9lectionn\u00e9es selon vos filtres, mises \u00e0 jour chaque jour.',
    viewAll: 'Voir toutes les offres \u2192',
    closer: 'Vous connaissez quelqu\'un qui cherche un emploi au Tessin? Transf\u00e9rez cet email.',
    closerSign: '\u00c0 bient\u00f4t. \u2615',
    manageAlerts: 'G\u00e9rer vos alertes',
    unsubThis: (filters) => `Vous ne souhaitez plus recevoir d\'alertes pour <strong>${filters}</strong>?`,
    unsubThisLink: 'Se d\u00e9sabonner de cette alerte',
    unsubAll: 'Se d\u00e9sabonner de toutes les alertes',
    unsubJoke: '\u2014 promis, on ne pleurera pas. (Peut-\u00eatre un peu.)',
    newBadge: '\u2728 NOUVELLE',
    fallbackTitle: 'Offre d\'emploi',
    allOffers: 'toutes les offres',
  },
};

function getStrings(locale) {
  return EMAIL_STRINGS[locale] || EMAIL_STRINGS.it;
}

function makeAlertUnsubscribeUrl(alertId, email) {
  const secret = process.env.NEWSLETTER_SECRET;
  if (!secret) return `${BASE_URL}/cerca-lavoro-ticino/`;
  const token = createHmac('sha256', secret)
    .update(`job_alert_unsub:${alertId}:${email.toLowerCase().trim()}`)
    .digest('hex');
  return `${UNSUB_FUNCTION_URL}?alertId=${encodeURIComponent(alertId)}&email=${encodeURIComponent(email)}&token=${token}`;
}

function makeAllAlertsUnsubscribeUrl(email) {
  const secret = process.env.NEWSLETTER_SECRET;
  if (!secret) return `${BASE_URL}/cerca-lavoro-ticino/`;
  const token = createHmac('sha256', secret)
    .update(`job_alert_unsub_all:${email.toLowerCase().trim()}`)
    .digest('hex');
  return `${UNSUB_FUNCTION_URL}?email=${encodeURIComponent(email)}&token=${token}&action=unsubscribe_all`;
}

// ── Autologin (reuse newsletter pattern) ────────────────────

function generateAutologinCode(email) {
  const secret = process.env.NEWSLETTER_SECRET;
  if (!secret) return null;
  return createHmac('sha256', secret)
    .update('autologin:' + email.toLowerCase().trim())
    .digest('hex');
}

function makeAuthenticatedUrl(targetUrl, email, autologinCode, utmMedium = 'job_alert') {
  const url = new URL(targetUrl, BASE_URL);
  url.searchParams.set('ne', email.toLowerCase());
  if (autologinCode) url.searchParams.set('ac', autologinCode);
  url.searchParams.set('utm_medium', utmMedium);
  return url.toString();
}

// ── Firebase Admin SDK (lazy init) ───────────────────────────

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
    if (cred.project_id) {
      // Service account JSON (CI/CD)
      initializeApp({ credential: cert(cred) });
    } else {
      // ADC / user credentials (local dev)
      const { applicationDefault } = await import('firebase-admin/app');
      initializeApp({ credential: applicationDefault(), projectId: 'frontaliere-ticino' });
    }
  }
  _db = getFirestore();
  return _db;
}

// ── Load jobs from data/jobs.json ────────────────────────────

function loadRecentJobs() {
  if (!fs.existsSync(JOBS_PATH)) return [];
  const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf-8'));
  if (!Array.isArray(jobs)) return [];

  const cutoff = Date.now() - MATCH_WINDOW_MS;
  return jobs.filter((j) => {
    const crawledAt = new Date(j.crawledAt || j.postedDate || 0).getTime();
    return crawledAt >= cutoff;
  });
}

// ── Matching logic ───────────────────────────────────────────

function matchJobToAlert(job, alert) {
  let score = 0;

  // Keyword matching (title + description)
  if (alert.keywords?.length > 0) {
    const text = `${job.title || ''} ${job.description || ''} ${Object.values(job.titleByLocale || {}).join(' ')}`.toLowerCase();
    const keywordMatch = alert.keywords.some((kw) => text.includes(kw.toLowerCase()));
    if (keywordMatch) score += 3;
    else return 0; // Keywords required but none matched
  }

  // Location matching
  if (alert.locations?.length > 0) {
    const jobLoc = `${job.location || ''} ${job.addressLocality || ''} ${job.canton || ''}`.toLowerCase();
    const locMatch = alert.locations.some((loc) => jobLoc.includes(loc.toLowerCase()));
    if (locMatch) score += 2;
  }

  // Contract type matching
  if (alert.contractTypes?.length > 0) {
    const jobContract = (job.contract || '').toLowerCase();
    const contractMatch = alert.contractTypes.some((ct) => jobContract.includes(ct.toLowerCase()));
    if (contractMatch) score += 1;
  }

  // Sector matching
  if (alert.sectors?.length > 0) {
    const jobSector = (job.sector || '').toLowerCase();
    const sectorMatch = alert.sectors.some((s) => jobSector.includes(s.toLowerCase()));
    if (sectorMatch) score += 2;
  }

  // If no keywords required, location is sufficient
  if (alert.keywords?.length === 0 && score === 0) return 0;

  return Math.max(score, 1);
}

// ── Email template ───────────────────────────────────────────

function buildAlertEmail(alert, matchedJobs) {
  const locale = alert.locale || 'it';
  const s = getStrings(locale);
  const jobBoardPath = JOB_BOARD_PATHS[locale] || JOB_BOARD_PATHS.it;
  const autologinCode = generateAutologinCode(alert.email);

  const keyword = alert.keywords?.join(', ') || '';
  const locationLabel = alert.locations?.length > 0 ? alert.locations.join(', ') : '';
  const subjectLabel = keyword || locationLabel || s.subjectDefault;
  const subject = `${s.subjectNew(matchedJobs.length)} ${s.subjectFor}: ${subjectLabel}`;

  // Brand colors (aligned with newsletter-template.mjs)
  const BRAND_ORANGE = '#f97316';
  const BRAND_DARK = '#0f172a';
  const DARK_CARD = '#1e293b';
  const LIGHT_BG = '#f1f5f9';
  const WHITE = '#ffffff';
  const MUTED = '#64748b';
  const CARD_BG = '#f8fafc';

  const utmBase = `utm_source=job_alert&utm_medium=email&utm_campaign=alert_${alert.id}`;
  const unsubscribeUrl = makeAlertUnsubscribeUrl(alert.id, alert.email);
  const unsubAllUrl = makeAllAlertsUnsubscribeUrl(alert.email);

  // Build locale-aware URLs with autologin
  const wrapUrl = (rawUrl) => makeAuthenticatedUrl(rawUrl, alert.email, autologinCode);
  const manageUrl = wrapUrl(`${BASE_URL}/${jobBoardPath}/?${utmBase}`);
  const allJobsUrl = wrapUrl(`${BASE_URL}/${jobBoardPath}/?${utmBase}`);

  const jobCards = matchedJobs.slice(0, 10).map((job) => {
    const title = job.titleByLocale?.[locale] || job.titleByLocale?.it || job.title || s.fallbackTitle;
    const company = job.company || '';
    const rawLocation = job.location || job.addressLocality || '';
    const location = rawLocation.replace(/^[-\u2013\u2014\s]+/, '').trim();
    const slug = job.slugByLocale?.[locale] || job.slugByLocale?.it || job.slug || '';
    const rawJobUrl = slug ? `${BASE_URL}/${jobBoardPath}/${slug}?${utmBase}` : BASE_URL;
    const url = wrapUrl(rawJobUrl);
    const initial = (company || '?')[0].toUpperCase();
    const tags = [];
    // "NEW" badge for jobs first seen within 48 hours
    const firstSeen = job.firstSeenAt ? new Date(job.firstSeenAt).getTime() : 0;
    const isNew = firstSeen > 0 && (Date.now() - firstSeen) < 48 * 60 * 60 * 1000;
    if (isNew) tags.push(`<span style="font-size:10px;background:rgba(34,197,94,0.2);color:#86efac;padding:2px 8px;border-radius:6px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">${s.newBadge}</span>`);
    if (job.contract) tags.push(`<span style="font-size:10px;background:rgba(249,115,22,0.15);color:#fdba74;padding:2px 8px;border-radius:6px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">${escHtml(job.contract)}</span>`);
    if (location) tags.push(`<span style="font-size:10px;background:rgba(249,115,22,0.15);color:#fdba74;padding:2px 8px;border-radius:6px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">${escHtml(location)}</span>`);

    return `
        <tr><td style="padding:0 0 10px;">
          <a href="${url}" style="text-decoration:none;display:block;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:${DARK_CARD};border-radius:12px;">
              <tr>
                <td width="58" style="padding:16px 0 16px 18px;vertical-align:middle;">
                  <div style="width:44px;height:44px;border-radius:10px;background:linear-gradient(135deg,${BRAND_DARK},#334155);text-align:center;line-height:44px;font-size:18px;font-weight:800;color:${BRAND_ORANGE};">${initial}</div>
                </td>
                <td style="padding:16px 18px 16px 14px;vertical-align:middle;">
                  <div style="font-size:14px;font-weight:700;color:#f1f5f9;margin:0;overflow:hidden;text-overflow:ellipsis;">${escHtml(title)}</div>
                  <div style="font-size:12px;color:#94a3b8;margin-top:2px;">${escHtml(company)}${location ? ' \u00b7 ' + escHtml(location) : ''}</div>
                  ${tags.length > 0 ? `<div style="margin-top:4px;">${tags.join(' ')}</div>` : ''}
                </td>
              </tr>
            </table>
          </a>
        </td></tr>`;
  }).join('');

  const filterParts = [];
  if (keyword) filterParts.push(keyword);
  if (alert.locations?.length > 0) filterParts.push(alert.locations.join(', '));
  if (alert.sectors?.length > 0) filterParts.push(alert.sectors.join(', '));
  const filterLabel = filterParts.length > 0 ? filterParts.join(' \u00b7 ') : s.allOffers;
  const filterSummary = escHtml(filterLabel);

  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Job Alert \u2014 Frontaliere Ticino</title>
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
  <div style="display:none!important;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${s.preheader(matchedJobs.length, subjectLabel)}&nbsp;\u200c\u200c\u200c\u200c</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${LIGHT_BG};">
    <tr><td align="center" style="padding:0;">
      <table class="outer-table" width="620" cellpadding="0" cellspacing="0" style="width:100%;max-width:620px;">

        <!-- Top bar -->
        <tr><td style="background:${BRAND_DARK};padding:14px 28px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:15px;font-weight:800;color:${WHITE};letter-spacing:-0.3px;">
                <span style="color:${BRAND_ORANGE};">\u25cf</span> Frontaliere Ticino
              </td>
              <td align="right" style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;">
                Job Alert
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Hero -->
        <tr><td style="background:${BRAND_DARK};padding:20px 28px 28px;" class="section-pad">
          <div style="font-size:22px;font-weight:800;color:${WHITE};margin:0;">${s.heroTitle(matchedJobs.length)}</div>
          <div style="font-size:13px;color:#94a3b8;margin-top:6px;">${s.filters}: ${filterSummary}</div>
        </td></tr>

        <!-- Section header -->
        <tr><td class="section-pad" style="background:${WHITE};padding:24px 28px 8px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:${BRAND_ORANGE};font-weight:700;margin:0 0 2px;">${s.sectionLabel}</div>
          <div style="font-size:18px;font-weight:800;color:${BRAND_DARK};margin:0;">${s.sectionTitle}</div>
          <div style="font-size:13px;color:${MUTED};margin:4px 0 0;">${s.sectionDesc}</div>
        </td></tr>

        <!-- Job cards -->
        <tr><td class="section-pad" style="background:${WHITE};padding:8px 28px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            ${jobCards}
            <tr><td style="text-align:center;padding-top:14px;">
              <a href="${allJobsUrl}" style="display:inline-block;background:transparent;border:2px solid ${BRAND_ORANGE};color:${BRAND_ORANGE};font-weight:700;font-size:13px;text-decoration:none;padding:11px 28px;border-radius:8px;">${s.viewAll}</a>
            </td></tr>
          </table>
        </td></tr>

        <!-- Closer (aligned with newsletter) -->
        <tr><td class="section-pad" style="background:${WHITE};padding:0 28px 20px;">
          <div style="background:${CARD_BG};border-radius:12px;padding:18px 20px;text-align:center;">
            <div style="font-size:14px;color:#334155;line-height:1.5;margin:0 0 8px;">${s.closer}</div>
            <div style="font-size:12px;color:${BRAND_ORANGE};font-weight:700;">${s.closerSign}</div>
          </div>
        </td></tr>

        <!-- Footer (dark, aligned with newsletter) -->
        <tr><td style="background:${BRAND_DARK};padding:28px;text-align:center;">
          <div style="margin-bottom:12px;">
            <a href="https://www.facebook.com/profile.php?id=61588174947294" style="display:inline-block;margin:0 6px;font-size:18px;text-decoration:none;">\ud83d\udcd8</a>
            <a href="https://www.linkedin.com/company/frontaliere-ticino" style="display:inline-block;margin:0 6px;font-size:18px;text-decoration:none;">\ud83d\udcbc</a>
            <a href="${BASE_URL}" style="display:inline-block;margin:0 6px;font-size:18px;text-decoration:none;">\ud83c\udf10</a>
          </div>
          <div style="font-size:12px;color:${MUTED};margin:4px 0;">
            <a href="${manageUrl}" style="color:${BRAND_ORANGE};text-decoration:underline;font-weight:600;">${s.manageAlerts}</a>
          </div>
          <div style="font-size:12px;color:${MUTED};margin:4px 0;">
            ${s.unsubThis(filterLabel)} <a href="${unsubscribeUrl}" style="color:${BRAND_ORANGE};text-decoration:underline;">${s.unsubThisLink}</a>
          </div>
          <div style="font-size:12px;color:${MUTED};margin:4px 0;">
            <a href="${unsubAllUrl}" style="color:#94a3b8;text-decoration:underline;">${s.unsubAll}</a> ${s.unsubJoke}
          </div>
          <div style="font-size:12px;color:#475569;margin-top:12px;">\u00a9 ${new Date().getFullYear()} Frontaliere Ticino \u00b7 0% spam, 100% frontaliere</div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html, unsubscribeUrl };
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Send via email cascade (multi-provider) ──────────────────

async function sendBatch(emails) {
  // Use cascade for bulk sending
  const { sendEmailCascade, logProviderSummary } = await import('./lib/email-cascade.mjs');

  const cascadeEmails = emails.map(e => ({
    payload: {
      from: FROM_EMAIL,
      to: [e.to],
      subject: e.subject,
      html: e.html,
      tags: [{ name: 'type', value: 'job-alert' }],
      // RFC 8058: List-Unsubscribe + List-Unsubscribe-Post for one-click unsubscribe
      headers: e.unsubscribeUrl ? {
        'List-Unsubscribe': `<${e.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      } : undefined,
    },
    recipient: { email: e.to },
    meta: { type: 'job-alert', alertId: e.alertId },
  }));

  const result = await sendEmailCascade(cascadeEmails, { concurrency: 3 });
  logProviderSummary();
  return {
    sent: result.sent.length,
    failed: result.failed.length,
    failedItems: result.failed,
  };
}

// ── Retry queue: enqueue failed emails ──────────────────────

async function enqueueFailedEmails(db, failedItems) {
  if (failedItems.length === 0) return;
  const { FieldValue } = await import('firebase-admin/firestore');
  const batch = db.batch();
  let enqueued = 0;

  for (const item of failedItems) {
    const email = item.recipient?.email;
    const alertId = item.meta?.alertId || '';
    if (!email) continue;

    const docRef = db.collection(RETRY_COLLECTION).doc();
    batch.set(docRef, {
      alertId,
      email,
      subject: item.payload?.subject || '',
      html: item.payload?.html || '',
      createdAt: FieldValue.serverTimestamp(),
      retryCount: 0,
      error: (item.error || '').slice(0, 500),
    });
    enqueued++;
  }

  if (enqueued > 0) {
    await batch.commit();
    console.log(`   🔄 Enqueued ${enqueued} failed emails for retry (max ${MAX_RETRY_COUNT} retries)`);
  }
}

// ── Retry queue: process pending retries ────────────────────

async function processRetryQueue(db) {
  const snap = await db.collection(RETRY_COLLECTION).get();
  if (snap.empty) {
    console.log('   🔄 Retry queue: empty — nothing to retry');
    return;
  }

  console.log(`   🔄 Retry queue: ${snap.size} pending email(s) to retry`);
  const { sendEmailCascade, logProviderSummary } = await import('./lib/email-cascade.mjs');
  const { FieldValue } = await import('firebase-admin/firestore');

  const retryEmails = [];
  const retryDocs = [];

  for (const doc of snap.docs) {
    const data = doc.data();
    const retryCount = data.retryCount || 0;

    if (retryCount >= MAX_RETRY_COUNT) {
      // Max retries exhausted — give up
      console.warn(`   ⚠️  Giving up on email to ${data.email} (alert ${data.alertId}) after ${retryCount} retries`);
      await doc.ref.delete();
      continue;
    }

    retryEmails.push({
      payload: {
        from: FROM_EMAIL,
        to: [data.email],
        subject: data.subject,
        html: data.html,
        tags: [{ name: 'type', value: 'job-alert-retry' }],
      },
      recipient: { email: data.email },
      meta: { type: 'job-alert-retry', alertId: data.alertId },
    });
    retryDocs.push({ ref: doc.ref, data });
  }

  if (retryEmails.length === 0) {
    console.log('   🔄 Retry queue: all entries expired (max retries reached)');
    return;
  }

  console.log(`   🔄 Retrying ${retryEmails.length} email(s)...`);
  const result = await sendEmailCascade(retryEmails, { concurrency: 3 });
  logProviderSummary();

  // Build a set of successfully sent recipient emails for lookup
  const sentEmails = new Set(result.sent.map(s => s.recipient?.email));

  let successCount = 0;
  let reEnqueueCount = 0;

  for (const { ref, data } of retryDocs) {
    if (sentEmails.has(data.email)) {
      // Successfully retried — remove from queue
      await ref.delete();
      successCount++;
      console.log(`   ✅ Retry succeeded: ${data.email} (alert ${data.alertId})`);
    } else {
      // Still failed — increment retryCount
      const newCount = (data.retryCount || 0) + 1;
      if (newCount >= MAX_RETRY_COUNT) {
        console.warn(`   ⚠️  Giving up on email to ${data.email} (alert ${data.alertId}) after ${newCount} retries`);
        await ref.delete();
      } else {
        await ref.update({
          retryCount: newCount,
          lastRetryAt: FieldValue.serverTimestamp(),
          lastError: result.failed.find(f => f.recipient?.email === data.email)?.error?.slice(0, 500) || 'unknown',
        });
        reEnqueueCount++;
        console.log(`   🔄 Retry failed for ${data.email} — attempt ${newCount}/${MAX_RETRY_COUNT}, will retry tomorrow`);
      }
    }
  }

  console.log(`   🔄 Retry summary: ${successCount} succeeded, ${reEnqueueCount} will retry tomorrow`);
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log('🔔 Job Alert Matching — Starting...');
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  // FRO-353: Check feature flag from Firebase Remote Config
  // The flag is loaded by load-rc-env.mjs into process.env
  const featureEnabled = process.env.ENABLE_JOB_ALERTS === 'true';
  if (!featureEnabled) {
    console.log('   ⚠️  ENABLE_JOB_ALERTS is not true — skipping (feature flag off).');
    return;
  }

  // 0. Process retry queue FIRST — retries get priority on fresh daily quota
  const db = await getFirestoreAdmin();
  if (!DRY_RUN) {
    await processRetryQueue(db);
  } else {
    console.log('   🔵 DRY RUN — skipping retry queue processing');
  }

  // 1. Load recent jobs
  const recentJobs = loadRecentJobs();
  console.log(`   Recent jobs (last 24h): ${recentJobs.length}`);
  if (recentJobs.length === 0) {
    console.log('   No recent jobs — skipping.');
    return;
  }

  // 2. Load active alerts from Firestore
  const alertsSnap = await db.collection('job_alerts').where('active', '==', true).get();
  let alerts = alertsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  // Filter to allowed emails during testing phase
  if (ALLOWED_EMAILS) {
    const before = alerts.length;
    alerts = alerts.filter((a) => ALLOWED_EMAILS.has(String(a.email || '').toLowerCase()));
    if (before !== alerts.length) {
      console.log(`   ⚠️  Allowlist active: ${before} alerts → ${alerts.length} (admin-only testing)`);
    }
  }
  console.log(`   Active alerts: ${alerts.length}`);
  if (alerts.length === 0) {
    console.log('   No active alerts — skipping.');
    return;
  }

  // 2b. Newsletter cooldown: skip users who received a newsletter in the last 36 hours
  // SKIP_NEWSLETTER_COOLDOWN=1 bypasses this check (for manual test sends)
  const NEWSLETTER_COOLDOWN_MS = process.env.SKIP_NEWSLETTER_COOLDOWN === '1' ? 0 : 36 * 60 * 60 * 1000;
  const now = Date.now();
  const alertEmails = [...new Set(alerts.map((a) => a.email.toLowerCase()))];
  const newsletterCooldownSet = new Set();
  for (const email of alertEmails) {
    try {
      const subDoc = await db.collection('newsletter_subscribers').doc(email).get();
      if (subDoc.exists) {
        const lastSentAt = subDoc.data()?.last_sent_at;
        if (lastSentAt) {
          const ts = typeof lastSentAt.toMillis === 'function' ? lastSentAt.toMillis() : new Date(lastSentAt).getTime();
          if (now - ts < NEWSLETTER_COOLDOWN_MS) {
            newsletterCooldownSet.add(email.toLowerCase());
          }
        }
      }
    } catch {}
  }
  if (newsletterCooldownSet.size > 0) {
    const before = alerts.length;
    alerts = alerts.filter((a) => !newsletterCooldownSet.has(a.email.toLowerCase()));
    console.log(`   📬 Newsletter cooldown (36h): ${before - alerts.length} alerts deferred (newsletter sent recently)`);
  }

  // 2c. Skip weekly alerts if last sent within 7 days
  const WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
  alerts = alerts.filter((alert) => {
    if (alert.frequency === 'weekly' && alert.lastMatchedAt) {
      const lastSent = typeof alert.lastMatchedAt.toMillis === 'function'
        ? alert.lastMatchedAt.toMillis()
        : new Date(alert.lastMatchedAt).getTime();
      if (now - lastSent < WEEKLY_INTERVAL_MS) return false;
    }
    return true;
  });

  // 3. Match alerts to jobs
  const emailsToSend = [];
  let totalMatches = 0;

  for (const alert of alerts) {
    const matched = recentJobs
      .map((job) => ({ job, score: matchJobToAlert(job, alert) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((m) => m.job);

    if (matched.length === 0) continue;

    totalMatches += matched.length;
    const { subject, html, unsubscribeUrl } = buildAlertEmail(alert, matched);

    emailsToSend.push({
      to: alert.email,
      subject,
      html,
      alertId: alert.id,
      matchCount: matched.length,
      unsubscribeUrl,
    });

    console.log(`   📬 Alert ${alert.id}: ${matched.length} matches → ${alert.email}`);
  }

  console.log(`\n   Total: ${emailsToSend.length} emails, ${totalMatches} job matches`);

  if (emailsToSend.length === 0) {
    console.log('   No matches — no emails to send.');
    return;
  }

  // 4. Send emails
  if (DRY_RUN) {
    console.log('   🔵 DRY RUN — not sending emails');
  } else {
    const result = await sendBatch(emailsToSend);
    console.log(`   ✅ Sent ${result.sent} emails`);

    // 4b. Enqueue failed emails for retry on the next run
    if (result.failed > 0) {
      console.log(`   ❌ ${result.failed} email(s) failed — enqueuing for retry`);
      await enqueueFailedEmails(db, result.failedItems);
    }
  }

  // 5. Update Firestore: lastMatchedAt + matchCount
  if (!DRY_RUN) {
    const { FieldValue } = await import('firebase-admin/firestore');
    const batch = db.batch();
    for (const email of emailsToSend) {
      const ref = db.collection('job_alerts').doc(email.alertId);
      batch.update(ref, {
        lastMatchedAt: FieldValue.serverTimestamp(),
        matchCount: FieldValue.increment(email.matchCount),
      });
    }
    await batch.commit();
    console.log('   📊 Firestore updated');
  }

  console.log('\n🔔 Job Alert Matching — Done.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
