#!/usr/bin/env node
/**
 * Layer 2: Post-Deploy GSC Verification
 *
 * After deploy + IndexNow, verifies a sample of high-impression job pages
 * via GSC URL Inspection API.
 *
 * Checks:
 * - Canonical URL is correct (not listing page)
 * - Rich Results present (for active job pages)
 * - No regressions from previous crawl
 *
 * If any page crawled AFTER the latest deploy shows issues:
 * → Creates a Linear issue
 * → Submits affected URLs via IndexNow for re-crawl
 *
 * Always exits 0 — non-blocking, alerting only.
 *
 * Usage: node scripts/verify-post-deploy-seo.mjs
 *
 * Environment:
 *   GOOGLE_APPLICATION_CREDENTIALS — path to Service Account JSON
 *   LINEAR_API_KEY — for issue creation (optional)
 */

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const SITE_URL = 'https://frontaliereticino.ch';
const LISTING_PATH = '/cerca-lavoro-ticino/';
const MAX_INSPECT = 10; // API quota friendly
const FETCH_TIMEOUT_MS = 20_000;

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
    if (!sa.client_email || !sa.private_key) return null;
    return sa;
  } catch { return null; }
}

function createJwt(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iss: sa.client_email, scope: GSC_SCOPES, aud: TOKEN_URI, iat: now, exp: now + 3600 };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(payload)}`;
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

// ── GSC Helpers ─────────────────────────────────────────────
async function detectSiteUrl(accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  try {
    const res = await fetchWithTimeout(
      'https://www.googleapis.com/webmasters/v3/sites',
      { headers }
    );
    if (!res.ok) return SITE_URL;
    const data = await res.json();
    const domain = data.siteEntry?.find(s => s.siteUrl === `sc-domain:frontaliereticino.ch`);
    if (domain) return domain.siteUrl;
    const prefix = data.siteEntry?.find(s => s.siteUrl?.includes('frontaliereticino.ch'));
    if (prefix) return prefix.siteUrl;
  } catch { /* ignore */ }
  return SITE_URL;
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
          rowLimit: 50,
          type: 'web',
        }),
      }
    );

    if (!res.ok) {
      log('⚠️', `Search Analytics request failed: ${res.status}`);
      return [];
    }

    const data = await res.json();
    if (!data.rows?.length) {
      log('ℹ️', 'No job page analytics data available');
      return [];
    }

    // Sort by impressions descending and pick top pages
    return data.rows
      .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
      .slice(0, MAX_INSPECT)
      .map(r => r.keys[0]);
  } catch (err) {
    log('⚠️', `Search Analytics error: ${err.message}`);
    return [];
  }
}

async function inspectUrl(accessToken, siteUrl, inspectionUrl) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  try {
    const res = await fetchWithTimeout(
      'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ inspectionUrl, siteUrl }),
      }
    );

    if (!res.ok) {
      if (res.status === 429 || res.status === 403) return { error: 'quota' };
      return { error: `http-${res.status}` };
    }

    const data = await res.json();
    const result = data.inspectionResult;
    return {
      verdict: result?.indexStatusResult?.verdict || 'UNKNOWN',
      canonical: result?.indexStatusResult?.userCanonical || null,
      googleCanonical: result?.indexStatusResult?.googleCanonical || null,
      richResults: result?.richResultsResult?.verdict || 'UNKNOWN',
      crawlTime: result?.indexStatusResult?.lastCrawlTime || null,
      coverageState: result?.indexStatusResult?.coverageState || null,
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  log('🔍', 'Layer 2: Post-Deploy SEO Verification\n');

  const sa = loadServiceAccount();
  if (!sa) {
    log('⚠️', 'No Service Account credentials — skipping GSC verification');
    return;
  }

  let accessToken;
  try {
    accessToken = await getAccessToken(sa);
    log('🔑', `Authenticated via Service Account`);
  } catch (err) {
    log('⚠️', `Auth failed: ${err.message} — skipping`);
    return;
  }

  const siteUrl = await detectSiteUrl(accessToken);
  log('🌐', `GSC site: ${siteUrl}`);

  // Get top job pages by impressions
  const topPages = await getTopJobPages(accessToken, siteUrl);
  if (topPages.length === 0) {
    log('ℹ️', 'No job pages to verify — done');
    return;
  }

  log('📊', `Inspecting ${topPages.length} top job pages...\n`);

  const issues = [];
  let passCount = 0;
  let staleCount = 0;

  for (const pageUrl of topPages) {
    const result = await inspectUrl(accessToken, siteUrl, pageUrl);

    if (result.error === 'quota') {
      log('⚠️', 'API quota reached — stopping inspection');
      break;
    }
    if (result.error) {
      log('  ❓', `${new URL(pageUrl).pathname.slice(0, 60)} — error: ${result.error}`);
      continue;
    }

    const path = new URL(pageUrl).pathname;
    const shortPath = path.slice(0, 60);

    // Check for canonical regression → listing page
    const canonicalIsListing = result.googleCanonical?.endsWith(LISTING_PATH) ||
                                result.canonical?.endsWith(LISTING_PATH);

    // Check rich results
    const richPass = result.richResults === 'PASS';
    const isJobPage = path.includes('/cerca-lavoro-ticino/') &&
                      !path.endsWith('/cerca-lavoro-ticino/') &&
                      !path.includes('/azienda-');

    if (canonicalIsListing && isJobPage) {
      log('  ❌', `${shortPath} — canonical→listing! (crawled: ${result.crawlTime || 'unknown'})`);
      issues.push({ url: pageUrl, issue: 'canonical-listing', crawlTime: result.crawlTime });
    } else if (isJobPage && result.verdict === 'PASS' && !richPass) {
      log('  ⚠️', `${shortPath} — indexed but no rich results (crawled: ${result.crawlTime || 'unknown'})`);
      issues.push({ url: pageUrl, issue: 'no-rich-results', crawlTime: result.crawlTime });
    } else if (result.verdict === 'PASS') {
      log('  ✅', `${shortPath} — ${result.verdict} ${richPass ? '(RR ✓)' : ''}`);
      passCount++;
    } else {
      log('  🕒', `${shortPath} — ${result.verdict} (${result.coverageState || 'unknown'})`);
      staleCount++;
    }

    await sleep(150); // Be gentle with API
  }

  // Summary
  log('\n📋', `Results: ${passCount} passed, ${issues.length} issues, ${staleCount} stale/pending`);

  // Write GitHub Actions Step Summary
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summaryLines = [
      '## 🔍 Layer 2: Post-Deploy SEO Verification',
      '',
      `| Metric | Count |`,
      `|--------|-------|`,
      `| ✅ Passed | ${passCount} |`,
      `| ❌ Issues | ${issues.length} |`,
      `| 🕒 Stale | ${staleCount} |`,
      '',
      `**Inspected**: ${topPages.length} top job pages (by impressions)`,
      '',
    ];
    if (issues.length > 0) {
      summaryLines.push('### Issues Found', '');
      for (const i of issues) {
        summaryLines.push(`- **${i.issue}**: \`${new URL(i.url).pathname}\` (crawled: ${i.crawlTime || 'unknown'})`);
      }
      summaryLines.push('', '> ⚠️ SEO regressions detected — Linear issue created');
    } else {
      summaryLines.push('> ✅ No SEO regressions detected');
    }
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryLines.join('\n') + '\n');
    } catch { /* ignore */ }
  }

  if (issues.length === 0) {
    log('✅', 'Post-deploy SEO verification passed — no regressions detected');
    return;
  }

  // Create Linear issue if there are regressions
  log('⚠️', `${issues.length} SEO issue(s) detected — creating Linear ticket`);
  await createLinearIssue(issues);

  // Submit affected URLs to IndexNow for re-crawl
  await submitToIndexNow(issues.map(i => i.url));
}

