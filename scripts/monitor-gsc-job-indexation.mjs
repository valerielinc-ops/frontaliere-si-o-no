#!/usr/bin/env node
/**
 * Layer 3: Daily GSC Job Indexation Monitor (weekly until 2026-10-24)
 *
 * Proactive monitoring of job page indexation health via Google Search Console.
 *
 * What it does:
 * 1. Queries GSC Search Analytics for top 50 job pages by impressions
 * 2. Runs URL Inspection on 30 sampled pages
 * 3. Categorizes: PASS, FAIL, STALE, UNKNOWN
 * 4. If FAIL > 0 → creates GitHub issue (priority 1)
 * 4b. If richResultsResult reports actual structured-data errors (verdict
 *     FAIL or ERROR-severity detectedItems issues) → creates GitHub issue
 *     (priority 3), separate from indexation FAIL
 * 5. Submits stale URLs via IndexNow for re-crawl
 * 6. Logs summary with trend data
 * 7. Anti-regression for job rich results (scripts/lib/job-rich-result-guard.mjs):
 *    - JOB_LISTING clicks (searchAppearance, dataState all) vs the median of
 *      the same weekday over the 4 previous weeks: drop > 30% alerts;
 *    - share of sampled LIVE job pages Google reports with a "Job Postings"
 *      rich result: < 80% alerts. The sample is fixed (top job pages by
 *      impressions) + random (live job sitemaps, seeded by date).
 *    Either alert opens/updates ONE issue with a stable title. The live job
 *    pages found without a Jobs rich result are written to
 *    `--rich-missing-out <file>`, which scripts/submit-google-indexing-jobs.js
 *    notifies first (monitor-gsc-seo.yml runs the two back to back).
 *
 * Always exits 0 — alerting/monitoring only.
 *
 * Usage: node scripts/monitor-gsc-job-indexation.mjs [--dry-run] [--rich-missing-out <file>]
 *
 * Environment:
 *   GOOGLE_APPLICATION_CREDENTIALS — path to Service Account JSON
 *   GITHUB_TOKEN — for issue creation (optional)
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { JOB_BOARD_SECTION_PREFIX_SOURCE, getJobBoardSectionPrefix } from './lib/jobBoardSections.mjs';
import { isCompanyHubSlug } from '../services/newsletter-content.mjs';
import { sendEmailCascade, PROVIDERS, isProviderConfigured } from './lib/email-cascade.mjs';
import { utcDaysBefore } from './lib/analytics-settled-window.mjs';
import { buildScheda } from './lib/monitor-scheda.mjs';
import { enqueueDeployRearmRequest } from './ci/deploy-rearm-request.mjs';
import {
  hasJobPostingRichResult,
  pickEvaluationDay,
  evaluateWeekdayDrop,
  evaluateRichShare,
  seededSample,
  CLICK_DROP_THRESHOLD,
  RICH_SHARE_THRESHOLD,
} from './lib/job-rich-result-guard.mjs';
import { isJobDetailCandidate, parseJobSitemapIndex, parseSitemapUrlset, judgeLive } from './lib/indexing-jobs-planner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_URL = 'https://frontaliereticino.ch';
// Any canton's job-board section root (TI legacy + every canton + the
// Switzerland-wide aggregator) — see scripts/lib/jobBoardSections.mjs.
const JOB_BOARD_LISTING_ROOT_RX = new RegExp(`/(?:${JOB_BOARD_SECTION_PREFIX_SOURCE})-[a-z][a-z-]*/$`);
const MAX_ANALYTICS_PAGES = 50;
const MAX_INSPECT = 30;
// Fixed half of the sample (top job pages by impressions); the rest is random
// from the live job sitemaps so a regression on long-tail jobs is visible too.
const FIXED_SAMPLE = 15;
const APPEARANCE_LOOKBACK_DAYS = 40;
// Cloudflare answers 403 to Node's default fetch user agent (measured
// 2026-10-24): every fetch of our own pages must identify itself.
const SITE_FETCH = { headers: { 'User-Agent': 'frontaliere-gsc-monitor/1.0 (+https://frontaliereticino.ch)' } };
const RICH_MISSING_OUT = (() => {
  const i = process.argv.indexOf('--rich-missing-out');
  return i > -1 ? process.argv[i + 1] : null;
})();
const FETCH_TIMEOUT_MS = 20_000;
const DRY_RUN = process.argv.includes('--dry-run');
const HISTORY_FILE = join(__dirname, '..', 'data', 'gsc-monitor-history.json');

// Closed-loop thresholds
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'valerielinc@gmail.com';
const FAIL_RATE_THRESHOLD = 0.05; // 5% fail rate triggers alert
const PERSISTENCE_WEEKS = 2; // failures persisting 2+ weeks → escalation

// ── Helpers ─────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(emoji, msg) { console.log(`${emoji}  ${msg}`); }

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// ── Service Account Auth ────────────────────────────────────
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const GSC_SCOPES = 'https://www.googleapis.com/auth/webmasters';

function loadServiceAccount() {
  const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!saPath || !existsSync(saPath)) return null;
  try {
    const sa = JSON.parse(readFileSync(saPath, 'utf-8'));
    return (sa.client_email && sa.private_key) ? sa : null;
  } catch { return null; }
}

function createJwt(sa) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email, scope: GSC_SCOPES, aud: TOKEN_URI, iat: now, exp: now + 3600,
  })}`;
  const sign = createSign('RSA-SHA256');
  sign.update(unsigned);
  return `${unsigned}.${sign.sign(sa.private_key, 'base64url')}`;
}

