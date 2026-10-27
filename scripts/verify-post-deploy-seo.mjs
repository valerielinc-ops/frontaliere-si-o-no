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
 * → Creates a GitHub issue
 * → Submits affected URLs via IndexNow for re-crawl
 *
 * Always exits 0 — non-blocking, alerting only.
 *
 * Usage: node scripts/verify-post-deploy-seo.mjs
 *
 * Environment:
 *   GOOGLE_APPLICATION_CREDENTIALS — path to Service Account JSON
 *   GITHUB_TOKEN — for issue creation (optional)
 */

import { readFileSync, existsSync, appendFileSync, realpathSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { utcDaysBefore } from './lib/analytics-settled-window.mjs';
import { validateMandatoryJobPostingFields } from './lib/jobposting-mandatory-fields.mjs';

const SITE_URL = 'https://frontaliereticino.ch';
const LISTING_PATH = '/cerca-lavoro-ticino/';
const BUILD_ID_PATH = '/build-id.txt';
const MAX_INSPECT = 10; // API quota friendly
const MAX_ANALYTICS_CANDIDATES = 20;
const FETCH_TIMEOUT_MS = 20_000;
const LIVE_FETCH_TIMEOUT_MS = 10_000;
const SITEMAP_FETCH_TIMEOUT_MS = 10_000;
const GOOGLEBOT_USER_AGENT = 'Googlebot/2.1 (+http://www.google.com/bot.html)';

// ── Helpers ─────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(emoji, msg) { console.log(`${emoji}  ${msg}`); }

function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await mapper(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function isJobPostingType(value) {
  return value === 'JobPosting' || (Array.isArray(value) && value.includes('JobPosting'));
}

function normalizedPublicUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Keep a URL-level detail-page signal independent from the live JSON-LD.
 * When a JobPosting disappears, the emitted HTML cannot be the classifier.
 * The live sitemap is the stronger signal; the conservative path fallback
 * keeps an unseen analytics candidate observable instead of silently dropping
 * a possible detail-page regression.
 */
export function isLikelyJobDetailUrl(pageUrl, sitemapSignals = null) {
  const normalized = normalizedPublicUrl(pageUrl);
  if (!normalized) return false;
  if (sitemapSignals instanceof Map && sitemapSignals.has(normalized)) {
    return sitemapSignals.get(normalized) === true;
  }

  try {
    const { pathname } = new URL(normalized);
    const match = pathname.match(/^\/cerca-lavoro-ticino\/([^/]+)\/$/i);
    if (!match) return false;
    const slug = match[1].toLowerCase();
    return !/^(?:azienda-|ricerca-|pagina-\d+$|page-\d+$|seite-\d+$)/i.test(slug);
  } catch {
    return false;
  }
}

function collectJobPostingRecords(value, records = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectJobPostingRecords(entry, records);
    return records;
  }
  if (!value || typeof value !== 'object') return records;
  if (isJobPostingType(value['@type'])) records.push(value);
  for (const [key, nested] of Object.entries(value)) {
    if (key !== '@type') collectJobPostingRecords(nested, records);
  }
  return records;
}

function collectSchemaTypes(value, types = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) collectSchemaTypes(entry, types);
    return types;
  }
  if (!value || typeof value !== 'object') return types;
  const schemaType = value['@type'];
  if (typeof schemaType === 'string') types.add(schemaType);
  if (Array.isArray(schemaType)) {
    for (const type of schemaType) if (typeof type === 'string') types.add(type);
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key !== '@type') collectSchemaTypes(nested, types);
  }
  return types;
}

/**
 * Parse the live HTML independently from GSC. This makes the post-deploy
 * check catch a broken emitted payload immediately, and prevents a landing
 * page with BreadcrumbList-only JSON-LD from being reported as a JobPosting
 * regression.
 */
