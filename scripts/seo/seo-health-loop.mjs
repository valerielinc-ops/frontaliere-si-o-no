#!/usr/bin/env node
/**
 * seo-health-loop.mjs — one closed-loop check for the five SEO workstreams.
 *
 * The repository already has specialised monitors.  This runner is the
 * integration boundary that was missing: it takes a fresh live sample,
 * records the provenance of GSC/GA4/Cloudflare data, carries forward only
 * repeated findings, and tells the operator which existing deterministic
 * repair owns each class.
 *
 * Five phases represented in the report:
 *   1. crawlability       robots + sitemap graph
 *   2. indexing           live status, redirects, canonical, noindex
 *   3. job quality        JobPosting on sampled job details
 *   4. demand             GA4 engagement + committed GSC/autopilot state
 *   5. resilience         Cloudflare 5xx surfaces + News sitemap health
 *
 * It never rewrites application source or content from an observation.  The
 * only automatic correction in the companion workflow is the already-owned,
 * resolver-gated 404 compatibility store (`discover-404s-via-cloudflare`
 * plus strict pruning).  Everything else becomes a deduplicated issue after
 * two consecutive observations.  This is the safe meaning of "self-healing"
 * here: no silent degradation, no speculative SEO changes, and no false green
 * caused by a dead data source.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SITE_ORIGIN,
  SITE_HOST,
  absoluteHttpUrl,
  comparableUrl,
  deterministicSample,
  isAssetUrl,
  isJobDetailPath,
  parseSitemapIndex,
  parseSitemapUrlSet,
  findingsForProbe,
  sourceResult,
  advanceFindingStreaks,
  actionableStreaks,
  urlPath,
} from '../lib/seo-health-contract.mjs';
import { writeJsonAtomic } from '../lib/atomic-write-json.mjs';
import { windowDates } from '../lib/perf-sources/safe.mjs';
import { fetchGa4Pages } from '../lib/evidence/ga4Fetcher.mjs';
import {
  fetchErrorDiagnostics,
  fetchErrorPaths,
  resolveZoneId,
  DEFAULT_ZONE_NAME,
} from '../lib/cf-analytics.mjs';
import { classifySurface, isSynthesizedByEdge } from '../lib/cf-error-surface.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_REPORT_DIR = path.join(ROOT, 'data', 'seo-health');
const DEFAULT_STATE_PATH = path.join(ROOT, 'data', 'seo-health-state.json');
const DEFAULT_HISTORY_PATH = path.join(DEFAULT_REPORT_DIR, 'history.jsonl');
const DEFAULT_ORIGIN = SITE_ORIGIN;
const DEFAULT_SITEMAP = `${DEFAULT_ORIGIN}/sitemap.xml`;
const DEFAULT_SAMPLE = 80;
const DEFAULT_JOB_SAMPLE = 30;
// The Cloudflare path query is bounded at 10k rows. Probe a larger bounded
// slice so ordinary traffic does not turn the long tail into a permanent
// "unverified" finding, while keeping the cycle fetch budget authoritative.
const DEFAULT_ERROR_SAMPLE = 100;
const DEFAULT_FINDING_THRESHOLD = 2;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_SITEMAPS = 160;
const DEFAULT_GA4_DAYS = 28;
const DEFAULT_GSC_STATE_MAX_AGE_DAYS = 10;
export const DEFAULT_MAX_FETCHES = 640;
export const DEFAULT_CYCLE_BUDGET_MS = 25 * 60 * 1000;
export const SEO_CONCURRENCY_GROUP = 'seo-health-loop';
const MAX_ISSUE_FINDINGS = 50;
const MAX_HISTORY_LINES = 400;

const JOB_DETAIL_RX = /^\/(?:cerca-lavoro-[^/]+|en\/find-jobs-[^/]+|de\/jobs-(?:im|in|in-der)-[^/]+|fr\/trouver-emploi-[^/]+)\/[^/]+\/?$/i;

function parseArgs(argv) {
  const out = {
    origin: DEFAULT_ORIGIN,
    sitemap: DEFAULT_SITEMAP,
    sample: DEFAULT_SAMPLE,
    jobSample: DEFAULT_JOB_SAMPLE,
    errorSample: DEFAULT_ERROR_SAMPLE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ga4Days: DEFAULT_GA4_DAYS,
    findingThreshold: DEFAULT_FINDING_THRESHOLD,
    maxFetches: DEFAULT_MAX_FETCHES,
    cycleBudgetMs: DEFAULT_CYCLE_BUDGET_MS,
    reportDir: DEFAULT_REPORT_DIR,
    statePath: DEFAULT_STATE_PATH,
    historyPath: DEFAULT_HISTORY_PATH,
    dryRun: false,
    strictSources: false,
    openIssue: false,
    autoCorrection: false,
  };
  for (const raw of argv) {
    const match = raw.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) continue;
    const [, key, value] = match;
    if (key === 'dry-run') out.dryRun = true;
    else if (key === 'strict-sources') out.strictSources = true;
    else if (key === 'open-issue') out.openIssue = true;
    else if (key === 'auto-correction') out.autoCorrection = true;
    else if (key === 'origin' && value) out.origin = value.replace(/\/$/, '');
    else if (key === 'sitemap' && value) out.sitemap = value;
    else if (key === 'sample') out.sample = Number(value);
    else if (key === 'job-sample') out.jobSample = Number(value);
    else if (key === 'error-sample') out.errorSample = Number(value);
    else if (key === 'timeout-ms') out.timeoutMs = Number(value);
    else if (key === 'ga4-days') out.ga4Days = Number(value);
    else if (key === 'finding-threshold') out.findingThreshold = Number(value);
    else if (key === 'max-fetches') out.maxFetches = Number(value);
    else if (key === 'cycle-budget-ms') out.cycleBudgetMs = Number(value);
    else if (key === 'report-dir' && value) out.reportDir = path.resolve(ROOT, value);
    else if (key === 'state' && value) out.statePath = path.resolve(ROOT, value);
    else if (key === 'history' && value) out.historyPath = path.resolve(ROOT, value);
  }
  return out;
}

function finitePositive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function safeError(error) {
  return error?.message ? String(error.message) : String(error);
}

/**
 * Bound the expensive live part of one SEO cycle.  The wrapper returns the
 * original error to the existing retry/provenance logic, but refuses to start
 * new network work after either budget is exhausted.  This keeps a large
 * sitemap or a degraded provider from turning one scheduled run into an
 * unbounded quota consumer.
 */