async function getAccessToken(sa) {
  const jwt = createJwt(sa);
  const res = await fetchWithTimeout(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  return (await res.json()).access_token;
}

// ── GSC API ─────────────────────────────────────────────────
async function detectSiteUrl(accessToken) {
  try {
    const res = await fetchWithTimeout('https://www.googleapis.com/webmasters/v3/sites', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return SITE_URL;
    const data = await res.json();
    const domain = data.siteEntry?.find(s => s.siteUrl === 'sc-domain:frontaliereticino.ch');
    if (domain) return domain.siteUrl;
    const prefix = data.siteEntry?.find(s => s.siteUrl?.includes('frontaliereticino.ch'));
    return prefix?.siteUrl || SITE_URL;
  } catch { return SITE_URL; }
}

async function getTopJobPages(accessToken, siteUrl) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const endDate = new Date();
  const startDate = utcDaysBefore(endDate, 28);
  const fmt = d => d.toISOString().split('T')[0];

  try {
    const res = await fetchWithTimeout(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          startDate: fmt(startDate),
          endDate: fmt(endDate),
          dimensions: ['page'],
          dimensionFilterGroups: [{
            filters: [{
              dimension: 'page',
              operator: 'includingRegex',
              // Any canton's job-board section (TI legacy + every canton +
              // the Switzerland-wide aggregator), not TI only.
              expression: `/(?:${JOB_BOARD_SECTION_PREFIX_SOURCE})-[a-z][a-z-]*/.+`,
            }],
          }],
          rowLimit: MAX_ANALYTICS_PAGES,
          type: 'web',
        }),
      }
    );

    if (!res.ok) return [];
    const data = await res.json();
    return (data.rows || [])
      .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
      .map(r => r.keys[0]);
  } catch { return []; }
}

async function inspectUrl(accessToken, siteUrl, inspectionUrl) {
  try {
    const res = await fetchWithTimeout(
      'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inspectionUrl, siteUrl }),
      }
    );

    if (!res.ok) {
      if (res.status === 429 || res.status === 403) return { error: 'quota' };
      return { error: `http-${res.status}` };
    }

    const data = await res.json();
    const r = data.inspectionResult;
    const richResultsIssues = [];
    for (const detected of r?.richResultsResult?.detectedItems || []) {
      for (const item of detected.items || []) {
        for (const issue of item.issues || []) {
          if (issue.severity === 'ERROR') {
            richResultsIssues.push(`${detected.richResultType}: ${issue.issueMessage}`);
          }
        }
      }
    }
    return {
      verdict: r?.indexStatusResult?.verdict || 'UNKNOWN',
      canonical: r?.indexStatusResult?.userCanonical || null,
      googleCanonical: r?.indexStatusResult?.googleCanonical || null,
      richResults: r?.richResultsResult?.verdict || 'UNKNOWN',
      // The verdict is PASS even when only Breadcrumbs were detected: the
      // job-specific signal is the "Job Postings" item.
      hasJobs: hasJobPostingRichResult(r?.richResultsResult),
      richResultsIssues,
      crawlTime: r?.indexStatusResult?.lastCrawlTime || null,
      coverageState: r?.indexStatusResult?.coverageState || null,
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Daily clicks for one searchAppearance (JOB_LISTING / JOB_DETAILS), with
 * dataState "all" so the newest days are present (still partial: the guard
 * evaluates a day at least SETTLE_DAYS old).
 */
async function getAppearanceSeries(accessToken, siteUrl, appearance) {
  const end = new Date();
  const start = utcDaysBefore(end, APPEARANCE_LOOKBACK_DAYS);
  const fmt = d => d.toISOString().split('T')[0];
  try {
    const res = await fetchWithTimeout(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate: fmt(start),
          endDate: fmt(end),
          dimensions: ['date'],
          dimensionFilterGroups: [{ filters: [{ dimension: 'searchAppearance', operator: 'equals', expression: appearance }] }],
          dataState: 'all',
          rowLimit: 100,
          type: 'web',
        }),
      },
    );
    if (!res.ok) return { error: `http-${res.status}`, rows: [] };
    const data = await res.json();
    return { rows: (data.rows || []).map(r => ({ date: r.keys[0], clicks: r.clicks || 0, impressions: r.impressions || 0 })) };
  } catch (err) {
    return { error: err.message, rows: [] };
  }
}

/** Job-detail URLs from the live job sitemaps ([] when unreadable). */
async function loadLiveJobDetailUrls() {
  try {
    const idx = await fetchWithTimeout(`${SITE_URL}/sitemap.xml`, SITE_FETCH);
    if (!idx.ok) return [];
    const urls = new Set();
    for (const sm of parseJobSitemapIndex(await idx.text())) {
      const res = await fetchWithTimeout(sm, SITE_FETCH);
      if (!res.ok) continue;
      for (const { loc } of parseSitemapUrlset(await res.text())) if (isJobDetailCandidate(loc)) urls.add(loc);
    }
    return [...urls];
  } catch { return []; }
}

/** True when the page is served right now as an indexable job page with JobPosting. */
async function isLiveJobPage(url) {
  try {
    const res = await fetchWithTimeout(url, { ...SITE_FETCH, redirect: 'manual' });
    const html = res.status === 200 ? await res.text() : '';
    return judgeLive('URL_UPDATED', { status: res.status, html }) === 'ok';
  } catch { return false; }
}