export function inspectLiveJobPostingHtml(html) {
  const records = [];
  const schemaTypes = new Set();
  let malformedJobPosting = false;
  const scriptPattern = /<script\b[^>]*type=(['"])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    try {
      const parsed = JSON.parse(match[2] || '');
      collectSchemaTypes(parsed, schemaTypes);
      collectJobPostingRecords(parsed, records);
    } catch {
      if (/"@type"\s*:\s*(?:"JobPosting"|\[[^\]]*"JobPosting")/i.test(match[2] || '')) {
        malformedJobPosting = true;
      }
    }
  }

  const errors = [];
  const seenErrors = new Set();
  for (const record of records) {
    for (const error of validateMandatoryJobPostingFields(record)) {
      const key = `${error.field}:${error.message}`;
      if (seenErrors.has(key)) continue;
      seenErrors.add(key);
      errors.push(error);
    }
  }
  if (malformedJobPosting) {
    errors.push({ field: 'jsonld', message: 'JobPosting JSON-LD is not valid JSON' });
  }
  const isListingPage = records.length === 0
    && !malformedJobPosting
    && ['CollectionPage', 'ItemList', 'SearchResultsPage'].some(type => schemaTypes.has(type));
  return {
    isJobPage: records.length > 0 || malformedJobPosting,
    isListingPage,
    records,
    errors,
  };
}

function isJobPostingRichResultType(value) {
  return /job\s*postings?/i.test(String(value || ''));
}

