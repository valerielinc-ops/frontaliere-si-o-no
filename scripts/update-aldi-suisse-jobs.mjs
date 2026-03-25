#!/usr/bin/env node
/**
 * Dedicated ALDI Suisse crawler runner.
 *
 * ALDI uses SAP SuccessFactors as their ATS. Their careers portal is at
 * jobs.aldi.ch. The homepage renders job cards via JavaScript but includes
 * direct links to detail pages at /job/{numericId}.
 *
 * Detail pages at jobs.aldi.ch/job/{id} are SSR HTML with full job
 * descriptions, requirements, and benefits.
 *
 * This script:
 *   1. Fetches the ALDI homepage to discover job detail URLs (/job/{id})
 *   2. Fetches each detail page for job data
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
const ALDI_BASE = 'https://www.jobs.aldi.ch';
/**
 * Pages to scrape for job links. The homepage shows featured positions,
 * and the /it page shows the Italian version. Both may have different
 * job cards visible.
 */
const ALDI_LISTING_URLS = [
  'https://www.jobs.aldi.ch/',
  'https://www.jobs.aldi.ch/it',
  'https://www.jobs.aldi.ch/it/ricerca-posizione',
];

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
  const allUrls = new Set();
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;

  for (const listUrl of ALDI_LISTING_URLS) {
    console.log(`\ud83d\udd0d Fetching ALDI Suisse page: ${listUrl}`);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(listUrl, {
        signal: controller.signal,
        headers: { Accept: 'text/html', 'User-Agent': UA },
      });
      clearTimeout(timer);

      if (!res.ok) {
        console.warn(`\u26a0\ufe0f ALDI page returned ${res.status} for ${listUrl}`);
        continue;
      }

      const html = await res.text();

      // Extract /job/{numericId} links
      const jobIdPattern = /href="(\/job\/\d+)"/gi;
      let match;
      while ((match = jobIdPattern.exec(html)) !== null) {
        allUrls.add(`${ALDI_BASE}${match[1]}`);
      }

      // Extract full job URLs
      const fullJobPattern = /href="(https?:\/\/[^"]*jobs\.aldi\.ch\/job\/\d+)"/gi;
      while ((match = fullJobPattern.exec(html)) !== null) {
        allUrls.add(match[1]);
      }

      // Extract SuccessFactors links
      const sfPattern = /href="(https?:\/\/career5\.successfactors[^"]+(?:aldisuis|HoferSELive)[^"]*)"/gi;
      while ((match = sfPattern.exec(html)) !== null) {
        allUrls.add(match[1]);
      }
    } catch (err) {
      console.warn(`\u26a0\ufe0f Failed to fetch ALDI page ${listUrl}: ${err.message}`);
    }
  }

  console.log(`\u2705 Discovered ${allUrls.size} ALDI Suisse job URLs`);
  return [...allUrls];
}

/* ── Adapter ───────────────────────────────────────────────── */
function ensureAdapterSeedUrls(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${ALDI_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`\u26a0\ufe0f Adapter ${ALDI_KEY}.json not found \u2014 creating it.`);
    const adapter = {
      companyKey: ALDI_KEY,
      companyName: ALDI_COMPANY_NAME,
      companyHost: ALDI_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['html', 'generic_ats'],
      seedUrls: seedUrls.length > 0 ? seedUrls : ALDI_LISTING_URLS,
      notes: 'ALDI Suisse careers portal (SAP SuccessFactors ATS). Job detail pages at /job/{id}.',
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
    adapter.seedUrls = seedUrls.length > 0 ? seedUrls : adapter.seedUrls || ALDI_LISTING_URLS;
    adapter.updatedAt = new Date().toISOString();
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    console.log(`\ud83d\udcdd Adapter ${ALDI_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`\u26a0\ufe0f Could not update adapter: ${err.message}`);
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
    console.log('\u2139\ufe0f jobs.json not found \u2014 no stats available.');
    return { total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const jobs = allJobs.filter(isAldiJob);

  console.log(`\n\ud83d\udcca === ALDI Suisse Job Stats ===`);
  console.log(`  \ud83d\uded2 Total ALDI Suisse jobs: ${jobs.length}`);
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
  console.log('\ud83d\uded2 Running dedicated ALDI Suisse jobs crawler...');
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
    console.log('\u2139\ufe0f No ALDI Suisse jobs found after crawl. Exiting OK.');
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
  console.error(`\u274c ALDI Suisse crawler failed: ${err?.message || err}`);
  process.exit(1);
});