// ── Analysis ────────────────────────────────────────────────
function categorize(result, pageUrl) {
  if (result.error) return 'UNKNOWN';

  const path = new URL(pageUrl).pathname;
  const sectionPrefix = getJobBoardSectionPrefix(path);
  const lastSegment = path.split('/').filter(Boolean).pop() || '';
  const isJobPage = sectionPrefix !== null &&
                    path !== sectionPrefix &&
                    !isCompanyHubSlug(lastSegment);

  // Canonical regression to listing page
  if (isJobPage && (JOB_BOARD_LISTING_ROOT_RX.test(result.googleCanonical || '') || JOB_BOARD_LISTING_ROOT_RX.test(result.canonical || ''))) {
    return 'FAIL';
  }

  // Indexed but no rich results on a job page
  if (isJobPage && result.verdict === 'PASS' && result.richResults !== 'PASS') {
    return 'WARN';
  }

  if (result.verdict === 'PASS') return 'PASS';
  if (result.verdict === 'NEUTRAL' || result.verdict === 'UNKNOWN') return 'STALE';
  return 'FAIL';
}

// ── History ─────────────────────────────────────────────────
function loadHistory() {
  try {
    if (existsSync(HISTORY_FILE)) {
      return JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return { runs: [] };
}

function saveHistory(history) {
  try {
    mkdirSync(dirname(HISTORY_FILE), { recursive: true });
    // Keep last 12 weeks
    history.runs = history.runs.slice(-12);
    writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    log('⚠️', `Failed to save history: ${err.message}`);
  }
}

// ── Persistence Detection ───────────────────────────────────
function detectPersistentFailures(history, currentFailedUrls) {
  if (history.runs.length < 2) return [];
  const persistent = [];

  for (const url of currentFailedUrls) {
    const urlPath = new URL(url).pathname;
    let consecutiveWeeks = 0;

    // Check from most recent backward
    for (let i = history.runs.length - 1; i >= 0; i--) {
      const run = history.runs[i];
      if (run.failedUrls?.some(u => u.includes(urlPath))) {
        consecutiveWeeks++;
      } else {
        break;
      }
    }

    if (consecutiveWeeks >= PERSISTENCE_WEEKS) {
      persistent.push({ url, urlPath, weeks: consecutiveWeeks });
    }
  }

  return persistent;
}

// ── Email Alert via cascade ─────────────────────────────────
async function sendEmailAlert({ results, failedPages, persistentFailures, sample }) {
  // Cascade-routed (2026-07-16, was a direct Resend fetch) — pacing +
  // fallback if Resend alone is exhausted (sibling-pattern sweep, same class
  // of bug as the direct Resend bypasses fixed elsewhere in this task). This
  // is a scripts/-side CI script (not a Cloud Function) — its credentials
  // already reach process.env.* via `node scripts/load-rc-env.mjs`, which
  // monitor-gsc-seo.yml runs before invoking this script, so no async
  // Remote Config bridge is needed here.
  if (!PROVIDERS.some((p) => isProviderConfigured(p.id))) {
    log('ℹ️', 'No email provider configured — skipping email alert');
    return;
  }

  const failRate = sample.length > 0 ? results.FAIL / sample.length : 0;
  const hasPersistent = persistentFailures.length > 0;

  // Only send if fail rate exceeds threshold or there are persistent failures
  if (failRate < FAIL_RATE_THRESHOLD && !hasPersistent) {
    log('ℹ️', `Fail rate ${(failRate * 100).toFixed(1)}% < ${FAIL_RATE_THRESHOLD * 100}% — no email alert`);
    return;
  }

  const date = new Date().toISOString().split('T')[0];
  const subject = hasPersistent
    ? `🚨 PERSISTENT SEO Issues — ${persistentFailures.length} page(s) failing ${PERSISTENCE_WEEKS}+ weeks`
    : `⚠️ SEO Monitor Alert — ${results.FAIL} failure(s) detected (${date})`;

  const html = [
    '<div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">',
    '<h2 style="color: #dc2626;">GSC Job Indexation Monitor</h2>',
    `<p><strong>Date:</strong> ${date}</p>`,
    '<table style="border-collapse: collapse; width: 100%;">',
    '<tr><td style="padding: 4px 12px; border: 1px solid #e2e8f0;">✅ PASS</td><td style="padding: 4px 12px; border: 1px solid #e2e8f0;">' + results.PASS + '</td></tr>',
    '<tr><td style="padding: 4px 12px; border: 1px solid #e2e8f0;">⚠️ WARN</td><td style="padding: 4px 12px; border: 1px solid #e2e8f0;">' + results.WARN + '</td></tr>',
    '<tr style="background: #fef2f2;"><td style="padding: 4px 12px; border: 1px solid #e2e8f0;">❌ FAIL</td><td style="padding: 4px 12px; border: 1px solid #e2e8f0;">' + results.FAIL + '</td></tr>',
    '<tr><td style="padding: 4px 12px; border: 1px solid #e2e8f0;">🕒 STALE</td><td style="padding: 4px 12px; border: 1px solid #e2e8f0;">' + results.STALE + '</td></tr>',
    '</table>',
  ];

  if (failedPages.length > 0) {
    html.push('<h3>Failed Pages</h3>', '<ul>');
    for (const p of failedPages.slice(0, 10)) {
      const path = new URL(p.url).pathname;
      html.push(`<li><code>${path}</code> — canonical: <code>${p.googleCanonical || 'unknown'}</code></li>`);
    }
    html.push('</ul>');
  }

  if (hasPersistent) {
    html.push(
      '<h3 style="color: #dc2626;">⚠️ Persistent Failures (failing ' + PERSISTENCE_WEEKS + '+ weeks)</h3>',
      '<ul>'
    );
    for (const p of persistentFailures) {
      html.push(`<li><code>${p.urlPath}</code> — ${p.weeks} consecutive weeks</li>`);
    }
    html.push('</ul>');
  }

  html.push(
    '<hr style="border: none; border-top: 1px solid #e2e8f0; margin: 16px 0;">',
    '<p style="color: #64748b; font-size: 12px;">Sent by Frontaliere Ticino SEO Monitor • <a href="https://github.com/valerielinc-ops/frontaliere-si-o-no/actions">View Actions</a></p>',
    '</div>'
  );

  const { sent, failed } = await sendEmailCascade([{
    payload: {
      from: 'Frontaliere Ticino <alerts@frontaliereticino.ch>',
      to: ALERT_EMAIL,
      subject,
      html: html.join('\n'),
    },
    recipient: { email: ALERT_EMAIL },
    meta: {},
  }]);
  if (failed.length > 0) {
    log('⚠️', `Email alert failed: ${failed[0].error || 'unknown'}`);
  } else {
    log('📧', `Email alert sent to ${ALERT_EMAIL} via ${sent[0]?.provider || 'unknown'}`);
  }
}

// ── Auto-Redeploy Trigger ───────────────────────────────────
async function triggerRedeploy(failedPages) {
  // Only trigger for canonical regressions (fixable by redeploy)
  const canonicalFails = failedPages.filter(p =>
    JOB_BOARD_LISTING_ROOT_RX.test(p.googleCanonical || '') || JOB_BOARD_LISTING_ROOT_RX.test(p.canonical || '')
  );
  if (canonicalFails.length === 0) return;

  // deploy.yml is self-driven now. The monitor records one durable request on
  // the current SHA; only deploy.yml's own schedule/finalizer consumes it.
  log('ℹ️', `Canonical regression on ${canonicalFails.length} page(s); queueing one bounded self-driven re-arm and submitting to IndexNow`);
  try {
    const request = enqueueDeployRearmRequest({
      reason: 'canonical-regression',
      sourceRunId: process.env.GITHUB_RUN_ID,
      sourceSha: process.env.GITHUB_SHA,
    });
    log('  ', request.enqueued ? `durable re-arm queued for ${request.headSha}` : `durable re-arm already ${request.state} for ${request.headSha}`);
  } catch (error) {
    log('⚠️', `durable re-arm request failed: ${error?.message || error}`);
  }
  await submitToIndexNow(canonicalFails.map(p => p.url));
}

// ── Step Summary ────────────────────────────────────────────
function writeStepSummary({ results, sample, failedPages, warnPages, persistentFailures, history }) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;

  const lines = [
    '## 📊 Layer 3: GSC Job Indexation Monitor',
    '',
    `| Metric | Count |`,
    `|--------|-------|`,
    `| ✅ PASS | ${results.PASS} |`,
    `| ⚠️ WARN | ${results.WARN} |`,
    `| ❌ FAIL | ${results.FAIL} |`,
    `| 🕒 STALE | ${results.STALE} |`,
    `| ❓ UNKNOWN | ${results.UNKNOWN} |`,
    '',
    `**Inspected**: ${sample.length} pages (from ${MAX_ANALYTICS_PAGES} with impressions)`,
    '',
  ];

  if (failedPages.length > 0) {
    lines.push('### ❌ Failed Pages', '');
    for (const p of failedPages) {
      lines.push(`- \`${new URL(p.url).pathname}\` — canonical: \`${p.googleCanonical || 'unknown'}\``);
    }
    lines.push('');
  }

  if (persistentFailures?.length > 0) {
    lines.push(`### 🚨 Persistent Failures (${PERSISTENCE_WEEKS}+ weeks)`, '');
    for (const p of persistentFailures) {
      lines.push(`- \`${p.urlPath}\` — ${p.weeks} consecutive weeks`);
    }
    lines.push('');
  }

  if (history.runs.length > 1) {
    lines.push('### 📈 Trend', '', '| Date | PASS | FAIL | WARN | STALE |', '|------|------|------|------|-------|');
    for (const run of history.runs.slice(-6)) {
      lines.push(`| ${run.date} | ${run.PASS} | ${run.FAIL} | ${run.WARN} | ${run.STALE} |`);
    }
    lines.push('');
  }

  const failRate = sample.length > 0 ? results.FAIL / sample.length : 0;
  if (results.FAIL > 0) {
    lines.push(`> ⚠️ **Fail rate: ${(failRate * 100).toFixed(1)}%** — ${persistentFailures?.length > 0 ? 'PERSISTENT issues detected, escalated' : 'GitHub issue created'}`);
  } else {
    lines.push('> ✅ All monitored job pages healthy');
  }

  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  } catch { /* ignore */ }
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  log('📊', 'Layer 3: Daily GSC Job Indexation Monitor\n');

  if (DRY_RUN) log('ℹ️', 'DRY RUN — no GitHub issues or IndexNow submissions\n');

  const sa = loadServiceAccount();
  if (!sa) {
    log('⚠️', 'No Service Account credentials — skipping');
    return;
  }

  let accessToken;
  try {
    accessToken = await getAccessToken(sa);
    log('🔑', 'Authenticated via Service Account');
  } catch (err) {
    log('⚠️', `Auth failed: ${err.message}`);
    return;
  }

  const siteUrl = await detectSiteUrl(accessToken);
  log('🌐', `GSC site: ${siteUrl}`);

  // Sample: fixed (top job-detail pages by impressions) + random (live job
  // sitemaps, seeded by date so a same-day re-run inspects the same pages).
  const today = new Date().toISOString().split('T')[0];
  const topPages = await getTopJobPages(accessToken, siteUrl);
  const fixed = topPages.filter(isJobDetailCandidate).slice(0, FIXED_SAMPLE);
  const fixedSet = new Set(fixed);
  const randomPool = (await loadLiveJobDetailUrls()).filter(u => !fixedSet.has(u));
  const sample = [...fixed, ...seededSample(randomPool, MAX_INSPECT - fixed.length, today)];
  if (sample.length === 0) {
    log('ℹ️', 'No job page analytics data nor live job sitemap — done');
    return;
  }
  log('🔍', `Inspecting ${sample.length} pages (${fixed.length} fixed from ${topPages.length} with impressions, ${sample.length - fixed.length} random of ${randomPool.length} live)...\n`);
  const richRows = [];

  const results = { PASS: 0, FAIL: 0, WARN: 0, STALE: 0, UNKNOWN: 0 };
  const failedPages = [];
  const warnPages = [];
  const stalePages = [];

  for (const pageUrl of sample) {
    const liveJob = await isLiveJobPage(pageUrl);
    const result = await inspectUrl(accessToken, siteUrl, pageUrl);

    if (result.error === 'quota') {
      log('⚠️', 'API quota reached — stopping');
      break;
    }
    richRows.push({
      url: pageUrl,
      liveJob,
      inspected: !result.error,
      hasJobs: !!result.hasJobs,
      coverageState: result.coverageState || null,
      crawlTime: result.crawlTime || null,
    });

    const category = result.error ? 'UNKNOWN' : categorize(result, pageUrl);
    results[category]++;

    const path = new URL(pageUrl).pathname;
    const shortPath = path.slice(0, 65);

    switch (category) {
      case 'PASS':
        log('  ✅', `${shortPath} — PASS ${result.richResults === 'PASS' ? '(RR ✓)' : ''}`);
        break;
      case 'FAIL':
        log('  ❌', `${shortPath} — FAIL (canonical: ${result.googleCanonical || 'unknown'})`);
        failedPages.push({ url: pageUrl, ...result });
        break;
      case 'WARN':
        log('  ⚠️', `${shortPath} — indexed, no rich results`);
        warnPages.push({ url: pageUrl, ...result });
        break;
      case 'STALE':
        log('  🕒', `${shortPath} — ${result.verdict || 'pending'} (${result.coverageState || 'unknown'})`);
        stalePages.push({ url: pageUrl, ...result });
        break;
      default:
        log('  ❓', `${shortPath} — ${result.error || 'unknown'}`);
    }

    await sleep(200); // Gentle on API
  }

  // Summary
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  GSC Job Indexation Monitor — Summary');
  console.log(`${'═'.repeat(60)}`);
  console.log(`  ✅ PASS:    ${results.PASS}`);
  console.log(`  ⚠️  WARN:    ${results.WARN} (indexed, no rich results)`);
  console.log(`  ❌ FAIL:    ${results.FAIL} (canonical/schema regression)`);
  console.log(`  🕒 STALE:   ${results.STALE} (not yet crawled/indexed)`);
  console.log(`  ❓ UNKNOWN: ${results.UNKNOWN}`);
  console.log(`${'═'.repeat(60)}\n`);

  // Save history for trend tracking (with failed URLs for persistence detection)
  const history = loadHistory();
  const currentFailedUrls = failedPages.map(p => p.url);
  history.runs.push({
    date: new Date().toISOString().split('T')[0],
    inspected: sample.length,
    ...results,
    failedUrls: currentFailedUrls,
  });
  if (!DRY_RUN) saveHistory(history);

  // Detect persistent failures
  const persistentFailures = detectPersistentFailures(history, currentFailedUrls);
  if (persistentFailures.length > 0) {
    log('🚨', `${persistentFailures.length} PERSISTENT failure(s) (${PERSISTENCE_WEEKS}+ weeks):`);
    for (const p of persistentFailures) {
      log('  ', `  ${p.urlPath} — ${p.weeks} consecutive weeks`);
    }
    console.log();
  }

  // Print trend
  if (history.runs.length > 1) {
    log('📈', 'Trend (last runs):');
    for (const run of history.runs.slice(-4)) {
      log('  ', `  ${run.date}: PASS=${run.PASS} FAIL=${run.FAIL} WARN=${run.WARN} STALE=${run.STALE}`);
    }
    console.log();
  }

  // Write GitHub Step Summary
  writeStepSummary({ results, sample, failedPages, warnPages, persistentFailures, history });

  // Act on failures
  if (failedPages.length > 0 && !DRY_RUN) {
    const priority = persistentFailures.length > 0 ? 1 : 2;
    log('🚨', `${failedPages.length} FAIL(s) detected — creating GitHub issue (P${priority})`);
    await createGithubIssue(failedPages, results, priority, persistentFailures);

    // Auto-redeploy for canonical regressions
    await triggerRedeploy(failedPages);

    // Send email alert
    await sendEmailAlert({ results, failedPages, persistentFailures, sample });
  } else if (failedPages.length > 0 && DRY_RUN) {
    log('ℹ️', 'DRY RUN — would create GitHub issue + send email + trigger redeploy');
  }

  // Act on structured-data errors (indexed pages, but richResults verdict FAIL
  // or ERROR-severity detectedItems issues — excludes NEUTRAL/PARTIAL states
  // that just mean "no rich result attempted", not an actual problem).
  const structuredDataIssues = warnPages.filter(
    p => p.richResults === 'FAIL' || (p.richResultsIssues && p.richResultsIssues.length > 0)
  );
  if (structuredDataIssues.length > 0 && !DRY_RUN) {
    log('🚨', `${structuredDataIssues.length} page(s) with structured-data errors — creating GitHub issue (P3)`);
    await createStructuredDataIssue(structuredDataIssues);
  } else if (structuredDataIssues.length > 0 && DRY_RUN) {
    log('ℹ️', 'DRY RUN — would create structured-data GitHub issue');
  }

  // Re-submit stale pages via IndexNow
  if (stalePages.length > 0 && !DRY_RUN) {
    log('📤', `Submitting ${stalePages.length} stale URLs to IndexNow for re-crawl`);
    await submitToIndexNow(stalePages.map(p => p.url));
  }

  await checkRichResultRegression({ accessToken, siteUrl, today, richRows });
}