export function createCycleBudget(fetchImpl = fetch, {
  maxFetches = DEFAULT_MAX_FETCHES,
  maxDurationMs = DEFAULT_CYCLE_BUDGET_MS,
  now = Date.now,
} = {}) {
  const max = Math.max(1, Math.floor(Number(maxFetches) || DEFAULT_MAX_FETCHES));
  const deadlineAt = now() + Math.max(1, Math.floor(Number(maxDurationMs) || DEFAULT_CYCLE_BUDGET_MS));
  let used = 0;
  let exhausted = false;
  const guardedFetch = async (...args) => {
    if (used >= max || now() >= deadlineAt) {
      exhausted = true;
      throw new Error('seo_cycle_budget_exhausted');
    }
    used += 1;
    return fetchImpl(...args);
  };
  return {
    fetch: guardedFetch,
    snapshot() {
      return {
        deadlineAt: new Date(deadlineAt).toISOString(),
        exhausted,
        maxFetches: max,
        usedFetches: used,
      };
    },
  };
}

export function buildCycleIdentity({ now = new Date(), workflow = process.env.GITHUB_WORKFLOW, runId = process.env.GITHUB_RUN_ID } = {}) {
  const observedAt = new Date(now).toISOString();
  return {
    idempotencyKey: runId ? `run:${runId}` : `generated:${observedAt}`,
    lease: {
      cancelInProgress: false,
      group: SEO_CONCURRENCY_GROUP,
      mechanism: 'github-actions-concurrency',
      state: 'serialised',
      ttlSeconds: Math.floor(DEFAULT_CYCLE_BUDGET_MS / 1000),
    },
    runId: runId || null,
    workflow: workflow || SEO_CONCURRENCY_GROUP,
  };
}

function responseHeader(response, name) {
  try {
    return response?.headers?.get?.(name) || null;
  } catch {
    return null;
  }
}

async function responseTextWithTimeout(response, timeoutMs) {
  if (typeof response?.text !== 'function') return '';
  const limit = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => response.text()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`response body timeout after ${limit}ms`)), limit);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** GET a live resource, retrying only network/5xx failures. */
export async function fetchWithRetry(url, {
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  attempts = 2,
  headers = {},
} = {}) {
  let lastError = null;
  let lastResponse = null;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'text/html,application/xml,text/plain;q=0.8,*/*;q=0.1',
          'user-agent': 'frontaliere-seo-health/1.0',
          ...headers,
        },
      });
      clearTimeout(timer);
      lastResponse = response;
      const status = Number(response.status) || 0;
      const retryable = status === 0 || status >= 500;
      if (!retryable || attempt >= Math.max(1, attempts)) {
        let body = '';
        if (status >= 200 && status < 300 && typeof response.text === 'function') {
          body = await responseTextWithTimeout(response, timeoutMs);
        }
        return {
          status,
          location: responseHeader(response, 'location'),
          finalUrl: response.url || url,
          body,
          attempts: attempt,
          headers: {
            contentType: responseHeader(response, 'content-type'),
            cacheStatus: responseHeader(response, 'cf-cache-status'),
          },
        };
      }
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt >= Math.max(1, attempts)) {
        return { status: 0, location: null, finalUrl: url, body: '', attempts: attempt, error: safeError(error), headers: {} };
      }
    }
  }
  return {
    status: Number(lastResponse?.status) || 0,
    location: responseHeader(lastResponse, 'location'),
    finalUrl: lastResponse?.url || url,
    body: '',
    attempts: Math.max(1, attempts),
    error: lastError ? safeError(lastError) : 'request failed',
    headers: {},
  };
}

async function mapConcurrent(values, concurrency, worker) {
  const output = [];
  let cursor = 0;
  const lane = async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, lane));
  return output;
}

function sitemapUrlsAdvertisedByRobots(body, origin) {
  const output = [];
  for (const line of String(body || '').split(/\r?\n/)) {
    const match = line.match(/^\s*sitemap\s*:\s*(\S+)\s*$/i);
    if (!match) continue;
    const absolute = absoluteHttpUrl(match[1], origin);
    if (absolute) output.push(absolute);
  }
  return [...new Set(output)];
}

function sitemapName(url) {
  const pathname = urlPath(url) || url;
  return pathname.split('/').pop() || pathname;
}

