#!/usr/bin/env node
/**
 * Dedicated EMS-Chemie AG crawler runner.
 *
 * Source:
 *   https://www.ems-group.com/en/career/job-vacancies/
 *
 * EMS-Chemie AG is the world.s leading producer of high-performance polyamides,
 * headquartered in Domat/Ems (Graubünden) with ~3000 employees globally.
 *
 * This script:
 *   1. Fetches the career page HTML.
 *   2. Parses job listings using the dedicated parser.
 *   3. Fetches detail pages for additional content.
 *   4. Merges discovered jobs into data/jobs.json.
 *   5. Updates the adapter config.
 *   6. Runs the shared base crawler for AI localization.
 *   7. Post-processes and validates.
 */
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
mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';
import { parseListingPage, parseDetailPage, buildJob, stripHtml } from './lib/ems-chemie-job-parser.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'ems-chemie';
const COMPANY_NAME = 'EMS-Chemie AG';
const COMPANY_HOST = 'www.ems-group.com';
/**
 * EMS-Group moved their job listings to a dedicated career portal.
 * The old static page at ems-group.com/en/career/job-vacancies/ loads
 * content dynamically and returns empty HTML to crawlers.
 * We try the portal first, then fall back to legacy URLs.
 */
const CAREERS_URLS = [
  'https://jobs.ems-group.com/',
  'https://www.ems-group.com/en/career/job-vacancies/',
  'https://www.ems-group.com/de/karriere/offene-stellen/',
];
const CAREERS_URL = CAREERS_URLS[0];
const LOCALES = ['it', 'en', 'de', 'fr'];
const UA = process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Matcher ───────────────────────────────────────────────── */
function isCompanyJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').trim();
  const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } })();
  return (
    key === COMPANY_KEY ||
    key.includes('ems-chemie') ||
    key.includes('ems-group') ||
    company.includes('ems-chemie') ||
    company.includes('ems group') ||
    host === COMPANY_HOST ||
    host === 'ems-group.com'
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === COMPANY_HOST || host === 'ems-group.com' || host === 'jobs.ems-group.com';
  } catch { return false; }
}