// ── Job rich result anti-regression ─────────────────────────
async function checkRichResultRegression({ accessToken, siteUrl, today, richRows }) {
  const share = evaluateRichShare(richRows);
  const appearances = {};
  for (const appearance of ['JOB_LISTING', 'JOB_DETAILS']) {
    const series = await getAppearanceSeries(accessToken, siteUrl, appearance);
    const day = pickEvaluationDay(series.rows, today);
    appearances[appearance] = day
      ? evaluateWeekdayDrop(series.rows, { day })
      : { day: null, alert: false, reason: series.error || 'no-data' };
  }
  const listing = appearances.JOB_LISTING;
  const fmtPct = v => (v == null ? 'n/a' : `${(v * 100).toFixed(0)}%`);

  log('🧪', `Jobs rich result share: ${share.withJobs}/${share.eligible} live job pages = ${fmtPct(share.share)} (threshold ${fmtPct(RICH_SHARE_THRESHOLD)}, ${share.reason})`);
  for (const [name, a] of Object.entries(appearances)) {
    log('🧪', `${name} clicks ${a.day || 'n/a'}: ${a.clicks ?? 'n/a'} vs same-weekday median ${a.baseline ?? 'n/a'} → drop ${fmtPct(a.drop)} (${a.reason})`);
  }

  const missing = richRows.filter(r => r.liveJob && !r.hasJobs).map(r => r.url);
  if (RICH_MISSING_OUT) {
    try {
      writeFileSync(RICH_MISSING_OUT, JSON.stringify({ date: today, urls: missing }, null, 2));
      log('💾', `${missing.length} live job page(s) without Jobs rich result → ${RICH_MISSING_OUT}`);
    } catch (err) { log('⚠️', `rich-missing write failed: ${err.message}`); }
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
        '### Job rich results guard',
        '',
        '| Signal | Value | Threshold | Alert |',
        '|---|---|---|---|',
        `| Live job pages with "Job Postings" | ${share.withJobs}/${share.eligible} (${fmtPct(share.share)}) | ≥ ${fmtPct(RICH_SHARE_THRESHOLD)} | ${share.alert ? '🔴' : '—'} |`,
        `| JOB_LISTING clicks ${listing.day || ''} vs weekday median | ${listing.clicks ?? 'n/a'} vs ${listing.baseline ?? 'n/a'} (${fmtPct(listing.drop)}) | drop ≤ ${fmtPct(CLICK_DROP_THRESHOLD)} | ${listing.alert ? '🔴' : '—'} |`,
        `| JOB_DETAILS clicks ${appearances.JOB_DETAILS.day || ''} (info) | ${appearances.JOB_DETAILS.clicks ?? 'n/a'} vs ${appearances.JOB_DETAILS.baseline ?? 'n/a'} | — | — |`,
        '',
      ].join('\n'));
    } catch { /* ignore */ }
  }

  if (!share.alert && !listing.alert) return;
  if (DRY_RUN) {
    log('ℹ️', 'DRY RUN — would open the job rich result regression issue');
    return;
  }
  const apiKey = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!apiKey) { log('ℹ️', 'GH_TOKEN/GITHUB_TOKEN not set — skipping issue'); return; }
  try {
    const { createGithubIssue: create } = await import('./lib/github-issue-creator.mjs');
    await create({
      title: RICH_REGRESSION_TITLE,
      description: buildRichRegressionIssueBody({ share, listing, details: appearances.JOB_DETAILS, rows: richRows }),
      priority: 1,
      labels: ['Bug', 'seo'],
      project: 'SEO',
    });
    log('📋', 'GitHub issue created (job rich result regression)');
  } catch (err) {
    log('⚠️', `GitHub issue creation failed: ${err.message}`);
  }
}