function isSameSiteUrl(url, origin = DEFAULT_ORIGIN) {
  try {
    return new URL(url).hostname.toLowerCase() === new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
}

function hasTrailingSlashPageUrl(url, origin = DEFAULT_ORIGIN) {
  const pathname = urlPath(url, origin);
  return pathname === '/' || isAssetUrl(url, origin) || pathname.endsWith('/') || pathname.endsWith('.html');
}

function newsEntryVerdict(xml) {
  const blocks = String(xml || '').match(/<url\b[\s\S]*?<\/url>/gi) || [];
  let newsEntries = 0;
  const invalid = [];
  for (const block of blocks) {
    if (!/<news:news\b/i.test(block)) continue;
    newsEntries += 1;
    if (!/<news:publication\b[\s\S]*?<news:name\b/i.test(block)) invalid.push('publication');
    if (!/<news:publication_date\b[^>]*>\s*[^<\s][^<]*\s*<\/news:publication_date>/i.test(block)) invalid.push('publication_date');
    if (!/<news:title\b[^>]*>\s*[^<\s][^<]*\s*<\/news:title>/i.test(block)) invalid.push('title');
  }
  return { newsEntries, invalidFields: [...new Set(invalid)] };
}

/**
 * Fetch and flatten the sitemap graph.  The graph is bounded and every
 * failed child remains visible as a finding; a missing child is never treated
 * as an empty, successful sitemap.
 */
export async function loadSitemapGraph({
  origin = DEFAULT_ORIGIN,
  sitemap = `${origin}/sitemap.xml`,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxSitemaps = DEFAULT_MAX_SITEMAPS,
} = {}) {
  const startedAt = new Date().toISOString();
  const findings = [];
  const files = [];
  const entriesByUrl = new Map();
  let robots = null;
  const robotsResponse = await fetchWithRetry(`${origin}/robots.txt`, { fetchImpl, timeoutMs });
  if (robotsResponse.status >= 200 && robotsResponse.status < 300) {
    robots = {
      status: robotsResponse.status,
      advertisedSitemaps: sitemapUrlsAdvertisedByRobots(robotsResponse.body, origin),
      attempts: robotsResponse.attempts,
    };
  } else {
    findings.push({ code: 'robots-unavailable', url: `${origin}/robots.txt`, status: robotsResponse.status, detail: robotsResponse.error || null });
  }

  const queue = [];
  const scheduled = new Set();
  const fetched = new Set();
  let graphTruncated = false;
  const schedule = (candidate) => {
    const sitemapUrl = absoluteHttpUrl(candidate, origin);
    const key = sitemapUrl && comparableUrl(sitemapUrl);
    if (!key || scheduled.has(key)) return;
    if (scheduled.size >= maxSitemaps) {
      graphTruncated = true;
      return;
    }
    scheduled.add(key);
    queue.push(sitemapUrl);
  };
  schedule(sitemap);
  for (const advertised of robots?.advertisedSitemaps || []) schedule(advertised);

  while (queue.length > 0) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || fetched.has(comparableUrl(sitemapUrl))) continue;
    fetched.add(comparableUrl(sitemapUrl));
    const response = await fetchWithRetry(sitemapUrl, { fetchImpl, timeoutMs, headers: { accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1' } });
    const file = {
      url: sitemapUrl,
      name: sitemapName(sitemapUrl),
      status: response.status,
      attempts: response.attempts,
      urlCount: 0,
      news: newsEntryVerdict(response.body),
    };
    files.push(file);
    if (response.status < 200 || response.status >= 300) {
      findings.push({ code: 'sitemap-fetch-error', url: sitemapUrl, status: response.status, detail: response.error || null });
      continue;
    }
    if (/<sitemapindex\b/i.test(response.body)) {
      for (const child of parseSitemapIndex(response.body, origin)) schedule(child);
      continue;
    }
    const parsedEntries = parseSitemapUrlSet(response.body, origin);
    file.urlCount = parsedEntries.length;
    for (const entry of parsedEntries) {
      const key = comparableUrl(entry.url);
      if (!key) continue;
      if (!entriesByUrl.has(key)) entriesByUrl.set(key, { ...entry, source: sitemapUrl });
    }
    const news = newsEntryVerdict(response.body);
    file.news = news;
    if (news.invalidFields.length > 0) {
      findings.push({ code: 'news-sitemap-invalid', url: sitemapUrl, detail: news.invalidFields.join(', ') });
    }
  }
  if (graphTruncated || queue.length > 0) {
    findings.push({ code: 'sitemap-graph-truncated', url: sitemap, detail: `max ${maxSitemaps} sitemap files` });
  }
  for (const entry of entriesByUrl.values()) {
    if (!isSameSiteUrl(entry.url, origin)) {
      findings.push({ code: 'sitemap-external-host', url: entry.url, detail: new URL(entry.url).hostname });
    } else if (!hasTrailingSlashPageUrl(entry.url, origin)) {
      findings.push({ code: 'sitemap-no-trailing-slash', url: entry.url });
    }
  }
  const finishedAt = new Date().toISOString();
  const entries = [...entriesByUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
  const rawCount = files.reduce((sum, file) => sum + Number(file.urlCount || 0), 0);
  return {
    source: sourceResult({ name: 'live-sitemap', startedAt, finishedAt, rows: entries.length, error: entries.length ? null : 'no sitemap URLs returned' }),
    robots,
    files,
    entries,
    duplicateEntries: Math.max(0, rawCount - entries.length),
    findings,
  };
}

async function probePages(entries, {
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sample = DEFAULT_SAMPLE,
  jobSample = DEFAULT_JOB_SAMPLE,
  origin = DEFAULT_ORIGIN,
} = {}) {
  const startedAt = new Date().toISOString();
  const allPageUrls = entries
    .map((entry) => entry.url)
    .filter((url) => isSameSiteUrl(url, origin) && !isAssetUrl(url));
  const jobUrls = allPageUrls.filter((url) => isJobDetailPath(url) || JOB_DETAIL_RX.test(urlPath(url) || ''));
  const selected = [...new Set([
    ...deterministicSample(allPageUrls, sample),
    ...deterministicSample(jobUrls, jobSample),
  ])].sort();
  const results = await mapConcurrent(selected, 8, async (url) => {
    const response = await fetchWithRetry(url, { fetchImpl, timeoutMs });
    return {
      url,
      status: response.status,
      location: response.location,
      finalUrl: response.finalUrl,
      attempts: response.attempts,
      error: response.error || null,
      findings: findingsForProbe(response.status || response.error ? {
        url,
        status: response.status,
        location: response.location,
        finalUrl: response.finalUrl,
        body: response.body,
        error: response.error || null,
      } : { url, status: 0, error: 'empty response' }),
    };
  });
  const findings = results.flatMap((probe) => probe.findings.map((finding) => ({
    ...finding,
    detail: finding.canonical || finding.finalUrl || finding.location || finding.message || null,
  })));
  const finishedAt = new Date().toISOString();
  return {
    source: sourceResult({ name: 'live-page-sample', startedAt, finishedAt, rows: results.length, error: results.length ? null : 'empty sample' }),
    candidateCount: allPageUrls.length,
    jobCandidateCount: jobUrls.length,
    sampledCount: selected.length,
    sampledJobCount: selected.filter((url) => jobUrls.includes(url)).length,
    probes: results.map(({ url, status, location, finalUrl, attempts, error, findings: probeFindings }) => ({
      url,
      status,
      location,
      finalUrl,
      attempts,
      error,
      findings: probeFindings,
    })),
    findings,
  };
}

function cloudflareRowKey(row) {
  return [row?.status, row?.host || '', row?.path || ''].join('|');
}

/**
 * Keep every 5xx count attributable to one of three states: recovered by a
 * live probe, confirmed persistent, or unresolved.  `fetchErrorPaths()` is
 * capped at 10k rows and this runner deliberately probes only a smaller
 * bounded sample, so neither truncation may be mistaken for a transient
 * recovery.
 */
export function summarizeCloudflareProbeCoverage({ total5xx = 0, paths = [], probes = [] } = {}) {
  const pathRows = Array.isArray(paths) ? paths : [];
  const probeRows = Array.isArray(probes) ? probes : [];
  const path5xx = pathRows.reduce((sum, row) => sum + Number(row?.count || 0), 0);
  const sampledPath5xx = probeRows.reduce((sum, row) => sum + Number(row?.count || 0), 0);
  const probedKeys = new Set(probeRows.map(cloudflareRowKey));
  const sampledOutPath5xx = pathRows
    .filter((row) => !probedKeys.has(cloudflareRowKey(row)))
    .reduce((sum, row) => sum + Number(row?.count || 0), 0);
  const transient5xx = probeRows
    .filter((row) => Number(row?.probeStatus) > 0 && Number(row?.probeStatus) < 500)
    .reduce((sum, row) => sum + Number(row?.count || 0), 0);
  const probeFailure5xx = probeRows
    .filter((row) => Number(row?.probeStatus) === 0)
    .reduce((sum, row) => sum + Number(row?.count || 0), 0);
  const unprobed5xx = Math.max(0, Number(total5xx || 0) - path5xx);
  return {
    path5xx,
    sampledPath5xx,
    transient5xx,
    unverified5xx: sampledOutPath5xx + probeFailure5xx,
    unprobed5xx,
    unresolved5xx: sampledOutPath5xx + probeFailure5xx + unprobed5xx,
  };
}

async function collectCloudflare({ fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, errorSample = DEFAULT_ERROR_SAMPLE } = {}) {
  const startedAt = new Date().toISOString();
  if (!process.env.CF_API_TOKEN) {
    return {
      source: sourceResult({ name: 'cloudflare-analytics', startedAt, finishedAt: new Date().toISOString(), skipped: true, error: 'CF_API_TOKEN missing' }),
      available: false,
      total5xx: null,
      sampledPath5xx: null,
      transient5xx: null,
      unverified5xx: null,
      unprobed5xx: null,
      unresolved5xx: null,
      diagnostics: [],
      paths: [],
      confirmedPersistent: [],
    };
  }
  try {
    const zoneId = await resolveZoneId(
      process.env.CF_API_TOKEN,
      process.env.CF_ZONE_NAME || DEFAULT_ZONE_NAME,
      process.env.CF_ZONE_ID,
      fetchImpl,
    );
    const [diagnostics, paths] = await Promise.all([
      fetchErrorDiagnostics(process.env.CF_API_TOKEN, zoneId, { hours: 23, fetchImpl }),
      fetchErrorPaths(process.env.CF_API_TOKEN, zoneId, { hours: 23, minStatus: 500, limit: 10_000, fetchImpl }),
    ]);
    const total5xx = diagnostics.reduce((sum, row) => sum + Number(row.count || 0), 0);
    const topPaths = [...paths].sort((a, b) => Number(b.count || 0) - Number(a.count || 0)).slice(0, finitePositive(errorSample, DEFAULT_ERROR_SAMPLE));
    const probes = await mapConcurrent(topPaths, 4, async (row) => {
      const host = row.host || SITE_HOST;
      const url = absoluteHttpUrl(`https://${host}${row.path || '/'}`);
      if (!url) return { ...row, probeStatus: 0, probeError: 'invalid Cloudflare URL' };
      const response = await fetchWithRetry(url, { fetchImpl, timeoutMs });
      return { ...row, url, probeStatus: response.status, probeError: response.error || null, attempts: response.attempts };
    });
    const confirmedPersistent = probes.filter((row) => Number(row.probeStatus) >= 500);
    const coverage = summarizeCloudflareProbeCoverage({ total5xx, paths, probes });
    const bySurface = {};
    for (const row of paths) {
      const surface = classifySurface({ host: row.host, path: row.path });
      const bucket = bySurface[surface] || (bySurface[surface] = { total: 0, paths: 0 });
      bucket.total += Number(row.count || 0);
      bucket.paths += 1;
    }
    const finishedAt = new Date().toISOString();
    return {
      source: sourceResult({ name: 'cloudflare-analytics', startedAt, finishedAt, rows: diagnostics.length + paths.length }),
      available: true,
      total5xx,
      synthesized5xx: diagnostics.filter(isSynthesizedByEdge).reduce((sum, row) => sum + Number(row.count || 0), 0),
      sampledPath5xx: coverage.sampledPath5xx,
      transient5xx: coverage.transient5xx,
      unverified5xx: coverage.unverified5xx,
      unprobed5xx: coverage.unprobed5xx,
      unresolved5xx: coverage.unresolved5xx,
      bySurface,
      diagnostics,
      paths: paths.slice(0, 100),
      probes,
      confirmedPersistent,
    };
  } catch (error) {
    return {
      source: sourceResult({ name: 'cloudflare-analytics', startedAt, finishedAt: new Date().toISOString(), error: safeError(error) }),
      available: false,
      total5xx: null,
      sampledPath5xx: null,
      transient5xx: null,
      unverified5xx: null,
      unprobed5xx: null,
      unresolved5xx: null,
      diagnostics: [],
      paths: [],
      confirmedPersistent: [],
    };
  }
}

async function collectGa4({ fetchImpl = fetch, days = DEFAULT_GA4_DAYS } = {}) {
  const startedAt = new Date().toISOString();
  if (!process.env.GA4_PROPERTY_ID) {
    return {
      source: sourceResult({ name: 'ga4', startedAt, finishedAt: new Date().toISOString(), skipped: true, error: 'GA4_PROPERTY_ID missing' }),
      available: false,
      pages: [],
      lowEngagement: [],
    };
  }
  try {
    const { start, end } = windowDates(finitePositive(days, DEFAULT_GA4_DAYS));
    const result = await fetchGa4Pages({ startDate: start, endDate: end, fetchImpl });
    if (result.error) throw new Error(result.error);
    const pages = Object.entries(result.pages || {})
      .map(([page, metrics]) => ({ page, sessions: Number(metrics.sessions || 0), engageTime: Number(metrics.engageTime || 0), cluster: metrics.cluster || 'generic' }))
      .sort((a, b) => b.sessions - a.sessions);
    const lowEngagement = pages.filter((row) => row.sessions >= 100 && row.engageTime < 5).slice(0, 20);
    return {
      source: sourceResult({ name: 'ga4', startedAt, finishedAt: new Date().toISOString(), rows: pages.length }),
      available: true,
      window: { start, end, days: finitePositive(days, DEFAULT_GA4_DAYS) },
      pages: pages.slice(0, 50),
      lowEngagement,
    };
  } catch (error) {
    return {
      source: sourceResult({ name: 'ga4', startedAt, finishedAt: new Date().toISOString(), error: safeError(error) }),
      available: false,
      pages: [],
      lowEngagement: [],
    };
  }
}

function newestCtrCheck(state) {
  const familyEntries = Object.entries(state?.families || {});
  const families = familyEntries.map(([, family]) => family);
  const checked = families.map((family) => family.lastCheckedIso).filter(Boolean).sort();
  const lastCheckedAt = checked.at(-1) || null;
  const belowTarget = familyEntries
    .filter(([, family]) => !family.lastError && Number(family.consecutiveBelowRuns) > 0)
    .map(([familyName, family]) => ({ family: familyName, ctr: family.lastCtr, target: family.lastTargetCtr, position: family.lastPosition, consecutiveRuns: family.consecutiveBelowRuns }));
  return { available: families.length > 0, lastCheckedAt, familyCount: families.length, belowTarget };
}

function collectRepositorySignals(root = ROOT) {
  const ctr = newestCtrCheck(readJson(path.join(root, 'data', 'seo-ctr-monitor-state.json')));
  const autopilot = readJson(path.join(root, 'data', 'seo-serp-autopilot-last-run.json'));
  const cwv = readJson(path.join(root, 'data', 'cwv-monitor-history.json'));
  const opportunity = readJson(path.join(root, 'data', 'gsc-content-refresh', 'opportunity-report.json'));
  const cwvPages = Object.values(cwv?.pages || {});
  const cwvLast = cwvPages.flatMap((page) => page.weeks || []).sort((a, b) => String(a.date).localeCompare(String(b.date))).at(-1) || null;
  return {
    gscCtr: ctr,
    gscOpportunity: opportunity ? { generated: opportunity.generated || null, window: opportunity.window || null, candidates: opportunity.candidates || [] } : null,
    serpAutopilot: autopilot ? { generatedAt: autopilot.generatedAt || null, decision: autopilot.decision || null, kpi: autopilot.kpi || null } : null,
    cwv: { available: Boolean(cwvLast), last: cwvLast },
  };
}

function ageDays(iso, now) {
  const at = Date.parse(iso || '');
  return Number.isFinite(at) ? (Date.parse(now) - at) / 86_400_000 : Infinity;
}

function addSourceFindings(active, sources, strictSources, now) {
  if (!strictSources) return;
  for (const source of Object.values(sources || {})) {
    if (source?.available) continue;
    active.push({
      code: 'source-unavailable',
      url: `source:${source?.name || 'unknown'}`,
      detail: source?.error || 'source did not return a trustworthy result',
    });
  }
  // GSC is intentionally represented by the state produced by the dedicated
  // weekly monitor.  A stale state is not a current SEO verdict.
  if (sources.gscState?.available && ageDays(sources.gscState.lastCheckedAt, now) > DEFAULT_GSC_STATE_MAX_AGE_DAYS) {
    active.push({
      code: 'gsc-state-stale',
      url: 'source:gsc-ctr-monitor',
      detail: sources.gscState.lastCheckedAt || 'missing data/seo-ctr-monitor-state.json',
    });
  }
}

function withFindingKeys(findings) {
  return (findings || []).map((finding) => ({
    ...finding,
    key: `${finding.code}|${finding.url}`,
  }));
}

function phaseStatus(findings, codes, actionableKeys, predicate = () => true) {
  const observed = findings.filter((finding) => codes.includes(finding.code) && predicate(finding));
  if (observed.length === 0) return { status: 'pass', observed: 0, actionable: 0 };
  const actionable = observed.filter((finding) => actionableKeys.has(`${finding.code}|${finding.url}`));
  return { status: actionable.length ? 'fail' : 'degraded', observed: observed.length, actionable: actionable.length };
}

function buildIssueBody(report) {
  const actionable = report.findings.actionable.slice(0, MAX_ISSUE_FINDINGS);
  const lines = [
    'Il closed-loop SEO health runner ha osservato difetti ripetuti in produzione.',
    '',
    `**Run:** ${process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : 'locale'}`,
    `**Rilevato:** ${report.generatedAt}`,
    `**Soglia:** ${report.findings.threshold} run consecutivi`,
    '',
    '## Implementato',
    '- Il runner verifica live sitemap, canonical, status, noindex e JobPosting con campionamento deterministico.',
    '- Le fonti GA4 e Cloudflare sono registrate con stato/finestra; una fonte assente non diventa un falso zero.',
    '- Il workflow collegato applica solo la riconciliazione 404 già protetta da resolver, floor guard e prune strict.',
    '',
    '## Difetti osservati',
  ];
  for (const finding of actionable) {
    lines.push(`- **${finding.code}** \`${finding.url}\` — ${finding.detail || 'nessun dettaglio aggiuntivo'}`);
  }
  if (report.findings.actionable.length > MAX_ISSUE_FINDINGS) lines.push(`- Altri ${report.findings.actionable.length - MAX_ISSUE_FINDINGS} finding nel report allegato.`);
  lines.push('', '## Non implementato (ancora)', '- Le modifiche a title, contenuto o canonical applicative restano manuali: questa PR non inventa contenuto da un segnale osservazionale.', '- I 5xx Cloudflare senza una copia edge servibile restano assegnati al monitor CF per evitare purge/redeploy speculativi.', '', `Report: ${report.reportPath}`);
  return lines.join('\n');
}

async function reportIssueIfNeeded(report) {
  if (!report.options.openIssue || !process.env.GH_TOKEN) return { attempted: false, persisted: false };
  try {
    const { createGithubIssue, resolveGithubIssue } = await import('../lib/github-issue-creator.mjs');
    if (!report.findings.actionable.length) {
      // Resolve only after a genuinely green observation.  A degraded source,
      // a transient finding, or a first clean run must not close an issue.
      const canResolve = Boolean(
        report.recovery?.previousActionable
        && report.findings.observed.length === 0,
      );
      if (!canResolve) return { attempted: false, persisted: false };
      const result = resolveGithubIssue(
        'SEO health loop: repeated production findings',
        {
          workflow: process.env.GITHUB_WORKFLOW || 'SEO closed-loop health and recovery',
          runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
            ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
            : undefined,
        },
      );
      return { attempted: true, persisted: Boolean(result), resolved: Boolean(result) };
    }
    const result = await createGithubIssue({
      title: 'SEO health loop: repeated production findings',
      description: buildIssueBody(report),
      priority: 2,
      labels: ['seo', 'monitoring', 'automation'],
      workflow: process.env.GITHUB_WORKFLOW || 'SEO closed-loop health and recovery',
      dedupKey: 'SEO health loop:',
    });
    return { attempted: true, persisted: Boolean(result?.persisted !== false) };
  } catch (error) {
    console.error(`[seo-health-loop] issue reporter failed: ${safeError(error)}`);
    return { attempted: true, persisted: false, error: safeError(error) };
  }
}

/** Run the five-phase live check.  Network and clock are injectable for tests. */
export async function runSeoHealthLoop({
  options = {},
  fetchImpl = fetch,
  now = new Date(),
  collectAnalytics = true,
  root = ROOT,
} = {}) {
  const opts = { ...parseArgs([]), ...options };
  const reportDir = options.reportDir || (root === ROOT ? DEFAULT_REPORT_DIR : path.join(root, 'data', 'seo-health'));
  const statePath = options.statePath || (root === ROOT ? DEFAULT_STATE_PATH : path.join(root, 'data', 'seo-health-state.json'));
  const historyPath = options.historyPath || path.join(reportDir, 'history.jsonl');
  const generatedAt = new Date(now).toISOString();
  const cycle = buildCycleIdentity({ now });
  const budget = createCycleBudget(fetchImpl, {
    maxFetches: opts.maxFetches,
    maxDurationMs: opts.cycleBudgetMs,
  });
  const cycleFetch = budget.fetch;
  const graph = await loadSitemapGraph({ origin: opts.origin, sitemap: opts.sitemap, fetchImpl: cycleFetch, timeoutMs: opts.timeoutMs });
  const pageAudit = await probePages(graph.entries, { fetchImpl: cycleFetch, timeoutMs: opts.timeoutMs, sample: opts.sample, jobSample: opts.jobSample, origin: opts.origin });
  const cloudflare = collectAnalytics ? await collectCloudflare({ fetchImpl: cycleFetch, timeoutMs: opts.timeoutMs, errorSample: opts.errorSample }) : { source: sourceResult({ name: 'cloudflare-analytics', skipped: true, error: 'disabled for this run' }), available: false, confirmedPersistent: [], paths: [], diagnostics: [] };
  const ga4 = collectAnalytics ? await collectGa4({ fetchImpl: cycleFetch, days: opts.ga4Days }) : { source: sourceResult({ name: 'ga4', skipped: true, error: 'disabled for this run' }), available: false, pages: [], lowEngagement: [] };
  const repository = collectRepositorySignals(root);

  const cfFindings = cloudflare.confirmedPersistent.map((row) => ({
    code: 'cloudflare-5xx-persistent',
    url: row.url || `https://${row.host}${row.path}`,
    detail: `edge=${row.status} count=${row.count} live=${row.probeStatus} surface=${classifySurface({ host: row.host, path: row.path })}`,
  }));
  const unresolved5xx = Number(cloudflare.unresolved5xx || 0);
  if (unresolved5xx > 0) {
    cfFindings.push({
      code: 'cloudflare-5xx-unverified',
      url: 'source:cloudflare-5xx-unverified',
      detail: `count=${unresolved5xx} sampled-out-or-unprobed; no live recovery asserted`,
    });
  }
  const sourceFindings = [];
  const sources = {
    sitemap: graph.source,
    pageSample: pageAudit.source,
    cloudflare: cloudflare.source,
    ga4: ga4.source,
    gscState: {
      name: 'gsc-ctr-monitor',
      available: repository.gscCtr.available,
      rows: repository.gscCtr.familyCount,
      lastCheckedAt: repository.gscCtr.lastCheckedAt,
      error: repository.gscCtr.available ? null : 'missing or empty data/seo-ctr-monitor-state.json',
    },
  };
  addSourceFindings(sourceFindings, sources, Boolean(opts.strictSources), generatedAt);

  const allFindings = withFindingKeys([
    ...graph.findings,
    ...pageAudit.findings,
    ...cfFindings,
    ...sourceFindings,
  ]);
  const previousState = readJson(statePath, {});
  const nextState = advanceFindingStreaks(previousState, allFindings, now);
  nextState.cleanRuns = allFindings.length === 0 ? Number(previousState.cleanRuns || 0) + 1 : 0;
  nextState.lastActionable = allFindings.length > 0 && Object.values(nextState.findings).some((finding) => Number(finding.consecutiveRuns) >= opts.findingThreshold);
  const actionable = actionableStreaks(nextState, opts.findingThreshold);
  const actionableKeys = new Set(actionable.map((finding) => `${finding.code}|${finding.url}`));
  const demandPhase = phaseStatus(allFindings, ['source-unavailable', 'gsc-state-stale'], actionableKeys, (finding) => finding.code === 'gsc-state-stale' || finding.url === 'source:ga4' || finding.url === 'source:gsc-ctr-monitor');
  const demandOpportunities = {
    ga4LowEngagement: ga4.lowEngagement || [],
    gscCtrBelowTarget: repository.gscCtr.belowTarget || [],
  };
  const demandOpportunityCount = demandOpportunities.ga4LowEngagement.length + demandOpportunities.gscCtrBelowTarget.length;
  if (demandPhase.status === 'pass' && demandOpportunityCount > 0) {
    demandPhase.status = 'degraded';
    demandPhase.observed = demandOpportunityCount;
  }
  const resiliencePhase = phaseStatus(allFindings, ['cloudflare-5xx-persistent', 'cloudflare-5xx-unverified', 'news-sitemap-invalid', 'source-unavailable'], actionableKeys, (finding) => finding.code !== 'source-unavailable' || finding.url === 'source:cloudflare-analytics');
  const transient5xxCount = Number(cloudflare.transient5xx || 0);
  if (resiliencePhase.status === 'pass' && Number(cloudflare.total5xx || 0) > 0) {
    resiliencePhase.status = 'degraded';
    resiliencePhase.observed = Number(cloudflare.total5xx || 0);
  }
  const report = {
    schemaVersion: 1,
    generatedAt,
    cycle: {
      ...cycle,
      budget: budget.snapshot(),
    },
    options: {
      origin: opts.origin,
      sitemap: opts.sitemap,
      sample: opts.sample,
      jobSample: opts.jobSample,
      findingThreshold: opts.findingThreshold,
      maxFetches: opts.maxFetches,
      cycleBudgetMs: opts.cycleBudgetMs,
      dryRun: Boolean(opts.dryRun),
      strictSources: Boolean(opts.strictSources),
      openIssue: Boolean(opts.openIssue),
      autoCorrection: Boolean(opts.autoCorrection),
    },
    phases: {
      phase1_crawlability: phaseStatus(allFindings, ['robots-unavailable', 'sitemap-fetch-error', 'sitemap-graph-truncated', 'sitemap-external-host', 'sitemap-no-trailing-slash', 'source-unavailable'], actionableKeys, (finding) => finding.code !== 'source-unavailable' || finding.url === 'source:live-sitemap'),
      phase2_indexing: phaseStatus(allFindings, ['http-client-error', 'http-server-error', 'network-error', 'sitemap-redirect', 'sitemap-followed-redirect', 'canonical-missing', 'canonical-mismatch', 'sitemap-noindex', 'source-unavailable'], actionableKeys, (finding) => finding.code !== 'source-unavailable' || finding.url === 'source:live-page-sample'),
      phase3_job_quality: phaseStatus(allFindings, ['jobposting-missing'], actionableKeys),
      phase4_demand: demandPhase,
      phase5_resilience: resiliencePhase,
    },
    sources,
    sitemap: {
      robots: graph.robots,
      files: graph.files,
      entries: graph.entries.length,
      duplicateEntries: graph.duplicateEntries,
    },
    pageAudit: {
      candidateCount: pageAudit.candidateCount,
      jobCandidateCount: pageAudit.jobCandidateCount,
      sampledCount: pageAudit.sampledCount,
      sampledJobCount: pageAudit.sampledJobCount,
      probes: pageAudit.probes,
    },
    demand: {
      ga4: { window: ga4.window || null, topPages: ga4.pages || [], lowEngagement: ga4.lowEngagement || [] },
      gsc: repository.gscCtr,
      opportunities: demandOpportunities,
      contentOpportunity: repository.gscOpportunity,
      serpAutopilot: repository.serpAutopilot,
    },
    resilience: {
      cloudflare: {
        total5xx: cloudflare.total5xx,
        synthesized5xx: cloudflare.synthesized5xx ?? null,
        sampledPath5xx: cloudflare.sampledPath5xx ?? null,
        transient5xx: transient5xxCount > 0 ? transient5xxCount : 0,
        unverified5xx: cloudflare.unverified5xx ?? null,
        unprobed5xx: cloudflare.unprobed5xx ?? null,
        unresolved5xx: cloudflare.unresolved5xx ?? null,
        bySurface: cloudflare.bySurface || {},
        topPaths: cloudflare.paths || [],
        confirmedPersistent: cloudflare.confirmedPersistent || [],
      },
      news: graph.files.filter((file) => /news/i.test(file.name)).map((file) => ({ name: file.name, url: file.url, status: file.status, ...file.news })),
      cwv: repository.cwv,
    },
    findings: {
      threshold: opts.findingThreshold,
      observed: allFindings,
      actionable,
      recoveredSincePreviousRun: Object.keys(previousState.findings || {}).filter((key) => !nextState.findings[key]),
    },
    recovery: {
      previousActionable: Boolean(previousState.lastActionable),
      automatic: opts.autoCorrection ? [
        'Il workflow esegue la riconciliazione del compat store 404 tramite resolver + floor guard + PRUNE_404_STRICT=1.',
        'Il workflow committa e dispatcha il deploy solo quando cambiano gli shard compat, con retry di push.',
      ] : [],
      manual: [
        'canonical/title/JobPosting: correggere il generatore e verificare con i gate post-build.',
        'Cloudflare 5xx sintetizzati senza copia cache: usare cf-5xx-monitor e il report per superficie; niente purge automatico cieco.',
        'GA4 low engagement: usare il dato come opportunità UX/latency, non come prova di una causa SEO.',
      ],
    },
    state: nextState,
  };
  report.reportPath = path.join(reportDir, 'latest.json');
  report.issue = opts.dryRun
    ? { attempted: false, persisted: false, skipped: 'dry-run' }
    : await reportIssueIfNeeded(report);
  report.exitCode = actionable.length ? 1 : 0;

  // A dry-run must remain ephemeral, but its report is still the observable
  // output consumed by the workflow artifact upload.  Persist only that
  // report; state and history remain untouched so a dry-run cannot advance a
  // finding streak or influence the next automatic correction.
  writeJsonAtomic(report.reportPath, report);
  if (!opts.dryRun) {
    writeJsonAtomic(statePath, nextState);
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    const historyEntry = {
      historyKey: cycle.idempotencyKey,
      generatedAt,
      cycleBudget: budget.snapshot(),
      runId: process.env.GITHUB_RUN_ID || null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
      phaseStatuses: Object.fromEntries(Object.entries(report.phases).map(([name, value]) => [name, value.status])),
      sources: Object.fromEntries(Object.entries(sources).map(([name, value]) => [name, value.available])),
      observed: allFindings.length,
      actionable: actionable.length,
      cfTotal5xx: cloudflare.total5xx ?? null,
      ga4LowEngagement: ga4.lowEngagement?.length || 0,
    };
    const historyLines = fs.existsSync(historyPath)
      ? fs.readFileSync(historyPath, 'utf8').split(/\r?\n/).filter(Boolean)
      : [];
    const alreadyRecorded = historyLines.some((line) => {
      try {
        return JSON.parse(line).historyKey === historyEntry.historyKey;
      } catch {
        return false;
      }
    });
    if (!alreadyRecorded) {
      historyLines.push(JSON.stringify(historyEntry));
    }
    if (historyLines.length > MAX_HISTORY_LINES) {
      fs.writeFileSync(historyPath, `${historyLines.slice(-MAX_HISTORY_LINES).join('\n')}\n`, 'utf8');
    } else if (!alreadyRecorded) {
      fs.appendFileSync(historyPath, `${JSON.stringify(historyEntry)}\n`, 'utf8');
    }
  }
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.sample = finitePositive(options.sample, DEFAULT_SAMPLE);
  options.jobSample = finitePositive(options.jobSample, DEFAULT_JOB_SAMPLE);
  options.errorSample = finitePositive(options.errorSample, DEFAULT_ERROR_SAMPLE);
  options.timeoutMs = finitePositive(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  options.ga4Days = finitePositive(options.ga4Days, DEFAULT_GA4_DAYS);
  options.findingThreshold = finitePositive(options.findingThreshold, DEFAULT_FINDING_THRESHOLD);
  options.maxFetches = finitePositive(options.maxFetches, DEFAULT_MAX_FETCHES);
  options.cycleBudgetMs = finitePositive(options.cycleBudgetMs, DEFAULT_CYCLE_BUDGET_MS);
  const report = await runSeoHealthLoop({ options });
  console.log(`[seo-health-loop] ${report.generatedAt}`);
  console.log(`  sitemap: ${report.sitemap.entries} URL, sample: ${report.pageAudit.sampledCount} (${report.pageAudit.sampledJobCount} job)`);
  console.log(`  GA4: ${report.sources.ga4.available ? 'available' : report.sources.ga4.error}; Cloudflare: ${report.sources.cloudflare.available ? `${report.resilience.cloudflare.total5xx} 5xx` : report.sources.cloudflare.error}`);
  console.log(`  phases: ${Object.entries(report.phases).map(([name, phase]) => `${name}=${phase.status}`).join(', ')}`);
  console.log(`  findings: ${report.findings.observed.length} observed, ${report.findings.actionable.length} actionable after ${report.findings.threshold} runs`);
  console.log(`  report: ${report.reportPath}`);
  if (report.findings.actionable.length) {
    for (const finding of report.findings.actionable.slice(0, 20)) console.log(`  ❌ ${finding.code} ${finding.url} (${finding.consecutiveRuns} run)`);
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[seo-health-loop] fatal: ${safeError(error)}`);
    process.exitCode = 1;
  });
}
