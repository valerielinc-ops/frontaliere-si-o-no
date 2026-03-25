#!/usr/bin/env node
/**
 * Dedicated Denner crawler runner.
 *
 * Denner is a subsidiary of Migros Group. Their jobs are listed on the
 * Migros Group portal at jobs.migros.ch under the Denner SA company filter.
 *
 * Denner has numerous stores across Ticino, making their positions
 * highly relevant for Italian cross-border workers.
 *
 * This script:
 *   1. Fetches the Migros Group portal page filtered for Denner
 *   2. Extracts job detail URLs
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

const DENNER_KEY = 'denner';
const DENNER_COMPANY_NAME = 'Denner';
const DENNER_HOST = 'jobs.migros.ch';
const DENNER_LISTING_URL = 'https://jobs.migros.ch/it/le-nostre-imprese/denner-sa';

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Matchers ──────────────────────────────────────────────── */
function isDennerJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === DENNER_KEY ||
    key.includes('denner') ||
    company.includes('denner') ||
    (host === DENNER_HOST && url.includes('denner')) ||
    url.includes('denner.ch')
  );
}

/* ── Discovery ─────────────────────────────────────────────── */
async function fetchDennerJobUrls() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;
  console.log(`🔍 Fetching Denner listing page: ${DENNER_LISTING_URL}`);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(DENNER_LISTING_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': UA,
      },
      redirect: 'follow',
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`⚠️ Denner listing page returned ${res.status}`);
      return [];
    }

    const html = await res.text();

    // Extract job detail URLs from the Migros portal
    const urls = new Set();
    const linkPattern = /href="(\/(?:it|de|fr)\/(?:offerte-di-lavoro|stellenangebote|offres-emploi)\/[^"]+)"/gi;
    let match;
    while ((match = linkPattern.exec(html)) !== null) {
      urls.add(`https://${DENNER_HOST}${match[1]}`);
    }

    console.log(`✅ Discovered ${urls.size} Denner job detail URLs`);
    return [...urls];
  } catch (err) {
    console.warn(`⚠️ Failed to fetch Denner listing page: ${err.message}`);
    return [];
  }
}

/* ── Adapter ───────────────────────────────────────────────── */
function ensureAdapterSeedUrls(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${DENNER_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${DENNER_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: DENNER_KEY,
      companyName: DENNER_COMPANY_NAME,
      companyHost: DENNER_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['jsonld', 'html', 'generic_ats'],
      seedUrls: seedUrls.length > 0 ? seedUrls : [DENNER_LISTING_URL],
      notes: 'Denner (Migros Group subsidiary) careers via jobs.migros.ch. Nuxt.js SSR with GraphQL/Typesense.',
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
    adapter.seedUrls = seedUrls.length > 0 ? seedUrls : adapter.seedUrls || [DENNER_LISTING_URL];
    adapter.updatedAt = new Date().toISOString();
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    console.log(`📝 Adapter ${DENNER_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

/* ── Base Crawler ──────────────────────────────────────────── */
function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: DENNER_KEY,
    localizeOnlyCompanyKeys: DENNER_KEY,
    forceLocalizeKeys: DENNER_KEY,
    disableWorkdayForce: true,
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
  const jobs = allJobs.filter(isDennerJob);

  console.log(`\n📊 === Denner Job Stats ===`);
  console.log(`  🏪 Total Denner jobs: ${jobs.length}`);
  console.log('');

  const afterSnapshot = snapshotJobSlugs(jobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Denner');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Denner');

  return { total: jobs.length };
}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_DENNER_STRICT',
    label: 'Denner',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isDennerJob,
    noJobsMessage: 'No Denner jobs found after crawl.',
    maxToleratedMissingDescriptions: 5,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  console.log('🏪 Running dedicated Denner jobs crawler...');
  console.log(`   Portal: ${DENNER_HOST} (Migros Group portal)`);
  console.log('');

  const detailUrls = await fetchDennerJobUrls();
  ensureAdapterSeedUrls(detailUrls);

  let _beforeSnapshot = new Map();
  if (fs.existsSync(DATA_JOBS)) {
    try {
      const pre = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
      _beforeSnapshot = snapshotJobSlugs(Array.isArray(pre) ? pre.filter(isDennerJob) : []);
    } catch {}
  }

  await runBaseCrawler();

  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isDennerJob,
  });

  const stats = logStats(_beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No Denner jobs found after crawl. Exiting OK.');
    return;
  }

  validateLocaleCoverage();

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS)
    ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'))
    : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isDennerJob) : [];
  writeJobsCrawlerSlice(DENNER_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: DENNER_KEY,
    label: 'Denner',
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
  console.error(`❌ Denner crawler failed: ${err?.message || err}`);
  process.exit(1);
});