export const RICH_REGRESSION_TITLE = '[Monitor] job rich results regression (JOB_LISTING / Job Postings)';

/** Corpo della issue anti-regressione, scheda inclusa. Esportato per il test. */
export function buildRichRegressionIssueBody({ share, listing, details, rows }) {
  const pct = v => (v == null ? 'n/a' : `${(v * 100).toFixed(0)}%`);
  const missing = rows.filter(r => r.liveJob && !r.hasJobs);
  return [
    '## Job rich results — regressione rilevata',
    '',
    `**Data**: ${new Date().toISOString().split('T')[0]}`,
    `- Pagine annuncio live con rich result "Job Postings": **${share.withJobs}/${share.eligible} (${pct(share.share)})**, soglia ${pct(RICH_SHARE_THRESHOLD)}${share.alert ? ' — 🔴 sotto soglia' : ''}`,
    `- Clic JOB_LISTING del ${listing.day || 'n/a'}: **${listing.clicks ?? 'n/a'}** contro mediana ${listing.baseline ?? 'n/a'} dello stesso giorno della settimana nelle 4 settimane precedenti → calo ${pct(listing.drop)}${listing.alert ? ` — 🔴 oltre il ${pct(CLICK_DROP_THRESHOLD)}` : ''}`,
    `- Clic JOB_DETAILS del ${details?.day || 'n/a'} (informativo): ${details?.clicks ?? 'n/a'} contro ${details?.baseline ?? 'n/a'}`,
    '',
    '### Pagine live senza rich result Jobs nel campione',
    ...(missing.length
      ? missing.slice(0, 30).map(r => `- \`${new URL(r.url).pathname}\` — ${r.coverageState || 'stato sconosciuto'}, ultima scansione ${r.crawlTime || 'n/a'}`)
      : ['- nessuna (allarme dai soli clic)']),
    '',
    'Queste URL sono gia\' state accodate per prime all\'Indexing API dallo stesso workflow',
    '(`scripts/submit-google-indexing-jobs.js --priority-file`).',
    '',
    buildScheda({
      causa: [
        '(ipotesi, da confermare.) Google mostra meno annunci come offerte di lavoro. Le cause',
        "osservate finora: pagine servite senza JSON-LD JobPosting (4-22/10/2026, PR 11394) e",
        "Google che conserva lo stato dell'ultima scansione finche' non riscansiona.",
      ],
      fix: [
        "Verificare che le pagine elencate emettano JobPosting valido (`curl -s URL | grep JobPosting`);",
        "se si', la riscansione e' gia' richiesta via Indexing API; se no, correggere l'emissione. | **REPO**: sito.",
      ],
      metrica: `prima=${pct(share.share)} pagine con Jobs, calo clic ${pct(listing.drop)} atteso=share ≥ ${pct(RICH_SHARE_THRESHOLD)} e calo ≤ ${pct(CLICK_DROP_THRESHOLD)}`,
      comando: 'node scripts/monitor-gsc-job-indexation.mjs --dry-run',
      note: [
        'Il comando rifa la stessa misura senza coniare issue e stampa le due righe `🧪`.',
        'Vuole le credenziali Search Console: dalla root del workspace, `source bin/rc-env.sh`.',
      ],
      osservatore: [
        '`.github/workflows/monitor-gsc-seo.yml` (giornaliero), che rifa la misura e aggiorna',
        "questa issue finche' uno dei due segnali resta oltre soglia. Non c'e' un closer",
        "automatico: il comando qui sopra e' il criterio di chiusura.",
      ],
      fallimento: `\`${RICH_REGRESSION_TITLE}\``,
    }),
  ].join('\n');
}