/** Extract field-level JobPosting issues from URL Inspection, not only its verdict. */
export function extractRichResultsIssues(inspectionResult) {
  const detectedItems = inspectionResult?.richResultsResult?.detectedItems;
  if (!Array.isArray(detectedItems)) return [];
  const issues = [];
  const seen = new Set();
  for (const detected of detectedItems) {
    const type = detected?.richResultType || detected?.type || detected?.itemType;
    if (!isJobPostingRichResultType(type)) continue;
    const itemGroups = Array.isArray(detected.items) && detected.items.length > 0
      ? detected.items
      : [detected];
    for (const group of itemGroups) {
      for (const issue of group?.issues || []) {
        const message = issue?.issueMessage || issue?.message || 'unknown issue';
        const severity = issue?.severity || 'UNKNOWN';
        const key = `${type}:${severity}:${message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push({ type, severity, message });
      }
    }
  }
  return issues;
}

export function crawlIsAfterBuild(crawlTime, buildTimestamp) {
  if (!buildTimestamp) return true;
  const crawlTimestamp = Date.parse(crawlTime || '');
  return Number.isFinite(crawlTimestamp) && crawlTimestamp >= buildTimestamp;
}

async function getLiveBuildMarker() {
  try {
    const response = await fetchWithTimeout(
      `${SITE_URL}${BUILD_ID_PATH}`,
      { headers: { 'user-agent': GOOGLEBOT_USER_AGENT, accept: 'text/plain' } },
      LIVE_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) return null;
    const raw = (await response.text()).trim();
    const timestamp = Number(raw);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    return { timestamp, raw, iso: new Date(timestamp).toISOString() };
  } catch {
    return null;
  }
}

async function getLiveJobSitemapSignals() {
  try {
    const response = await fetchWithTimeout(
      `${SITE_URL}/sitemap-jobs.xml`,
      { headers: { 'user-agent': GOOGLEBOT_USER_AGENT, accept: 'application/xml,text/xml' } },
      SITEMAP_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) return new Map();
    const xml = await response.text();
    const signals = new Map();
    for (const match of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
      const entry = match[1];
      const loc = entry.match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1];
      const normalized = normalizedPublicUrl(loc);
      if (!normalized) continue;
      const priority = entry.match(/<priority>\s*([^<]+?)\s*<\/priority>/i)?.[1];
      const hasLastmod = /<lastmod>\s*[^<]+?\s*<\/lastmod>/i.test(entry);
      // jobsSeoPagesPlugin emits active detail URLs at priority 0.6 with a
      // listing date; landing/search/company entries use other priorities.
      signals.set(normalized, hasLastmod || priority === '0.6');
    }
    return signals;
  } catch {
    return new Map();
  }
}

async function inspectLivePage(pageUrl) {
  try {
    const response = await fetchWithTimeout(
      pageUrl,
      { headers: { 'user-agent': GOOGLEBOT_USER_AGENT, accept: 'text/html' } },
      LIVE_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) return { error: `http-${response.status}` };
    return inspectLiveJobPostingHtml(await response.text());
  } catch (error) {
    return { error: error.message };
  }
}

export function classifyLiveJobCandidate(pageUrl, live, sitemapSignals = null) {
  const detailPageSignal = isLikelyJobDetailUrl(pageUrl, sitemapSignals);
  if (live?.error) {
    return { detailPageSignal, shouldInspect: true, issue: null, skipped: false };
  }
  if (live?.isJobPage === true) {
    return { detailPageSignal, shouldInspect: true, issue: null, skipped: false };
  }
  if (live?.isListingPage === true && !detailPageSignal) {
    return { detailPageSignal, shouldInspect: false, issue: null, skipped: true };
  }
  if (detailPageSignal) {
    return {
      detailPageSignal,
      shouldInspect: true,
      issue: 'missing-jobposting',
      skipped: false,
    };
  }
  return { detailPageSignal: false, shouldInspect: false, issue: null, skipped: true };
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
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
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

    // Keep a wider candidate pool because Search Analytics also returns
    // profession/canton/company landing pages under the same URL prefix.
    // The live JSON-LD pass below selects the actual JobPosting pages.
    return data.rows
      .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
      .slice(0, MAX_ANALYTICS_CANDIDATES)
      .map(r => r.keys?.[0])
      .filter(Boolean);
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
      richResultIssues: extractRichResultsIssues(result),
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

  // Get analytics candidates, then classify them from the live JSON-LD. A
  // URL prefix is not enough: profession, canton and company landing pages
  // also live below /cerca-lavoro-ticino/.
  const topPages = await getTopJobPages(accessToken, siteUrl);
  if (topPages.length === 0) {
    log('ℹ️', 'No job pages to verify — done');
    return;
  }

  const issues = [];
  const issueKeys = new Set();
  const addIssue = ({ url, issue, crawlTime = null, details = null }) => {
    const key = `${url}|${issue}|${details || ''}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push({ url, issue, crawlTime, details });
  };

  const liveBuild = await getLiveBuildMarker();
  if (liveBuild) {
    log('🚀', `Live build marker: ${liveBuild.raw} (${liveBuild.iso})`);
  } else {
    log('⚠️', 'Live build marker unavailable — GSC crawl freshness will not be gated');
  }

  const sitemapSignals = await getLiveJobSitemapSignals();
  if (sitemapSignals.size === 0) {
    log('⚠️', 'Live jobs sitemap unavailable — using the conservative URL detail signal');
  }

  const liveCandidates = await mapWithConcurrency(topPages, 5, async (pageUrl) => ({
    pageUrl,
    live: await inspectLivePage(pageUrl),
  }));
  const candidates = [];
  let nonJobPageCount = 0;
  let unavailablePageCount = 0;
  for (const candidate of liveCandidates) {
    const { pageUrl, live } = candidate;
    const shortPath = new URL(pageUrl).pathname.slice(0, 60);
    const classification = classifyLiveJobCandidate(pageUrl, live, sitemapSignals);
    if (live.error) {
      unavailablePageCount++;
      log('  ❓', `${shortPath} — live HTML unavailable: ${live.error}`);
      // Keep an unavailable candidate for URL Inspection. The live payload
      // remains unknown, but preserve the independent detail signal so GSC
      // can still expose a canonical-to-listing regression.
      candidates.push({ pageUrl, live, detailPageSignal: classification.detailPageSignal });
      continue;
    }
    if (classification.issue === 'missing-jobposting') {
      log('  ❌', `${shortPath} — live detail page has no JobPosting JSON-LD`);
      addIssue({
        url: pageUrl,
        issue: 'missing-jobposting',
        details: 'live detail page contains no JobPosting JSON-LD',
      });
    } else if (classification.skipped) {
      nonJobPageCount++;
      log('  ↪️', `${shortPath} — live JSON-LD is not a JobPosting; skipped`);
      continue;
    }
    for (const error of live.errors) {
      addIssue({
        url: pageUrl,
        issue: `live-jobposting:${error.field}`,
        details: error.message,
      });
    }
    candidates.push({ pageUrl, live, detailPageSignal: classification.detailPageSignal });
  }

  const inspectCandidates = candidates.slice(0, MAX_INSPECT);
  log(
    '📊',
    `Analytics candidates: ${topPages.length}; live JobPosting pages: ${candidates.length - unavailablePageCount}; `
      + `non-job pages skipped: ${nonJobPageCount}; inspecting ${inspectCandidates.length}...\n`,
  );

  let passCount = 0;
  let staleCount = 0;

  for (const candidate of inspectCandidates) {
    const { pageUrl, live } = candidate;
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

    // Do not turn an older GSC crawl into a regression for the build that is
    // live now. The current HTML check above is still authoritative for the
    // emitted contract while Google catches up.
    if (liveBuild && !crawlIsAfterBuild(result.crawlTime, liveBuild.timestamp)) {
      log('  🕒', `${shortPath} — GSC crawl predates live build (crawled: ${result.crawlTime || 'unknown'})`);
      staleCount++;
      continue;
    }

    // Check for canonical regression → listing page
    const canonicalIsListing = result.googleCanonical?.endsWith(LISTING_PATH) ||
                                result.canonical?.endsWith(LISTING_PATH);

    const isJobPage = live?.isJobPage === true
      || candidate.detailPageSignal === true
      || result.richResultIssues.length > 0;
    const richPass = result.richResults === 'PASS';
    for (const richIssue of result.richResultIssues) {
      addIssue({
        url: pageUrl,
        issue: `gsc-jobposting:${richIssue.severity}`,
        crawlTime: result.crawlTime,
        details: richIssue.message,
      });
    }

    if (canonicalIsListing && isJobPage) {
      log('  ❌', `${shortPath} — canonical→listing! (crawled: ${result.crawlTime || 'unknown'})`);
      addIssue({ url: pageUrl, issue: 'canonical-listing', crawlTime: result.crawlTime });
    } else if (isJobPage && result.verdict === 'PASS' && !richPass) {
      log('  ⚠️', `${shortPath} — indexed but no rich results (crawled: ${result.crawlTime || 'unknown'})`);
      addIssue({ url: pageUrl, issue: 'no-rich-results', crawlTime: result.crawlTime });
    } else if (result.richResultIssues.length > 0) {
      log('  ❌', `${shortPath} — GSC reports ${result.richResultIssues.length} JobPosting field issue(s)`);
    } else if (result.verdict === 'PASS') {
      log('  ✅', `${shortPath} — ${result.verdict} ${isJobPage && richPass ? '(RR ✓)' : '(indexed)'}`);
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
      `**Analytics candidates**: ${topPages.length}; **live JobPosting candidates**: ${candidates.length - unavailablePageCount}; **inspected**: ${inspectCandidates.length}`,
      '',
    ];
    if (issues.length > 0) {
      summaryLines.push('### Issues Found', '');
      for (const i of issues) {
        summaryLines.push(`- **${i.issue}**: \`${new URL(i.url).pathname}\`${i.details ? ` — ${i.details}` : ''} (crawled: ${i.crawlTime || 'live/current'})`);
      }
      summaryLines.push('', '> ⚠️ SEO regressions detected — GitHub issue created');
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

  // Create GitHub issue if there are regressions
  log('⚠️', `${issues.length} SEO issue(s) detected — creating GitHub issue`);
  await createGithubIssue(issues);

  // Submit affected URLs to IndexNow for re-crawl
  await submitToIndexNow(issues.map(i => i.url));
}

async function createGithubIssue(issues) {
  const apiKey = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!apiKey) {
    log('ℹ️', 'GH_TOKEN/GITHUB_TOKEN not set — skipping issue creation');
    return;
  }

  const description = [
    '## Post-Deploy SEO Regression Detected',
    '',
    `**Date**: ${new Date().toISOString().split('T')[0]}`,
    `**Affected pages**: ${issues.length}`,
    '',
    '### Issues',
    ...issues.map(i => `- **${i.issue}**: \`${new URL(i.url).pathname}\`${i.details ? ` — ${i.details}` : ''} (crawled: ${i.crawlTime || 'live/current'})`),
    '',
    '### Action Required',
    '1. Compare the live JobPosting payload with the shared mandatory-field contract',
    '2. Check URL Inspection field-level issues and the crawl timestamp against the live build marker',
    '3. Fix the producer/cache path and re-deploy',
    '4. Submit fixed URLs via IndexNow: `node scripts/submit-indexnow.js`',
  ].join('\n');

  try {
    // Use the GitHub issue creator module
    const { createGithubIssue: create } = await import('./lib/github-issue-creator.mjs');
    await create({
      title: 'SEO Regression: job page(s) with canonical/schema issues',
      description,
      priority: 1,
      labels: ['Bug'],
      project: 'SEO',
    });
    log('📋', 'GitHub issue created');
  } catch (err) {
    log('⚠️', `GitHub issue creation failed: ${err.message}`);
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

export { getLiveBuildMarker, inspectLivePage };

const isMainModule = process.argv[1] && (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch(err => {
    log('⚠️', `Layer 2 error: ${err.message}`);
    // Always exit 0 — non-blocking
    process.exit(0);
  });
}
