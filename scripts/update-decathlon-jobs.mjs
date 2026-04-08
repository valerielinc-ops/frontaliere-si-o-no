#!/usr/bin/env node
/**
 * Dedicated Decathlon Suisse crawler runner.
 *
 * Decathlon uses Digital Recruiters as their ATS. The careers page at
 * joinus.decathlon.ch/it_CH/annonces loads jobs via JS API.
 *
 * This script:
 *   1. Fetches the Decathlon listing page (joinus.decathlon.ch)
 *   2. Extracts job detail URLs
 *   3. Updates adapter seed URLs
 *   4. Runs base crawler for detail parsing/localization
 *   5. Validates locale coverage
 *
 * Note: Decathlon has stores in Ticino — filter for TI locations.
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
  detectLang,
  normalize,
  normalizeKey,
} from './lib/dedicated-crawler-common.mjs';
import { inferEmploymentType } from './lib/decathlon-job-parser.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const DECATHLON_KEY = 'decathlon';
const DECATHLON_COMPANY_NAME = 'Decathlon Suisse';
const DECATHLON_HOST = 'joinus.decathlon.ch';
const DECATHLON_LISTING_URL = 'https://joinus.decathlon.ch/it_CH/annonces';

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Matchers ──────────────────────────────────────────────── */
function isDecathlonJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === DECATHLON_KEY ||
    key.includes('decathlon') ||
    company.includes('decathlon') ||
    host === DECATHLON_HOST ||
    host.endsWith('decathlon.ch') ||
    host.includes('digitalrecruiters.com')
  );
}

/* ── Discovery ─────────────────────────────────────────────── */
async function fetchDecathlonJobUrls() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;
  console.log(`🔍 Fetching Decathlon listing page: ${DECATHLON_LISTING_URL}`);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(DECATHLON_LISTING_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': UA,
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`⚠️ Decathlon listing page returned ${res.status}`);
      return [];
    }

    const html = await res.text();

    // Extract job URLs from rendered HTML
    const urls = new Set();
    const linkPattern = /href="((?:\/it_CH)?\/annonc(?:e|es)\/[^"]+)"/gi;
    let match;
    while ((match = linkPattern.exec(html)) !== null) {
      const relUrl = match[1];
      if (relUrl.endsWith('/annonces') || relUrl.endsWith('/annonces/')) continue;
      urls.add(
        relUrl.startsWith('http')
          ? relUrl
          : `https://${DECATHLON_HOST}${relUrl}`
      );
    }

    console.log(`✅ Discovered ${urls.size} Decathlon job detail URLs`);
    return [...urls];
  } catch (err) {
    console.warn(`⚠️ Failed to fetch Decathlon listing page: ${err.message}`);
    return [];
  }
}

/* ── Adapter ───────────────────────────────────────────────── */
function ensureAdapterSeedUrls(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${DECATHLON_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${DECATHLON_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: DECATHLON_KEY,
      companyName: DECATHLON_COMPANY_NAME,
      companyHost: DECATHLON_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['jsonld', 'html', 'generic_ats'],
      seedUrls,
      notes: 'Decathlon Suisse careers (Digital Recruiters ATS). Filter for Ticino locations.',
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
    console.log(`📝 Adapter ${DECATHLON_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

/* ── Base Crawler ──────────────────────────────────────────── */
function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: DECATHLON_KEY,
    localizeOnlyCompanyKeys: DECATHLON_KEY,
    forceLocalizeKeys: DECATHLON_KEY,
    disableWorkdayForce: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '60',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '60',
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
  const jobs = allJobs.filter(isDecathlonJob);

  console.log(`\n📊 === Decathlon Job Stats ===`);
  console.log(`  🏃 Total Decathlon jobs: ${jobs.length}`);
  console.log('');

  const afterSnapshot = snapshotJobSlugs(jobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Decathlon');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Decathlon');

  return { total: jobs.length, crawlDiff };

}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_DECATHLON_STRICT',
    label: 'Decathlon',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isDecathlonJob,
    noJobsMessage: 'No Decathlon jobs found after crawl.',
    maxToleratedMissingDescriptions: 5,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(DECATHLON_KEY, 'Decathlon');
  console.log('🏃 Running dedicated Decathlon Suisse jobs crawler...');
  console.log(`   Portal: ${DECATHLON_HOST}`);
  console.log('');

  const detailUrls = await fetchDecathlonJobUrls();
  if (detailUrls.length === 0) {
    console.log('ℹ️ No Decathlon job URLs discovered. Exiting OK.');
    return;
  }

  ensureAdapterSeedUrls(detailUrls);

    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(DECATHLON_KEY, DATA_JOBS).filter(isDecathlonJob))

  await runBaseCrawler();

  // Patch address fields on Decathlon jobs (use store locations when known, default to Lugano)
  if (fs.existsSync(DATA_JOBS)) {
    try {
      const DECATHLON_STORES = {
        'sant\'antonino': { postalCode: '6592', streetAddress: 'Centro Commerciale Serfontana' },
        'santantonino': { postalCode: '6592', streetAddress: 'Centro Commerciale Serfontana' },
        'losone': { postalCode: '6616', streetAddress: 'Via Locarno' },
        'lugano': { postalCode: '6900', streetAddress: 'Lugano' },
      };
      const allJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
      let patched = 0;
      for (const j of allJobs) {
        if (!isDecathlonJob(j)) continue;
        const loc = String(j.location || j.addressLocality || '').toLowerCase().trim();
        const store = DECATHLON_STORES[loc] || DECATHLON_STORES['sant\'antonino'];
        if (!j.addressLocality) j.addressLocality = j.location || "Sant'Antonino";
        if (!j.addressRegion) j.addressRegion = 'TI';
        if (!j.addressCountry) j.addressCountry = 'CH';
        if (!j.postalCode) j.postalCode = store.postalCode;
        if (!j.streetAddress) j.streetAddress = store.streetAddress;
        if (!j.employmentType) j.employmentType = inferEmploymentType(j.title || '', j.description || '');
        if (!j.sourceLang) j.sourceLang = detectLang(j.description || j.title, 'it');
        patched++;
      }
      if (patched > 0) {
        fs.writeFileSync(DATA_JOBS, JSON.stringify(allJobs, null, 2) + '\n');
        console.log(`📍 Patched address fields on ${patched} Decathlon jobs.`);
      }
    } catch (err) { console.warn(`⚠️ Failed to patch Decathlon address fields: ${err.message}`); }
  }

  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isDecathlonJob,
  });

  const stats = logStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ No Decathlon jobs found after crawl. Exiting OK.');
    return;
  }

  validateLocaleCoverage();

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isDecathlonJob) : [];
  writeJobsCrawlerSlice(DECATHLON_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: DECATHLON_KEY,
    label: 'Decathlon',
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
  console.error(`❌ Decathlon crawler failed: ${err?.message || err}`);
  process.exit(1);
});