// ── GitHub Issue ────────────────────────────────────────────
/** Il corpo della issue, scheda inclusa. Esportato perche' il test lo chiami. */
export function buildIndexationIssueBody(failedPages, results, priority = 1, persistentFailures = []) {
  return [
    '## GSC Job Indexation Monitor — Failures Detected',
    '',
    `**Date**: ${new Date().toISOString().split('T')[0]}`,
    `**Summary**: ${results.PASS} pass, ${results.FAIL} fail, ${results.WARN} warn, ${results.STALE} stale`,
    persistentFailures.length > 0
      ? `**PERSISTENT**: ${persistentFailures.length} page(s) still failing across consecutive runs (issue filed at priority ${priority}).`
      : '**Persistence**: first run with these failures.',
    '',
    '### Failed Pages',
    ...failedPages.map(p => {
      const path = new URL(p.url).pathname;
      return `- \`${path}\`\n  - Google canonical: \`${p.googleCanonical || 'unknown'}\`\n  - Crawled: ${p.crawlTime || 'unknown'}`;
    }),
    '',
    '### Investigation Steps',
    '1. Check if these pages have been re-deployed recently',
    '2. Run `npm run validate:spa-render` to verify SPA behavior',
    '3. Manually inspect via: `curl -s URL | grep canonical`',
    '4. Submit for re-crawl: `node scripts/submit-indexnow.js`',
    '',
    buildScheda({
      causa: [
        `(ipotesi, da confermare.) ${failedPages.length} pagina/e di annuncio non risultano`,
        'indicizzate come dovrebbero. La causa sta a monte del monitor e non in esso: una',
        'canonica che Google sceglie diversa dalla nostra, una pagina servita vuota al',
        'crawler, o un deploy che non ha ancora raggiunto quegli URL.',
      ],
      fix: [
        'Dipende da quale delle tre; non preassegnata qui. | **REPO**: sito.',
      ],
      metrica: `prima=${results.FAIL} pagine fail su ${results.PASS + results.FAIL + results.WARN + results.STALE} atteso=0 fail`,
      comando: 'node scripts/monitor-gsc-job-indexation.mjs --dry-run',
      note: [
        'Il comando rigira la stessa interrogazione e stampa il verdetto per pagina senza',
        "coniare: la issue si chiude quando il conteggio dei fail e' zero. Vuole le",
        'credenziali della Search Console — dalla root del workspace, `source bin/rc-env.sh`.',
      ],
      osservatore: [
        '`.github/workflows/monitor-gsc-job-indexation.yml`, che rigira la misura e riconia',
        "questa issue finche' restano pagine fallite. Non esiste un closer automatico: il",
        "comando qui sopra e' il criterio con cui chiuderla.",
      ],
      fallimento: '`[Monitor] job page(s) with indexation issues`',
    }),
  ].join('\n');
}

