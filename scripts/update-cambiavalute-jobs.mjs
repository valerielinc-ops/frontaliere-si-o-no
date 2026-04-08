#!/usr/bin/env node
/**
 * Dedicated CambiaValute.ch (Chiasso) crawler runner.
 *
 * Source:
 *   https://cambiavalute.ch/annunci-di-lavoro/
 *
 * This script:
 *   1. Fetches the cambiavalute.ch careers listing page.
 *   2. Extracts detail URLs matching /annuncio-di-lavoro/{slug}/.
 *   3. Updates adapter seed URLs + seedMetaByUrl.
 *   4. Runs shared crawler scoped to cambiavalute company key.
 *   5. Post-processes rows for canonical consistency + dedupe.
 *   6. Enforces locale coverage in strict mode.
 */
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
  setCrawlerStartTime,
  getCrawlerElapsedMs,
} from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  detectLang,
  deriveLocalizedSlug,
  normalize,
  normalizeKey,
} from './lib/dedicated-crawler-common.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const CAMBIAVALUTE_KEY = 'cambiavalute';
const HQ = getCompanyDefaults(CAMBIAVALUTE_KEY);
const CAMBIAVALUTE_COMPANY_NAME = 'CambiaValute.ch';
const CAMBIAVALUTE_COMPANY_DOMAIN = 'cambiavalute.ch';
const CAMBIAVALUTE_HOST = 'cambiavalute.ch';
const CAMBIAVALUTE_LISTING_URL = 'https://cambiavalute.ch/annunci-di-lavoro/';
const CAMBIAVALUTE_LOCALES = ['it', 'en', 'de', 'fr'];

/* ── HTML helpers ──────────────────────────────────────────── */
function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&#0*38;|&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
}

function toAbsoluteUrl(rawUrl = '') {
  const value = decodeHtmlEntities(rawUrl);
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      url.hash = '';
      return url.href;
    } catch {
      return value;
    }
  }
  const pathname = value.startsWith('/') ? value : `/${value}`;
  return `https://${CAMBIAVALUTE_HOST}${pathname}`;
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === CAMBIAVALUTE_HOST || host.endsWith(`.${CAMBIAVALUTE_HOST}`);
  } catch {
    return false;
  }
}

function isCambiavalute(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').trim();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  return (
    key === CAMBIAVALUTE_KEY ||
    key.includes('cambiavalute') ||
    company.includes('cambiavalute') ||
    host === CAMBIAVALUTE_HOST ||
    host.endsWith(`.${CAMBIAVALUTE_HOST}`)
  );
}

/* ── Discovery ─────────────────────────────────────────────── */
/**
 * Extract job detail links from the listing page HTML.
 * Links match the pattern /annuncio-di-lavoro/{slug}/
 */
function parseJobLinksFromHtml(html = '') {
  const source = String(html || '');
  const hrefRe = /href=(["'])(.*?)\1/gi;
  const seen = new Map();
  let match = null;
  while ((match = hrefRe.exec(source)) !== null) {
    const rawHref = decodeHtmlEntities(match[2] || '');
    if (!rawHref) continue;
    const absolute = toAbsoluteUrl(rawHref);
    if (!absolute) continue;
    // Only keep links to job detail pages
    if (!/\/annuncio-di-lavoro\/[^/?#]+/i.test(absolute)) continue;
    try {
      const url = new URL(absolute);
      if (url.hostname.toLowerCase() !== CAMBIAVALUTE_HOST) continue;
      // Normalize: remove trailing slash differences, hash, etc.
      const canonical = `${url.origin}${url.pathname.replace(/\/+$/, '/')}`
        .replace(/([^/])$/, '$1/');
      const key = canonical.toLowerCase();
      if (!seen.has(key)) seen.set(key, canonical);
    } catch {
      // skip malformed URLs
    }
  }
  return [...seen.values()];
}

async function fetchListingPage(url, timeoutMs, userAgent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': userAgent,
      },
    });
    const html = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return html;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCambiavalute() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  const userAgent =
    process.env.JOBS_CRAWLER_USER_AGENT ||
    'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

  console.log(`🔍 Fetching CambiaValute.ch jobs from ${CAMBIAVALUTE_LISTING_URL}...`);

  let html = '';
  try {
    html = await fetchListingPage(CAMBIAVALUTE_LISTING_URL, timeoutMs, userAgent);
  } catch (err) {
    console.error(`❌ Failed to fetch listing page: ${err?.message || err}`);
    throw err;
  }

  const links = parseJobLinksFromHtml(html);
  console.log(`📦 Found ${links.length} job detail link(s).`);

  const seedMetaByUrl = {};
  for (const link of links) {
    seedMetaByUrl[link] = {
      location: 'Chiasso',
      canton: HQ.canton,
      country: 'CH',
      company: CAMBIAVALUTE_COMPANY_NAME,
      companyDomain: CAMBIAVALUTE_COMPANY_DOMAIN,
    };
  }

  return { seedUrls: links, seedMetaByUrl };
}

/* ── Adapter update ────────────────────────────────────────── */
function updateAdapter(seedUrls, seedMetaByUrl) {
  const adapterPath = path.join(ADAPTERS_DIR, `${CAMBIAVALUTE_KEY}.json`);
  let adapter = {};
  try {
    adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
  } catch { /* first run, will create new */ }

  adapter = {
    ...adapter,
    companyKey: CAMBIAVALUTE_KEY,
    companyName: CAMBIAVALUTE_COMPANY_NAME,
    companyHost: CAMBIAVALUTE_HOST,
    enabled: true,
    priority: 10,
    crawlerModes: ['html', 'jsonld'],
    seedUrls,
    seedDetailUrls: seedUrls,
    seedMetaByUrl,
    notes:
      'Dedicated CambiaValute.ch crawler — discovers job listings from cambiavalute.ch/annunci-di-lavoro/ and extracts detail page URLs under /annuncio-di-lavoro/{slug}/.',
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, `${JSON.stringify(adapter, null, 2)}\n`, 'utf-8');
  console.log(`📝 Adapter updated: ${adapterPath} (${seedUrls.length} seed URLs)`);
}

/* ── Run shared crawler ────────────────────────────────────── */
async function runBaseCrawler() {
  console.log('🚀 Running shared crawler scoped to CambiaValute.ch...');
  await runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: CAMBIAVALUTE_KEY,
    disableWorkdayForce: true,
    forceLocalizationWhenAiEnabledOnly: true,
  });
}

