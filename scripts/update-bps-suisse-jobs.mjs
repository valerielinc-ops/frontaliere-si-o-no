#!/usr/bin/env node
/**
 * Dedicated BPS (Banca Popolare di Sondrio) Suisse crawler runner.
 *
 * BPS Suisse is a banking institution headquartered in Lugano, TI.
 * Their careers page lists positions as simple HTML links.
 *
 * This script:
 *   1. Fetches the listing page at bps-suisse.ch/lavora-in-bps-suisse.php
 *   2. Extracts job detail URLs (carriera-*.php pattern)
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

const BPS_KEY = 'bps-suisse';
const BPS_COMPANY_NAME = 'BPS (Banca Popolare di Sondrio) SUISSE';
const BPS_HOST = 'www.bps-suisse.ch';
const BPS_LISTING_URL = 'https://www.bps-suisse.ch/lavora-in-bps-suisse.php';

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Matchers ──────────────────────────────────────────────── */
function isBpsJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === BPS_KEY ||
    key.includes('bps-suisse') ||
    key.includes('banca-popolare-di-sondrio') ||
    company.includes('bps') ||
    company.includes('banca popolare di sondrio') ||
    host === BPS_HOST ||
    host.endsWith('bps-suisse.ch')
  );
}

/* ── Discovery ─────────────────────────────────────────────── */
async function fetchBpsJobUrls() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  console.log(`🔍 Fetching BPS Suisse listing page: ${BPS_LISTING_URL}`);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(BPS_LISTING_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': UA,
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`⚠️ BPS listing page returned ${res.status}`);
      return [];
    }

    const html = await res.text();

    // Extract all carriera-*.php links
    const urlPattern = /href="(carriera-[^"]+\.php)"/gi;
    const urls = new Set();
    let match;
    while ((match = urlPattern.exec(html)) !== null) {
      urls.add(`https://${BPS_HOST}/${match[1]}`);
    }

    console.log(`✅ Discovered ${urls.size} BPS Suisse job detail URLs`);
    return [...urls];
  } catch (err) {
    console.warn(`⚠️ Failed to fetch BPS listing page: ${err.message}`);
    return [];
  }
}

/* ── Adapter ───────────────────────────────────────────────── */
function ensureAdapterSeedUrls(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${BPS_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${BPS_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: BPS_KEY,
      companyName: BPS_COMPANY_NAME,
      companyHost: BPS_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['html', 'generic_ats'],
      seedUrls,
      notes: 'BPS Suisse careers portal (simple HTML). Detail pages at carriera-*.php. Lugano-based banking.',
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
    adapter.seedUrls = seedUrls;
    adapter.updatedAt = new Date().toISOString();
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    console.log(`📝 Adapter ${BPS_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

/* ── Base Crawler ──────────────────────────────────────────── */
function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: BPS_KEY,
    localizeOnlyCompanyKeys: BPS_KEY,
    forceLocalizeKeys: BPS_KEY,
    disableWorkdayForce: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '30',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '30',
      JOBS_CRAWLER_FETCH_RETRIES: process.env.JOBS_CRAWLER_FETCH_RETRIES || '2',
      JOBS_CRAWLER_CONCURRENCY: process.env.JOBS_CRAWLER_CONCURRENCY || '2',
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
  const jobs = allJobs.filter(isBpsJob);

  console.log(`\n📊 === BPS Suisse Job Stats ===`);
  console.log(`  🏦 Total BPS Suisse jobs: ${jobs.length}`);
  console.log('');

  const afterSnapshot = snapshotJobSlugs(jobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'BPS Suisse');
  writeCrawlChangeSummaryToGH(crawlDiff, 'BPS Suisse');

  return { total: jobs.length };
}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_BPS_SUISSE_STRICT',
    label: 'BPS Suisse',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isBpsJob,
    noJobsMessage: 'No BPS Suisse jobs found after crawl.',
    maxToleratedMissingDescriptions: 5,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  console.log('🏦 Running dedicated BPS Suisse jobs crawler...');
  console.log(`   Portal: ${BPS_HOST}`);
  console.log('');

  const detailUrls = await fetchBpsJobUrls();
  if (detailUrls.length === 0) {
    console.log('ℹ️ No BPS Suisse job URLs discovered. Exiting OK.');
    return;
  }

  ensureAdapterSeedUrls(detailUrls);

  let _beforeSnapshot = new Map();
  if (fs.existsSync(DATA_JOBS)) {
    try {
      const pre = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
      _beforeSnapshot = snapshotJobSlugs(Array.isArray(pre) ? pre.filter(isBpsJob) : []);
    } catch {}
  }

  await runBaseCrawler();

  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isBpsJob,
  });

  const stats = logStats(_beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No BPS Suisse jobs found after crawl. Exiting OK.');
    return;
  }

  validateLocaleCoverage();

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS)
    ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'))
    : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isBpsJob) : [];
  writeJobsCrawlerSlice(BPS_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: BPS_KEY,
    label: 'BPS Suisse',
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
  console.error(`❌ BPS Suisse crawler failed: ${err?.message || err}`);
  process.exit(1);
});