async function createGithubIssue(failedPages, results, priority = 1, persistentFailures = []) {
  const apiKey = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!apiKey) {
    log('ℹ️', 'GH_TOKEN/GITHUB_TOKEN not set — skipping');
    return;
  }

  const description = buildIndexationIssueBody(failedPages, results, priority, persistentFailures);

  try {
    const { createGithubIssue: create } = await import('./lib/github-issue-creator.mjs');
    await create({
      // Stable title (ISSUES.md dedup a monte, issue #5121). The `(PERSISTENT) `
      // prefix used to be interpolated here, so the moment the SAME failures
      // survived into a second run the title changed and the helper opened a
      // SECOND issue for the condition it was already tracking. Persistence is
      // an escalation of one condition, not a different one: it now shows up in
      // the priority (1 vs 2) and in the body, where the page list lives anyway.
      title: '[Monitor] job page(s) with indexation issues',
      description,
      priority,
      labels: ['Bug'],
      project: 'SEO',
    });
    log('📋', 'GitHub issue created');
  } catch (err) {
    log('⚠️', `GitHub issue creation failed: ${err.message}`);
  }
}

/** Il corpo della issue sui dati strutturati, scheda inclusa. Esportato per il test. */
export function buildStructuredDataIssueBody(pages) {
  return [
    '## GSC Job Indexation Monitor — Structured Data Errors Detected',
    '',
    `**Date**: ${new Date().toISOString().split('T')[0]}`,
    `**Affected pages**: ${pages.length}`,
    `**Source**: GSC URL Inspection API — richResultsResult`,
    '',
    '### Affected Pages',
    ...pages.map(p => {
      const path = new URL(p.url).pathname;
      const issues = (p.richResultsIssues && p.richResultsIssues.length > 0)
        ? p.richResultsIssues.map(i => `    - ${i}`).join('\n')
        : '    - (verdict FAIL, no per-item detail returned)';
      return `- \`${path}\` — rich results verdict: \`${p.richResults}\`\n${issues}`;
    }),
    '',
    '### Investigation Steps',
    '1. Verify JobPosting JSON-LD on the affected pages includes all required fields per CLAUDE.md non-negotiable #3: `baseSalary`, `postalCode`, `streetAddress`, `title`, `description`, `datePosted`, `hiringOrganization.name`, `jobLocation`, `employmentType`.',
    '2. Missing source data → apply safe default, do not drop the field/check.',
    '3. Re-test via GSC Rich Results Test or URL Inspection after the fix deploys.',
    '',
    buildScheda({
      causa: [
        `(ipotesi, da confermare.) ${pages.length} pagina/e emettono dati strutturati che`,
        'Google rifiuta. Il verdetto arriva da fuori, quindi dice CHE il markup non passa e',
        'non QUALE campo manchi: il dettaglio per pagina, quando c\'e\', e\' nella lista sopra.',
      ],
      fix: [
        'Completare i campi obbligatori elencati nel Non-Negotiable #3 di `AGENTS.md`. Una',
        'sorgente mancante si copre con un valore di riserva sicuro, **mai togliendo il campo',
        'o il controllo**. | **REPO**: sito.',
      ],
      metrica: `prima=${pages.length} pagine con markup rifiutato atteso=0`,
      comando: 'node scripts/monitor-gsc-job-indexation.mjs --dry-run',
      note: [
        'Il comando rigira la stessa interrogazione senza coniare: la issue si chiude quando',
        'nessuna pagina porta piu\' un verdetto negativo sui dati strutturati.',
      ],
      osservatore: [
        '`.github/workflows/monitor-gsc-job-indexation.yml`, che rigira la misura e riconia',
        "questa issue finche' il markup resta rifiutato. Non esiste un closer automatico: il",
        "comando qui sopra e' il criterio con cui chiuderla.",
      ],
      fallimento: '`[Monitor] job page(s) with structured data issues`',
    }),
  ].join('\n');
}

