#!/usr/bin/env node
/**
 * Dedicated CSC Costruzioni crawler runner.
 *
 * CSC Costruzioni SA is a construction company headquartered in Lugano (TI).
 * Their careers page is at https://csc-sa.ch/lavoro-carriera-edilizia (Drupal CMS).
 *
 * This script:
 *   1. Scrapes the careers page to discover all job detail URLs.
 *   2. Writes discovered URLs as seed URLs in the adapter config.
 *   3. Runs the shared base crawler which fetches each detail page and
 *      parses JSON-LD JobPosting structured data.
 *   4. The shared infrastructure filters for Ticino/GR locations automatically.
 *   5. Translates missing locales and validates coverage.
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

const CSC_KEY = 'csc-costruzioni';
const CSC_COMPANY_NAME = 'CSC Costruzioni SA';
const CSC_HOST = 'csc-sa.ch';
const CSC_CAREERS_URL = 'https://csc-sa.ch/lavoro-carriera-edilizia';

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Matchers ──────────────────────────────────────────────── */
function isCscJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === CSC_KEY ||
    key === 'csc-costruzioni-sa' ||
    key.startsWith('csc-costruzion') ||
    company.includes('csc costruzioni') ||
    company.includes('csc-sa') ||
    host === CSC_HOST ||
    host.endsWith('.csc-sa.ch')
  );
}

/* ── Discovery ─────────────────────────────────────────────── */
/**
 * Scrape the CSC careers page to discover job detail URLs.
 * The site is a Drupal CMS. Job links are expected as hrefs under the
 * careers path or as node links on the page.
 */
async function fetchCscJobUrls() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  console.log(`🔍 Fetching CSC careers page: ${CSC_CAREERS_URL}`);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(CSC_CAREERS_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': UA,
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`⚠️ CSC careers page returned ${res.status}`);
      return [];
    }

    const html = await res.text();

    // Look for job detail links on the page.
    // Drupal sites typically use /node/N or /lavoro-carriera-edilizia/slug patterns.
    // Also check for any links under the careers section that are NOT the page itself.
    const urls = new Set();

    // Pattern 1: links under the careers path
    const careersPattern = /href="(\/lavoro-carriera-edilizia\/[^"]+)"/g;
    let match;
    while ((match = careersPattern.exec(html)) !== null) {
      urls.add(`https://${CSC_HOST}${match[1]}`);
    }

    // Pattern 2: links to node pages that might be job detail pages
    // (only if they appear within the main content area)
    const nodePattern = /href="(\/node\/\d+)"/g;
    while ((match = nodePattern.exec(html)) !== null) {
      // Skip node/24 which is the careers page itself
      if (match[1] === '/node/24') continue;
      urls.add(`https://${CSC_HOST}${match[1]}`);
    }

    // Pattern 3: links containing "offert" (offerte di lavoro)
    const offertPattern = /href="(\/[^"]*offert[^"]*)"(?![^>]*class="language-link)/g;
    while ((match = offertPattern.exec(html)) !== null) {
      const href = match[1];
      if (href === '/lavoro-carriera-edilizia') continue;
      urls.add(`https://${CSC_HOST}${href}`);
    }

    console.log(`✅ Discovered ${urls.size} CSC job detail URLs`);
    return [...urls];
  } catch (err) {
    console.warn(`⚠️ Failed to fetch CSC careers page: ${err.message}`);
    return [];
  }
}

/* ── Adapter ───────────────────────────────────────────────── */
function ensureAdapterSeedUrls(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${CSC_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${CSC_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: CSC_KEY,
      companyName: CSC_COMPANY_NAME,
      companyHost: CSC_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['jsonld', 'html', 'generic_ats'],
      seedUrls,
      notes: 'CSC Costruzioni SA — Lugano-based construction company (Drupal CMS). Seed URLs auto-discovered from /lavoro-carriera-edilizia.',
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
    console.log(`📝 Adapter ${CSC_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

/* ── Base Crawler ──────────────────────────────────────────── */
function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: CSC_KEY,
    localizeOnlyCompanyKeys: CSC_KEY,
    forceLocalizeKeys: CSC_KEY,
    disableWorkdayForce: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '30',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '30',
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
  const jobs = allJobs.filter(isCscJob);
  const tiJobs = jobs.filter((j) => normalize(j?.canton) === 'ti');
  const grJobs = jobs.filter((j) => normalize(j?.canton) === 'gr');

  console.log(`\n📊 === CSC Costruzioni Job Stats ===`);
  console.log(`  🏗️ Total CSC jobs: ${jobs.length}`);
  console.log(`  ✅ Ticino: ${tiJobs.length}`);
  console.log(`  ✅ Grigioni: ${grJobs.length}`);
  console.log('');

  const afterSnapshot = snapshotJobSlugs(jobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'CSC Costruzioni');
  writeCrawlChangeSummaryToGH(crawlDiff, 'CSC Costruzioni');

  return { total: jobs.length, crawlDiff };

}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_CSC_STRICT',
    label: 'CSC Costruzioni',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isCscJob,
    noJobsMessage: 'No CSC Costruzioni jobs found after crawl.',
    maxToleratedMissingDescriptions: 5,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(CSC_KEY, 'CSC Costruzioni');
  console.log('🏗️ Running dedicated CSC Costruzioni jobs crawler...');
  console.log(`   Portal: ${CSC_HOST} (Drupal CMS)`);
  console.log('');

  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };

  // Step 1: Discover job detail URLs from the careers page
  const detailUrls = await fetchCscJobUrls();
  if (detailUrls.length === 0) {
    console.log('ℹ️ No CSC Costruzioni job URLs discovered. Exiting OK.');
    printCrawlChangeSummary({ newJobs: crawlDiff.newJobs.slice(0, 30), updatedJobs: crawlDiff.updatedJobs.slice(0, 30), removedJobs: crawlDiff.removedJobs.slice(0, 30), unchangedCount: 0 }, 'CSC Costruzioni');
    return;
  }

  // Step 2: Update the adapter with discovered seed URLs
  ensureAdapterSeedUrls(detailUrls);

  // Snapshot before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(CSC_KEY, DATA_JOBS).filter(isCscJob))

  // Step 3: Run the base crawler (fetches JSON-LD from detail pages)
  await runBaseCrawler();

  // Step 4: Translate missing locales
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isCscJob,
  });

  // Step 5: Stats + validation
  const stats = logStats(_beforeSnapshot);
  crawlDiff = stats.crawlDiff || crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ No CSC Costruzioni jobs found after crawl. Exiting OK.');
    printCrawlChangeSummary({ newJobs: crawlDiff.newJobs.slice(0, 30), updatedJobs: crawlDiff.updatedJobs.slice(0, 30), removedJobs: crawlDiff.removedJobs.slice(0, 30), unchangedCount: 0 }, 'CSC Costruzioni');
    return;
  }

  validateLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isCscJob) : [];
  writeJobsCrawlerSlice(CSC_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: CSC_KEY,
    label: 'CSC Costruzioni',
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
  console.error(`❌ CSC Costruzioni crawler failed: ${err?.message || err}`);
  process.exit(1);
});
