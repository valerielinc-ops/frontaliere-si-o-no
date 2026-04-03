#!/usr/bin/env node
/**
 * Layer 3: Weekly GSC Job Indexation Monitor
 *
 * Proactive monitoring of job page indexation health via Google Search Console.
 *
 * What it does:
 * 1. Queries GSC Search Analytics for top 50 job pages by impressions
 * 2. Runs URL Inspection on 30 sampled pages
 * 3. Categorizes: PASS, FAIL, STALE, UNKNOWN
 * 4. If FAIL > 0 → creates Linear issue (priority 1)
 * 5. Submits stale URLs via IndexNow for re-crawl
 * 6. Logs summary with trend data
 *
 * Always exits 0 — alerting/monitoring only.
 *
 * Usage: node scripts/monitor-gsc-job-indexation.mjs [--dry-run]
 *
 * Environment:
 *   GOOGLE_APPLICATION_CREDENTIALS — path to Service Account JSON
 *   LINEAR_API_KEY — for issue creation (optional)
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_URL = 'https://frontaliereticino.ch';
const LISTING_PATH = '/cerca-lavoro-ticino/';
const MAX_ANALYTICS_PAGES = 50;
const MAX_INSPECT = 30;
const FETCH_TIMEOUT_MS = 20_000;
const DRY_RUN = process.argv.includes('--dry-run');
const HISTORY_FILE = join(__dirname, '..', 'data', 'gsc-monitor-history.json');

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
      grant_type: 'urn:ietf:params:oauth:grant_type:jwt-bearer',
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
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 28);
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
              expression: '/cerca-lavoro-ticino/.+',
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
    return {
      verdict: r?.indexStatusResult?.verdict || 'UNKNOWN',
      canonical: r?.indexStatusResult?.userCanonical || null,
      googleCanonical: r?.indexStatusResult?.googleCanonical || null,
      richResults: r?.richResultsResult?.verdict || 'UNKNOWN',
      crawlTime: r?.indexStatusResult?.lastCrawlTime || null,
      coverageState: r?.indexStatusResult?.coverageState || null,
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Analysis ────────────────────────────────────────────────
function categorize(result, pageUrl) {
  if (result.error) return 'UNKNOWN';

  const path = new URL(pageUrl).pathname;
  const isJobPage = path.includes('/cerca-lavoro-ticino/') &&
                    !path.endsWith('/cerca-lavoro-ticino/') &&
                    !path.includes('/azienda-');

  // Canonical regression to listing page
  if (isJobPage && (result.googleCanonical?.endsWith(LISTING_PATH) || result.canonical?.endsWith(LISTING_PATH))) {
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

// ── Main ────────────────────────────────────────────────────
async function main() {
  log('📊', 'Layer 3: Weekly GSC Job Indexation Monitor\n');

  if (DRY_RUN) log('ℹ️', 'DRY RUN — no Linear issues or IndexNow submissions\n');

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

  // Get top job pages
  const topPages = await getTopJobPages(accessToken, siteUrl);
  if (topPages.length === 0) {
    log('ℹ️', 'No job page analytics data — done');
    return;
  }

  // Sample pages for inspection (prioritize diverse paths)
  const sample = topPages.slice(0, MAX_INSPECT);
  log('🔍', `Inspecting ${sample.length} pages (from ${topPages.length} with impressions)...\n`);

  const results = { PASS: 0, FAIL: 0, WARN: 0, STALE: 0, UNKNOWN: 0 };
  const failedPages = [];
  const warnPages = [];
  const stalePages = [];

  for (const pageUrl of sample) {
    const result = await inspectUrl(accessToken, siteUrl, pageUrl);

    if (result.error === 'quota') {
      log('⚠️', 'API quota reached — stopping');
      break;
    }

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

  // Save history for trend tracking
  const history = loadHistory();
  history.runs.push({
    date: new Date().toISOString().split('T')[0],
    inspected: sample.length,
    ...results,
  });
  if (!DRY_RUN) saveHistory(history);

  // Print trend
  if (history.runs.length > 1) {
    log('📈', 'Trend (last runs):');
    for (const run of history.runs.slice(-4)) {
      log('  ', `  ${run.date}: PASS=${run.PASS} FAIL=${run.FAIL} WARN=${run.WARN} STALE=${run.STALE}`);
    }
    console.log();
  }

  // Act on failures
  if (failedPages.length > 0 && !DRY_RUN) {
    log('🚨', `${failedPages.length} FAIL(s) detected — creating Linear issue`);
    await createLinearIssue(failedPages, results);
  }

  // Re-submit stale pages via IndexNow
  if (stalePages.length > 0 && !DRY_RUN) {
    log('📤', `Submitting ${stalePages.length} stale URLs to IndexNow for re-crawl`);
    await submitToIndexNow(stalePages.map(p => p.url));
  }
}

// ── Linear Issue ────────────────────────────────────────────
async function createLinearIssue(failedPages, results) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    log('ℹ️', 'LINEAR_API_KEY not set — skipping');
    return;
  }

  const description = [
    '## GSC Job Indexation Monitor — Failures Detected',
    '',
    `**Date**: ${new Date().toISOString().split('T')[0]}`,
    `**Summary**: ${results.PASS} pass, ${results.FAIL} fail, ${results.WARN} warn, ${results.STALE} stale`,
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
  ].join('\n');

  try {
    const { createLinearIssue: create } = await import('./lib/linear-issue-creator.mjs');
    await create({
      title: `[Monitor] ${failedPages.length} job page(s) with indexation issues`,
      description,
      priority: 1,
      labels: ['Bug'],
      project: 'SEO',
    });
    log('📋', 'Linear issue created');
  } catch (err) {
    log('⚠️', `Linear issue creation failed: ${err.message}`);
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

main().catch(err => {
  log('⚠️', `Monitor error: ${err.message}`);
  process.exit(0); // Always exit 0
});