async function createStructuredDataIssue(pages) {
  const apiKey = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!apiKey) {
    log('ℹ️', 'GH_TOKEN/GITHUB_TOKEN not set — skipping');
    return;
  }

  const description = buildStructuredDataIssueBody(pages);

  try {
    const { createGithubIssue: create } = await import('./lib/github-issue-creator.mjs');
    await create({
      title: '[Monitor] job page(s) with structured data issues',
      description,
      priority: 3,
      labels: ['Bug', 'seo'],
      project: 'SEO',
    });
    log('📋', 'GitHub issue created (structured data)');
  } catch (err) {
    log('⚠️', `GitHub issue creation failed: ${err.message}`);
  }
}

// ── IndexNow ────────────────────────────────────────────────
async function submitToIndexNow(urls) {
  if (urls.length === 0) return;
  const KEY = '39093e02a74b4a2dbf867c74bc53a7d8';

  try {
    const res = await fetchWithTimeout('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'frontaliereticino.ch',
        key: KEY,
        keyLocation: `https://frontaliereticino.ch/${KEY}.txt`,
        urlList: urls,
      }),
    });
    log('📤', `IndexNow: ${res.status} (${urls.length} URLs)`);
  } catch (err) {
    log('⚠️', `IndexNow failed: ${err.message}`);
  }
}

// Run only as a CLI: tests import the issue-body builders, and an import must
// not inspect 30 URLs (and spend URL Inspection quota) wherever credentials
// happen to be in the environment.
if (isInvokedDirectly(import.meta.url)) {
  main().catch(err => {
    log('⚠️', `Monitor error: ${err.message}`);
    process.exit(0); // Always exit 0
  });
}
