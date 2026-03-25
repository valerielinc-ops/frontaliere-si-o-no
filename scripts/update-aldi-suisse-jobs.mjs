#!/usr/bin/env node
/**
 * Dedicated ALDI Suisse crawler runner.
 *
 * ALDI uses SAP SuccessFactors as their ATS. Their careers portal is at
 * jobs.aldi.ch with the backend on career5.successfactors.eu.
 *
 * ALDI has multiple stores in Ticino, making their positions relevant
 * for Italian cross-border workers.
 *
 * This script:
 *   1. Fetches the ALDI careers listing page
 *   2. Extracts job URLs from the page
 *   3. Updates adapter seed URLs
 *   4. Runs base crawler for detail parsing/localization
 *   5. Validates locale coverage
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

const ALDI_KEY = 'aldi-suisse';
const ALDI_COMPANY_NAME = 'ALDI SUISSE';
const ALDI_HOST = 'www.jobs.aldi.ch';
const ALDI_LISTING_URL = 'https://www.jobs.aldi.ch/it';

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Matchers ──────────────────────────────────────────────── */
function isAldiJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === ALDI_KEY ||
    key.includes('aldi') ||
    company.includes('aldi') ||
    host === ALDI_HOST ||
    host.endsWith('aldi.ch') ||
    (host.includes('successfactors') && url.includes('aldisuis'))
  );
}

/* ── Discovery ─────────────────────────────────────────────── */
async function fetchAldiJobUrls() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  console.log(`🔍 Fetching ALDI Suisse listing page: ${ALDI_LISTING_URL}`);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(ALDI_LISTING_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': UA,
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`⚠️ ALDI listing page returned ${res.status}`);
      return [];
    }

    const html = await res.text();

    // Extract job URLs from rendered HTML
    const urls = new Set();
    // Look for links to job detail pages or SuccessFactors
    const linkPattern = /href="([^"]*(?:ricerca-posizione|stelle|career5\.successfactors)[^"]*)"/gi;
    let match;
    while ((match = linkPattern.exec(html)) !== null) {
      const url = match[1].startsWith('http') ? match[1] : `https://${ALDI_HOST}${match[1]}`;
      urls.add(url);
    }

    // Also extract direct job card links
    const cardPattern = /href="(\/it\/[^"]*[a-z]-\d+[^"]*)"/gi;
    while ((match = cardPattern.exec(html)) !== null) {
      urls.add(`https://${ALDI_HOST}${match[1]}`);
    }

    console.log(`✅ Discovered ${urls.size} ALDI Suisse job URLs`);
    return [...urls];
  } catch (err) {
    console.warn(`⚠️ Failed to fetch ALDI listing page: ${err.message}`);
    return [];
  }
}

/* ── Adapter ───────────────────────────────────────────────── */
function ensureAdapterSeedUrls(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${ALDI_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${ALDI_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: ALDI_KEY,
      companyName: ALDI_COMPANY_NAME,
      companyHost: ALDI_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['jsonld', 'html', 'generic_ats'],
      seedUrls: seedUrls.length > 0 ? seedUrls : [ALDI_LISTING_URL],
      notes: 'ALDI Suisse careers portal (SAP SuccessFactors ATS). Filter for Ticino locations.',
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
    adapter.seedUrls = seedUrls.length > 0 ? seedUrls : adapter.seedUrls || [ALDI_LISTING_URL];
    adapter.updatedAt = new Date().toISOString();
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    console.log(`📝 Adapter ${ALDI_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

/* ── Base Crawler ──────────────────────────────────────────── */
function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: ALDI_KEY,
    localizeOnlyCompanyKeys: ALDI_KEY,
    forceLocalizeKeys: ALDI_KEY,
    disableWorkdayForce: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '80',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '80',
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
  const jobs = allJobs.filter(isAldiJob);

  console.log(`\n📊 === ALDI Suisse Job Stats ===`);
  console.log(`  🛒 Total ALDI Suisse jobs: ${jobs.length}`);
  console.log('');

  const afterSnapshot = snapshotJobSlugs(jobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'ALDI Suisse');
  writeCrawlChangeSummaryToGH(crawlDiff, 'ALDI Suisse');

  return { total: jobs.length };
}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_ALDI_SUISSE_STRICT',
    label: 'ALDI Suisse',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isAldiJob,
    noJobsMessage: 'No ALDI Suisse jobs found after crawl.',
    maxToleratedMissingDescriptions: 5,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  console.log('🛒 Running dedicated ALDI Suisse jobs crawler...');
  console.log(`   Portal: ${ALDI_HOST} (SuccessFactors ATS)`);
  console.log('');

  const detailUrls = await fetchAldiJobUrls();
  ensureAdapterSeedUrls(detailUrls);

  let _beforeSnapshot = new Map();
  if (fs.existsSync(DATA_JOBS)) {
    try {
      const pre = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
      _beforeSnapshot = snapshotJobSlugs(Array.isArray(pre) ? pre.filter(isAldiJob) : []);
    } catch {}
  }

  await runBaseCrawler();

  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isAldiJob,
  });

  const stats = logStats(_beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No ALDI Suisse jobs found after crawl. Exiting OK.');
    return;
  }

  validateLocaleCoverage();

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS)
    ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'))
    : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isAldiJob) : [];
  writeJobsCrawlerSlice(ALDI_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: ALDI_KEY,
    label: 'ALDI Suisse',
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
  console.error(`❌ ALDI Suisse crawler failed: ${err?.message || err}`);
  process.exit(1);
});
