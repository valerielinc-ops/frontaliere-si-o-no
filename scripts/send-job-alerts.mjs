#!/usr/bin/env node
/**
 * FRO-333: Send Job Alert emails to subscribed users.
 *
 * Reads active job alerts from Firestore, matches them against jobs
 * added/updated in the last 24h, and sends email notifications via Resend API.
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
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const BASE_URL = 'https://frontaliereticino.ch';
const FROM_EMAIL = 'Frontaliere Ticino <alerts@frontaliereticino.ch>';
const DRY_RUN = process.argv.includes('--dry-run');
const MATCH_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// Testing allowlist: set to a Set of emails for admin-only testing,
// or null to enable for all users.
const ALLOWED_EMAILS = null;

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
  const keyword = alert.keywords?.join(', ') || '';
  const locationLabel = alert.locations?.length > 0 ? alert.locations.join(', ') : '';
  const subjectLabel = keyword || locationLabel || 'le tue offerte';
  const subject = `🔔 ${matchedJobs.length} nuov${matchedJobs.length === 1 ? 'a offerta' : 'e offerte'} per: ${subjectLabel}`;

  // Brand colors (aligned with newsletter-template.mjs)
  const BRAND_ORANGE = '#f97316';
  const BRAND_DARK = '#0f172a';
  const DARK_CARD = '#1e293b';
  const LIGHT_BG = '#f1f5f9';
  const WHITE = '#ffffff';
  const MUTED = '#64748b';
  const BORDER = '#e2e8f0';

  const utmBase = `utm_source=job_alert&utm_medium=email&utm_campaign=alert_${alert.id}`;

  const jobCards = matchedJobs.slice(0, 10).map((job) => {
    const title = job.titleByLocale?.it || job.title || 'Offerta di lavoro';
    const company = job.company || '';
    const rawLocation = job.location || job.addressLocality || '';
    const location = rawLocation.replace(/^[-–—\s]+/, '').trim();
    const slug = job.slugByLocale?.it || job.slug || '';
    const url = slug ? `${BASE_URL}/cerca-lavoro-ticino/${slug}?${utmBase}` : BASE_URL;
    const initial = (company || '?')[0].toUpperCase();
    const tags = [];
    // "NEW" badge for jobs first seen within 48 hours
    const firstSeen = job.firstSeenAt ? new Date(job.firstSeenAt).getTime() : 0;
    const isNew = firstSeen > 0 && (Date.now() - firstSeen) < 48 * 60 * 60 * 1000;
    if (isNew) tags.push(`<span style="font-size:10px;background:rgba(34,197,94,0.2);color:#86efac;padding:2px 8px;border-radius:6px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">\u2728 NUOVA</span>`);
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

  const manageUrl = `${BASE_URL}/cerca-lavoro-ticino/?${utmBase}`;
  const allJobsUrl = `${BASE_URL}/cerca-lavoro-ticino/?${utmBase}`;

  const filterParts = [];
  if (keyword) filterParts.push(keyword);
  if (alert.locations?.length > 0) filterParts.push(alert.locations.join(', '));
  if (alert.sectors?.length > 0) filterParts.push(alert.sectors.join(', '));
  const filterSummary = escHtml(filterParts.length > 0 ? filterParts.join(' \u00b7 ') : 'tutte le offerte');

  const html = `<!DOCTYPE html>
<html lang="it">
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
  <div style="display:none!important;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${matchedJobs.length} nuove offerte: ${subjectLabel}&nbsp;\u200c\u200c\u200c\u200c</div>
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
          <div style="font-size:22px;font-weight:800;color:${WHITE};margin:0;">\ud83d\udd14 ${matchedJobs.length} nuov${matchedJobs.length === 1 ? 'a offerta' : 'e offerte'} per te</div>
          <div style="font-size:13px;color:#94a3b8;margin-top:6px;">Filtri: ${filterSummary}</div>
        </td></tr>

        <!-- Section header -->
        <tr><td class="section-pad" style="background:${WHITE};padding:24px 28px 8px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:${BRAND_ORANGE};font-weight:700;margin:0 0 2px;">\ud83d\udcbc Lavoro</div>
          <div style="font-size:18px;font-weight:800;color:${BRAND_DARK};margin:0;">Le offerte che fanno per te</div>
          <div style="font-size:13px;color:${MUTED};margin:4px 0 0;">Selezionate in base ai tuoi filtri, aggiornate ogni giorno.</div>
        </td></tr>

        <!-- Job cards -->
        <tr><td class="section-pad" style="background:${WHITE};padding:8px 28px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            ${jobCards}
            <tr><td style="text-align:center;padding-top:14px;">
              <a href="${allJobsUrl}" style="display:inline-block;background:transparent;border:2px solid ${BRAND_ORANGE};color:${BRAND_ORANGE};font-weight:700;font-size:13px;text-decoration:none;padding:11px 28px;border-radius:8px;">Vedi tutte le offerte \u2192</a>
            </td></tr>
          </table>
        </td></tr>

        <!-- Divider -->
        <tr><td style="padding:0 28px;background:${WHITE};"><div style="border-top:1px solid ${BORDER};"></div></td></tr>

        <!-- Footer -->
        <tr><td style="background:${WHITE};padding:20px 28px 24px;text-align:center;">
          <p style="color:${MUTED};font-size:12px;margin:0 0 8px;">
            <a href="${manageUrl}" style="color:${BRAND_ORANGE};text-decoration:none;font-weight:600;">Gestisci le tue alert</a>
            <span style="color:#cbd5e1;"> \u00b7 </span>
            <a href="${manageUrl}" style="color:${MUTED};text-decoration:none;">Disiscriviti</a>
          </p>
          <p style="color:#cbd5e1;font-size:11px;margin:0;">
            Ricevi questa email perch\u00e9 hai attivato un alert su
            <a href="${BASE_URL}" style="color:#cbd5e1;">frontaliereticino.ch</a>
          </p>
          <p style="color:#cbd5e1;font-size:10px;margin:8px 0 0;">\u00a9 ${new Date().getFullYear()} Frontaliere Ticino \u2014 0% spam, 100% frontaliere</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html };
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
    },
    recipient: { email: e.to },
    meta: { type: 'job-alert' },
  }));

  const result = await sendEmailCascade(cascadeEmails, { concurrency: 3 });
  logProviderSummary();
  return { sent: result.sent.length, failed: result.failed.length };
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

  // 1. Load recent jobs
  const recentJobs = loadRecentJobs();
  console.log(`   Recent jobs (last 24h): ${recentJobs.length}`);
  if (recentJobs.length === 0) {
    console.log('   No recent jobs — skipping.');
    return;
  }

  // 2. Load active alerts from Firestore
  const db = await getFirestoreAdmin();
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
  const NEWSLETTER_COOLDOWN_MS = 36 * 60 * 60 * 1000;
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
    const { subject, html } = buildAlertEmail(alert, matched);

    emailsToSend.push({
      to: alert.email,
      subject,
      html,
      alertId: alert.id,
      matchCount: matched.length,
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
