#!/usr/bin/env node
/**
 * Dedicated Capri Holdings (Michael Kors / Versace) crawler runner.
 *
 * Capri Holdings uses Workday as their ATS. They have a major logistics
 * hub in Mendrisio (TI) employing hundreds of workers.
 *
 * This script:
 *   1. Uses adapter seed URLs (Workday career pages)
 *   2. Runs base crawler to extract JSON-LD from Workday pages
 *   3. Filters for Swiss/Ticino positions
 *   4. Translates missing locales and validates coverage
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
  assembleJobsDataset,
} from './assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  normalize,
  normalizeKey,
} from './lib/dedicated-crawler-common.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const CAPRI_KEY = 'capri-holdings';
const CAPRI_COMPANY_NAME = 'Capri Holdings (Michael Kors / Versace)';
const CAPRI_HOST = 'capriholdings.wd1.myworkdayjobs.com';

const SEED_URLS = [
  'https://capriholdings.wd1.myworkdayjobs.com/Capri_Careers',
  'https://versace.wd5.myworkdayjobs.com/Versace_Careers',
  'https://michaelkors.wd5.myworkdayjobs.com/MichaelKors',
];

/* ── Matchers ──────────────────────────────────────────────── */
function isCapriJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === CAPRI_KEY ||
    key.includes('capri') ||
    key.includes('michael-kors') ||
    key.includes('versace') ||
    key.includes('jimmy-choo') ||
    company.includes('capri') ||
    company.includes('michael kors') ||
    company.includes('versace') ||
    company.includes('jimmy choo') ||
    host.includes('capriholdings') ||
    host.includes('versace') && host.includes('myworkdayjobs') ||
    host.includes('michaelkors') && host.includes('myworkdayjobs')
  );
}

/* ── Adapter ───────────────────────────────────────────────── */
function ensureAdapter() {
  const adapterPath = path.join(ADAPTERS_DIR, `${CAPRI_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${CAPRI_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: CAPRI_KEY,
      companyName: CAPRI_COMPANY_NAME,
      companyHost: CAPRI_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['jsonld', 'html', 'generic_ats'],
      seedUrls: SEED_URLS,
      notes: 'Capri Holdings (Michael Kors / Versace / Jimmy Choo) Workday ATS. Mendrisio logistics hub in Ticino.',
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
    if (!adapter.seedUrls || adapter.seedUrls.length === 0) {
      adapter.seedUrls = SEED_URLS;
    }
    adapter.updatedAt = new Date().toISOString();
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

/* ── Base Crawler ──────────────────────────────────────────── */
function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: CAPRI_KEY,
    localizeOnlyCompanyKeys: CAPRI_KEY,
    forceLocalizeKeys: CAPRI_KEY,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '100',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '100',
      JOBS_CRAWLER_FETCH_RETRIES: process.env.JOBS_CRAWLER_FETCH_RETRIES || '2',
      JOBS_CRAWLER_CONCURRENCY: process.env.JOBS_CRAWLER_CONCURRENCY || '3',
    },
  });
}

/* ── Stats & Validation ────────────────────────────────────── */
function logStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json not found — no stats available.');
    return { total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const jobs = allJobs.filter(isCapriJob);

  console.log(`\n📊 === Capri Holdings Job Stats ===`);
  console.log(`  👜 Total Capri Holdings jobs: ${jobs.length}`);
  console.log('');

  const afterSnapshot = snapshotJobSlugs(jobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Capri Holdings');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Capri Holdings');

  return { total: jobs.length };
}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_CAPRI_HOLDINGS_STRICT',
    label: 'Capri Holdings',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isCapriJob,
    noJobsMessage: 'No Capri Holdings jobs found after crawl.',
    maxToleratedMissingDescriptions: 5,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  console.log('👜 Running dedicated Capri Holdings jobs crawler...');
  console.log('   Brands: Michael Kors, Versace, Jimmy Choo');
  console.log('   ATS: Workday');
  console.log('');

  ensureAdapter();

  let _beforeSnapshot = new Map();
  if (fs.existsSync(DATA_JOBS)) {
    try {
      const pre = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
      _beforeSnapshot = snapshotJobSlugs(Array.isArray(pre) ? pre.filter(isCapriJob) : []);
    } catch {}
  }

  await runBaseCrawler();

  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isCapriJob,
  });

  const stats = logStats(_beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No Capri Holdings jobs found after crawl. Exiting OK.');
    return;
  }

  validateLocaleCoverage();

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS)
    ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'))
    : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isCapriJob) : [];
  writeJobsCrawlerSlice(CAPRI_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: CAPRI_KEY,
    label: 'Capri Holdings',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: 0,
    updatedCount: 0,
    removedCount: 0,
    unchangedCount: _sliceJobs.length,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: [],
    updatedJobs: [],
    removedJobs: [],
    unchangedJobs: _sliceJobs.slice(0, 30),
  });
  await assembleJobsDataset();
}

main().catch((err) => {
  console.error(`❌ Capri Holdings crawler failed: ${err?.message || err}`);
  process.exit(1);
});