/* ── Fetch ─────────────────────────────────────────────────── */
async function fetchHtml(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/html', 'User-Agent': UA },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}

async function fetchJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;
  console.log(`🔍 Fetching ${COMPANY_NAME} career page...`);

  // Try each career URL until one returns job listings
  let allListings = [];
  for (const url of CAREERS_URLS) {
    try {
      const html = await fetchHtml(url, timeoutMs);
      const rawListings = parseListingPage(html);
      console.log(`  📋 ${url} → ${rawListings.length} listing(s)`);
      if (rawListings.length > 0) {
        allListings = rawListings;
        break;
      }
    } catch (err) {
      console.warn(`  ⚠️ Failed to fetch ${url}: ${err?.message || err}`);
    }
  }

  if (allListings.length === 0) {
    console.log('ℹ️  No job listings found on any career page URL.');
    return [];
  }

  const jobs = [];
  for (const listing of allListings) {
    const job = buildJob(listing);
    if (job) {
      console.log(`  ✅ ${job.title} (${job.location})`);
      jobs.push(job);
    }
  }

  console.log(`📋 Total unique ${COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

/* ── Merge ─────────────────────────────────────────────────── */
function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function jobMatchKey(job = {}) {
  return extractStableJobId(job.url) || String(job.slug || '').trim().toLowerCase();
}

function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonTargetJobs = existing.filter((job) => !isCompanyJob(job));
  const targetExisting = existing.filter(isCompanyJob);
  const beforeSnapshot = snapshotJobSlugs(targetExisting);
  const existingByKey = new Map(targetExisting.map((job) => [jobMatchKey(job), job]));

  let added = 0;
  let updated = 0;
  const mergedTarget = discoveredJobs.map((job) => {
    const prev = existingByKey.get(jobMatchKey(job));
    if (!prev) {
      added += 1;
      return job;
    }
    updated += 1;
    return {
      ...prev,
      ...job,
      postedDate: job.postedDate || prev.postedDate,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, job.descriptionByLocale, 30),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3),
      salaryMin: prev.salaryMin || job.salaryMin,
      salaryMax: prev.salaryMax || job.salaryMax,
      currency: prev.currency || job.currency,
      sourceLang: prev.sourceLang || job.sourceLang,
      needsRetranslation: prev.needsRetranslation ?? job.needsRetranslation,
    };
  });

  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  if (fs.existsSync(PUBLIC_DATA_JOBS)) writeJson(PUBLIC_DATA_JOBS, allJobs);

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);

  console.log(`  ➕ Added: ${added}\n  🔄 Updated: ${updated}\n  ➖ Removed: ${targetExisting.length - updated}\n  📦 Total: ${mergedTarget.length}`);
  return { total: mergedTarget.length, added, updated, diff };
}

/* ── Adapter ───────────────────────────────────────────────── */
function updateAdapterConfig(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);
  let adapter = {};
  try { adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8')); } catch { /* first run */ }
  const seedMetaByUrl = {};
  for (const url of seedUrls) seedMetaByUrl[url] = { company: COMPANY_NAME, companyDomain: 'ems-group.com' };
  adapter = { ...adapter, companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: 10, crawlerModes: ['html'], seedUrls, seedMetaByUrl, notes: 'Specialty chemicals company HQ in Domat/Ems (GR). Career page HTML crawler.', updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, `${JSON.stringify(adapter, null, 2)}\n`, 'utf-8');
  console.log(`📝 Adapter updated: ${adapterPath}`);
}

/* ── Base crawler ──────────────────────────────────────────── */
async function runBaseCrawler() {
  console.log('🚀 Running shared crawler for AI localization...');
  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true, forceLocalizationWhenAiEnabledOnly: true });
}

/* ── Post-processing ───────────────────────────────────────── */
function postProcess() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(jobs)) return;
  let changed = false;
  const seenKeys = new Map();
  const processed = jobs.filter((job) => {
    if (!isCompanyJob(job)) return true;
    if (job.company !== COMPANY_NAME) { job.company = COMPANY_NAME; changed = true; }
    if (job.companyKey !== COMPANY_KEY) { job.companyKey = COMPANY_KEY; changed = true; }
    const dedupKey = String(job.url || '').toLowerCase().replace(/\/+$/, '') || normalizeKey(job.slug || job.title || '');
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

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, COMPANY_NAME);
  console.log('═══════════════════════════════════════════════');
  console.log(`  ${COMPANY_NAME} — Dedicated Crawler`);
  console.log('═══════════════════════════════════════════════');

  const discoveredJobs = await fetchJobs();
  let diff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  if (discoveredJobs.length === 0) { console.log('ℹ️  No job listings found — skipping crawl.'); return; }

  const seedUrls = discoveredJobs.map((j) => j.url);
  const mergeResult = mergeJobs(discoveredJobs);
  diff = mergeResult.diff;
  updateAdapterConfig(seedUrls);
  await runBaseCrawler();
  postProcess();

  // Stats
  if (fs.existsSync(DATA_JOBS)) {
    const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
    const companyJobs = Array.isArray(jobs) ? jobs.filter(isCompanyJob) : [];
    console.log(`\n🏦 Total ${COMPANY_NAME} jobs: ${companyJobs.length}`);
    for (const j of companyJobs) console.log(`  • ${j.title} (${j.location})`);
  }

  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_EMS_CHEMIE_STRICT', label: COMPANY_NAME, dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_ems_group_domain', failWhenNoJobs: false, noJobsMessage: `No ${COMPANY_NAME} jobs found — the company may not have active openings.` });

  console.log(`✅ ${COMPANY_NAME} crawler complete.`);

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isCompanyJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: COMPANY_NAME, generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: _sliceJobs.slice(0, 30) });
  await assembleJobsDataset();
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) { main().catch((err) => { console.error(`❌ ${COMPANY_NAME} crawler failed:`, err); process.exit(1); }); }