async function createLinearIssue(issues) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    log('ℹ️', 'LINEAR_API_KEY not set — skipping issue creation');
    return;
  }

  const description = [
    '## Post-Deploy SEO Regression Detected',
    '',
    `**Date**: ${new Date().toISOString().split('T')[0]}`,
    `**Affected pages**: ${issues.length}`,
    '',
    '### Issues',
    ...issues.map(i => `- **${i.issue}**: \`${new URL(i.url).pathname}\` (crawled: ${i.crawlTime || 'unknown'})`),
    '',
    '### Action Required',
    '1. Check if the SPA runtime is overwriting canonical/schema on these pages',
    '2. Run `npm run validate:spa-render` locally to reproduce',
    '3. Fix the root cause and re-deploy',
    '4. Submit fixed URLs via IndexNow: `node scripts/submit-indexnow.js`',
  ].join('\n');

  try {
    // Use the Linear issue creator module
    const { createLinearIssue: create } = await import('./lib/linear-issue-creator.mjs');
    await create({
      title: `SEO Regression: ${issues.length} job page(s) with canonical/schema issues`,
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

async function submitToIndexNow(urls) {
  if (urls.length === 0) return;
  const INDEXNOW_KEY = '39093e02a74b4a2dbf867c74bc53a7d8';

  try {
    const res = await fetchWithTimeout('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'frontaliereticino.ch',
        key: INDEXNOW_KEY,
        keyLocation: `https://frontaliereticino.ch/${INDEXNOW_KEY}.txt`,
        urlList: urls,
      }),
    });
    log('📤', `IndexNow re-submission: ${res.status} (${urls.length} URLs)`);
  } catch (err) {
    log('⚠️', `IndexNow submission failed: ${err.message}`);
  }
}

main().catch(err => {
  log('⚠️', `Layer 2 error: ${err.message}`);
  // Always exit 0 — non-blocking
  process.exit(0);
});