/* ── Post-processing ───────────────────────────────────────── */
function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function postProcess() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(jobs)) return;

  let changed = false;
  const seenKeys = new Map();

  const processed = jobs.filter((job) => {
    if (!isCambiavalute(job)) return true; // keep non-cambiavalute as-is

    // Canonicalize company fields
    if (job.company !== CAMBIAVALUTE_COMPANY_NAME) {
      job.company = CAMBIAVALUTE_COMPANY_NAME;
      changed = true;
    }
    if (job.companyKey !== CAMBIAVALUTE_KEY) {
      job.companyKey = CAMBIAVALUTE_KEY;
      changed = true;
    }
    if (!job.canton || job.canton !== HQ.canton) {
      job.canton = HQ.canton;
      changed = true;
    }
    if (!job.country || job.country !== 'CH') {
      job.country = 'CH';
      changed = true;
    }
    if (!job.sourceLang) {
      job.sourceLang = detectLang(job.description || job.title, 'it');
      changed = true;
    }

    // Deduplicate by URL
    const url = String(job.url || '').toLowerCase().replace(/\/+$/, '');
    const dedupKey = url || normalizeKey(job.slug || job.title || '');
    if (seenKeys.has(dedupKey)) return false;
    seenKeys.set(dedupKey, true);

    return true;
  });

  if (changed || processed.length !== jobs.length) {
    writeJson(DATA_JOBS, processed);
    if (fs.existsSync(PUBLIC_DATA_JOBS)) writeJson(PUBLIC_DATA_JOBS, processed);
    console.log(`🔧 Post-processed: ${jobs.length} → ${processed.length} jobs`);
  }
}

/* ── Stats ─────────────────────────────────────────────────── */
function logStats(before) {
  if (!fs.existsSync(DATA_JOBS)) return;
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const after = snapshotJobSlugs(Array.isArray(jobs) ? jobs.filter(isCambiavalute) : []);
  const diff = computeCrawlDiff(before, after);
  printCrawlChangeSummary(diff, 'CambiaValute.ch');
  writeCrawlChangeSummaryToGH(diff, 'CambiaValute.ch');
  return diff;
}

/* ── Locale validation ─────────────────────────────────────── */
function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_CAMBIAVALUTE_STRICT',
    label: 'CambiaValute.ch',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isCambiavalute,
    locales: CAMBIAVALUTE_LOCALES,
    isTrustedDomain: isTrustedDomain,
    untrustedDomainReason: 'url_not_cambiavalute_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No CambiaValute.ch jobs found — the company may not have active openings.',
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(CAMBIAVALUTE_KEY, 'Cambiavalute');
  console.log('═══════════════════════════════════════════════');
  console.log('  CambiaValute.ch — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');

  // Snapshot before
  const beforeMap = snapshotJobSlugs(readExistingCrawlerJobs(CAMBIAVALUTE_KEY, DATA_JOBS).filter(isCambiavalute))

  // Phase 1: discover detail URLs
  const { seedUrls, seedMetaByUrl } = await fetchCambiavalute();

  if (seedUrls.length === 0) {
    console.log('ℹ️ No job listings found on CambiaValute.ch — skipping crawl.');
    return;
  }

  // Phase 2: update adapter
  updateAdapter(seedUrls, seedMetaByUrl);

  // Phase 3: run shared crawler
  await runBaseCrawler();

  // Phase 4: post-process
  postProcess();

  // Phase 5: log stats
  const diff = logStats(beforeMap);

  // Phase 6: locale validation
  validateLocales();

  console.log('✅ CambiaValute.ch crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isCambiavalute) : [];
  writeJobsCrawlerSlice(CAMBIAVALUTE_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: CAMBIAVALUTE_KEY,
    label: 'Cambiavalute',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: diff.newJobs.length,
    updatedCount: diff.updatedJobs.length,
    removedCount: diff.removedJobs.length,
    unchangedCount: diff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: diff.newJobs.slice(0, 30),
    updatedJobs: diff.updatedJobs.slice(0, 30),
    removedJobs: diff.removedJobs.slice(0, 30),
    unchangedJobs: (diff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

main().catch((err) => {
  console.error('❌ CambiaValute.ch crawler failed:', err);
  process.exit(1);
});
