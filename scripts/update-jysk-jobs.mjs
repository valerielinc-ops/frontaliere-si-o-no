#!/usr/bin/env node
/**
 * Dedicated JYSK crawler runner.
 *
 * JYSK is a Danish retail chain with stores across Switzerland.
 * Their Swiss-German jobs portal is a Drupal CMS site at jobs.de.jysk.ch.
 *
 * This script:
 *   1. Scrapes the listing page at /offene-stellen to discover all job detail URLs.
 *   2. Writes discovered URLs as seed URLs in the adapter config.
 *   3. Runs the shared base crawler which fetches each detail page and
 *      parses JSON-LD JobPosting structured data.
 *   4. The shared infrastructure filters for Ticino/GR locations automatically.
 *   5. Translates missing locales and validates coverage.
 *
 * JYSK has stores in Sant'Antonino (TI) and Samedan/St. Moritz (GR) area.
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

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const JYSK_KEY = 'jysk';
const JYSK_COMPANY_NAME = 'JYSK';
const JYSK_HOST = 'jobs.de.jysk.ch';
const JYSK_LISTING_URL = 'https://jobs.de.jysk.ch/offene-stellen';

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Matchers ──────────────────────────────────────────────── */
function isJyskJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === JYSK_KEY ||
    key.includes('jysk') ||
    company.includes('jysk') ||
    host === JYSK_HOST ||
    host.endsWith('.jysk.ch')
  );
}

/* ── Discovery ─────────────────────────────────────────────── */
/**
 * Scrape the JYSK open positions listing page to discover all job detail URLs.
 * The listing page is server-rendered HTML (Drupal CMS) with links like:
 *   /offene-stellen/{slug}
 */
async function fetchJyskJobUrls() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  console.log(`🔍 Fetching JYSK listing page: ${JYSK_LISTING_URL}`);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(JYSK_LISTING_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': UA,
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`⚠️ JYSK listing page returned ${res.status}`);
      return [];
    }

    const html = await res.text();

    // Extract all /offene-stellen/{slug} links (excluding the listing page itself)
    const urlPattern = /href="(\/offene-stellen\/[^"]+)"/g;
    const urls = new Set();
    let match;
    while ((match = urlPattern.exec(html)) !== null) {
      const slug = match[1];
      // Skip if it's just the listing page or a non-job link
      if (slug === '/offene-stellen' || slug === '/offene-stellen/') continue;
      urls.add(`https://${JYSK_HOST}${slug}`);
    }

    console.log(`✅ Discovered ${urls.size} JYSK job detail URLs`);
    return [...urls];
  } catch (err) {
    console.warn(`⚠️ Failed to fetch JYSK listing page: ${err.message}`);
    return [];
  }
}

/* ── Adapter ───────────────────────────────────────────────── */
function ensureAdapterSeedUrls(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${JYSK_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${JYSK_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: JYSK_KEY,
      companyName: JYSK_COMPANY_NAME,
      companyHost: JYSK_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['jsonld', 'html', 'generic_ats'],
      seedUrls,
      notes: 'JYSK Swiss-German careers portal (Drupal CMS). Detail pages have JSON-LD JobPosting. Seed URLs auto-discovered from /offene-stellen listing page.',
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
    console.log(`📝 Adapter ${JYSK_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

/* ── Base Crawler ──────────────────────────────────────────── */
function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: JYSK_KEY,
    localizeOnlyCompanyKeys: JYSK_KEY,
    forceLocalizeKeys: JYSK_KEY,
    disableWorkdayForce: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '60',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '60',
      JOBS_CRAWLER_FETCH_RETRIES: process.env.JOBS_CRAWLER_FETCH_RETRIES || '2',
      JOBS_CRAWLER_CONCURRENCY: process.env.JOBS_CRAWLER_CONCURRENCY || '4',
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
  const jobs = allJobs.filter(isJyskJob);
  const tiJobs = jobs.filter((j) => normalize(j?.canton) === 'ti');
  const grJobs = jobs.filter((j) => normalize(j?.canton) === 'gr');

  console.log(`\n📊 === JYSK Job Stats ===`);
  console.log(`  🛋️ Total JYSK jobs: ${jobs.length}`);
  console.log(`  ✅ Ticino: ${tiJobs.length}`);
  console.log(`  ✅ Grigioni: ${grJobs.length}`);
  console.log('');

  const afterSnapshot = snapshotJobSlugs(jobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'JYSK');
  writeCrawlChangeSummaryToGH(crawlDiff, 'JYSK');

  return { total: jobs.length, crawlDiff };

}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_JYSK_STRICT',
    label: 'JYSK',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isJyskJob,
    noJobsMessage: 'No JYSK jobs found after crawl.',
    maxToleratedMissingDescriptions: 5,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(JYSK_KEY, 'JYSK');
  console.log('🛋️ Running dedicated JYSK jobs crawler...');
  console.log(`   Portal: ${JYSK_HOST} (Drupal CMS)`);
  console.log('');

  // Step 1: Discover job detail URLs from the listing page
  const detailUrls = await fetchJyskJobUrls();
  if (detailUrls.length === 0) {
    console.log('ℹ️ No JYSK job URLs discovered. Exiting OK.');
    return;
  }

  // Step 2: Update the adapter with discovered seed URLs
  ensureAdapterSeedUrls(detailUrls);

  // Snapshot before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(JYSK_KEY, DATA_JOBS).filter(isJyskJob))

  // Step 3: Run the base crawler (fetches JSON-LD from detail pages)
  await runBaseCrawler();

  // Step 3b: Stamp sourceLang on JYSK jobs
  if (fs.existsSync(DATA_JOBS)) {
    const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
    if (Array.isArray(raw)) {
      for (const job of raw) {
        if (isJyskJob(job) && !job.sourceLang) {
          job.sourceLang = detectLang((job.description || job.title || ''), 'de');
        }
      }
      fs.writeFileSync(DATA_JOBS, JSON.stringify(raw, null, 2) + '\n');
    }
  }

  // Step 4: Translate missing locales
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isJyskJob,
  });

  // Step 5: Stats + validation
  const stats = logStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ No JYSK jobs found after crawl. Exiting OK.');
    return;
  }

  validateLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isJyskJob) : [];
  writeJobsCrawlerSlice(JYSK_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: JYSK_KEY,
    label: 'JYSK',
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
  console.error(`❌ JYSK crawler failed: ${err?.message || err}`);
  process.exit(1);
});
