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
    initializeApp({ credential: cert(cred) });
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

  // If no keywords required, location is sufficient
  if (alert.keywords?.length === 0 && score === 0) return 0;

  return Math.max(score, 1);
}

// ── Email template ───────────────────────────────────────────

function buildAlertEmail(alert, matchedJobs) {
  const keyword = alert.keywords?.join(', ') || 'tutte le offerte';
  const subject = `🔔 ${matchedJobs.length} nuov${matchedJobs.length === 1 ? 'a offerta' : 'e offerte'} per: ${keyword}`;

  const jobCards = matchedJobs.slice(0, 10).map((job) => {
    const title = job.titleByLocale?.it || job.title || 'Offerta di lavoro';
    const company = job.company || '';
    const location = job.location || job.addressLocality || '';
    const slug = job.slugByLocale?.it || job.slug || '';
    const url = slug ? `${BASE_URL}/cerca-lavoro-ticino/${slug}?utm_source=job_alert&utm_medium=email&utm_campaign=alert_${alert.id}` : BASE_URL;

    return `
      <tr>
        <td style="padding:12px 16px;border-bottom:1px solid #e2e8f0;">
          <a href="${url}" style="color:#4f46e5;text-decoration:none;font-weight:600;font-size:15px;">${escHtml(title)}</a>
          <div style="color:#64748b;font-size:13px;margin-top:4px;">
            ${company ? `${escHtml(company)}` : ''}${company && location ? ' — ' : ''}${location ? escHtml(location) : ''}
          </div>
        </td>
      </tr>`;
  }).join('');

  const manageUrl = `${BASE_URL}/?tab=lavoro&utm_source=job_alert&utm_medium=email&utm_campaign=manage`;

  const html = `<!DOCTYPE html>
<html lang="it">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:system-ui,-apple-system,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;">
    <div style="text-align:center;margin-bottom:24px;">
      <h1 style="font-size:20px;color:#1e293b;margin:0;">🔔 Nuove offerte per te</h1>
      <p style="color:#64748b;font-size:14px;margin:8px 0 0;">Ricerca: <strong>${escHtml(keyword)}</strong></p>
    </div>
    <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
      ${jobCards}
    </table>
    <div style="text-align:center;margin-top:24px;">
      <a href="${BASE_URL}/cerca-lavoro-ticino/?utm_source=job_alert&utm_medium=email" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Vedi tutte le offerte →</a>
    </div>
    <div style="text-align:center;margin-top:32px;padding-top:16px;border-top:1px solid #e2e8f0;">
      <p style="color:#94a3b8;font-size:12px;margin:0;">
        <a href="${manageUrl}" style="color:#94a3b8;">Gestisci le tue alert</a> ·
        <a href="${manageUrl}" style="color:#94a3b8;">Disiscriviti</a>
      </p>
      <p style="color:#cbd5e1;font-size:11px;margin:8px 0 0;">Frontaliere Ticino — frontaliereticino.ch</p>
    </div>
  </div>
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

  // 2b. Skip weekly alerts if last sent within 7 days
  const now = Date.now();
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
