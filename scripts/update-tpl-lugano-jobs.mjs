#!/usr/bin/env node
/**
 * Dedicated TPL (Trasporti Pubblici Luganesi) crawler runner.
 *
 * TPL is the public transport operator for the Lugano area in Ticino.
 * Their careers page at tplsa.ch/2/50/tpl-lavora-con-noi.html lists
 * positions when available.
 *
 * This script:
 *   1. Fetches the careers page
 *   2. Extracts job URLs (if any are listed)
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
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  normalize,
  normalizeKey,
  detectLang,
} from './lib/dedicated-crawler-common.mjs';
import { parseTplListingPage, inferEmploymentType } from './lib/tpl-lugano-job-parser.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const TPL_KEY = 'tpl-lugano';
const TPL_COMPANY_NAME = 'TPL - Trasporti Pubblici Luganesi';
const TPL_HOST = 'www.tplsa.ch';
const TPL_LISTING_URL = 'https://www.tplsa.ch/2/50/tpl-lavora-con-noi.html';

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Matchers ──────────────────────────────────────────────── */
function isTplJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === TPL_KEY ||
    key.includes('tpl-lugano') ||
    key.includes('trasporti-pubblici-luganesi') ||
    company.includes('tpl') ||
    company.includes('trasporti pubblici luganesi') ||
    host === TPL_HOST ||
    host.endsWith('tplsa.ch')
  );
}

/* ── Discovery ─────────────────────────────────────────────── */
async function fetchTplJobUrls() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  console.log(`🔍 Fetching TPL careers page: ${TPL_LISTING_URL}`);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(TPL_LISTING_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': UA,
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`⚠️ TPL careers page returned ${res.status}`);
      return [];
    }

    const html = await res.text();
    const jobs = parseTplListingPage(html);

    console.log(`✅ Discovered ${jobs.length} TPL job URLs`);
    return jobs.map((j) => j.url);
  } catch (err) {
    console.warn(`⚠️ Failed to fetch TPL careers page: ${err.message}`);
    return [];
  }
}

/* ── Adapter ───────────────────────────────────────────────── */
function ensureAdapterSeedUrls(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${TPL_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${TPL_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: TPL_KEY,
      companyName: TPL_COMPANY_NAME,
      companyHost: TPL_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['html', 'generic_ats'],
      seedUrls,
      notes: 'TPL Lugano public transport careers page. Positions listed when available.',
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
    console.log(`📝 Adapter ${TPL_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

/* ── Base Crawler ──────────────────────────────────────────── */
function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: TPL_KEY,
    localizeOnlyCompanyKeys: TPL_KEY,
    forceLocalizeKeys: TPL_KEY,
    disableWorkdayForce: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '20',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '20',
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
  const jobs = allJobs.filter(isTplJob);

  console.log(`\n📊 === TPL Lugano Job Stats ===`);
  console.log(`  🚌 Total TPL jobs: ${jobs.length}`);
  console.log('');

  const afterSnapshot = snapshotJobSlugs(jobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'TPL Lugano');
  writeCrawlChangeSummaryToGH(crawlDiff, 'TPL Lugano');

  return { total: jobs.length, crawlDiff };

}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_TPL_LUGANO_STRICT',
    label: 'TPL Lugano',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isTplJob,
    detectSourceLang: (text) => detectLang(text, 'it'),
    noJobsMessage: 'No TPL Lugano jobs found after crawl.',
    maxToleratedMissingDescriptions: 5,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(TPL_KEY, 'TPL Lugano');
  console.log('🚌 Running dedicated TPL Lugano jobs crawler...');
  console.log(`   Portal: ${TPL_HOST}`);
  console.log('');

  const detailUrls = await fetchTplJobUrls();
  if (detailUrls.length === 0) {
    console.log('ℹ️ No TPL job URLs discovered (may have no open positions). Exiting OK.');
    return;
  }

  ensureAdapterSeedUrls(detailUrls);

    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(TPL_KEY, DATA_JOBS).filter(isTplJob))

  await runBaseCrawler();

  // Patch address fields on TPL jobs
  if (fs.existsSync(DATA_JOBS)) {
    try {
      const allJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
      let patched = 0;
      for (const j of allJobs) {
        if (!isTplJob(j)) continue;
        if (!j.addressLocality) j.addressLocality = 'Lugano';
        if (!j.addressRegion) j.addressRegion = 'TI';
        if (!j.addressCountry) j.addressCountry = 'CH';
        if (!j.postalCode) j.postalCode = '6900';
        if (!j.streetAddress) j.streetAddress = 'Via Campagna 15';
        if (!j.employmentType) j.employmentType = inferEmploymentType(j.title || '', j.description || '');
        if (!j.sourceLang) j.sourceLang = detectLang(j.description || j.title, 'it');
        patched++;
      }
      if (patched > 0) {
        fs.writeFileSync(DATA_JOBS, JSON.stringify(allJobs, null, 2) + '\n');
        console.log(`📍 Patched address fields on ${patched} TPL jobs.`);
      }
    } catch (err) { console.warn(`⚠️ Failed to patch TPL address fields: ${err.message}`); }
  }

  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isTplJob,
  });

  const stats = logStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ No TPL jobs found after crawl. Exiting OK.');
    return;
  }

  validateLocaleCoverage();

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTplJob) : [];
  writeJobsCrawlerSlice(TPL_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: TPL_KEY,
    label: 'TPL Lugano',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: crawlDiff.newJobs.length,
    updatedCount: crawlDiff.updatedJobs.length,
    removedCount: crawlDiff.removedJobs.length,
    unchangedCount: crawlDiff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: crawlDiff.newJobs.slice(0, 30),
    updatedJobs: crawlDiff.updatedJobs.slice(0, 30),
    removedJobs: crawlDiff.removedJobs.slice(0, 30),
    unchangedJobs: (crawlDiff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

main().catch((err) => {
  console.error(`❌ TPL Lugano crawler failed: ${err?.message || err}`);
  process.exit(1);
});
