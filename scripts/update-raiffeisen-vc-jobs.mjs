#!/usr/bin/env node
/**
 * Dedicated Banca Raiffeisen Vedeggio Cassarate crawler runner.
 *
 * The bank's careers page is at:
 *   https://www.raiffeisen.ch/vedeggio-cassarate/it/chi-siamo/carriera/lavorare-banca-raiffeisen.html
 *
 * Job detail pages are hosted on Prospective.ch career center:
 *   https://jobs.raiffeisen.ch/posti-vacanti/{slug}/{uuid}
 *
 * Each job detail page contains JSON-LD JobPosting structured data with
 * hiringOrganization = "Banca Raiffeisen Vedeggio Cassarate".
 *
 * This crawler:
 *   1. Scrapes the local bank's careers page for jobs.raiffeisen.ch links.
 *   2. Writes discovered URLs as seed URLs in the adapter.
 *   3. Runs the shared base crawler (which parses JSON-LD from detail pages).
 *   4. Translates and validates locale coverage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
} from './jobs-url-helper.mjs';
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

const RAIFF_KEY = 'banca-raiffeisen-vedeggio-cassarate';
const RAIFF_COMPANY_NAME = 'Banca Raiffeisen Vedeggio Cassarate';
const RAIFF_HOST = 'www.raiffeisen.ch';
const RAIFF_JOBS_HOST = 'jobs.raiffeisen.ch';

const CAREERS_URLS = [
  'https://www.raiffeisen.ch/vedeggio-cassarate/it/chi-siamo/carriera/lavorare-banca-raiffeisen.html',
  'https://www.raiffeisen.ch/vedeggio-cassarate/de/ueber-uns/karriere/arbeiten-bei-raiffeisenbank.html',
];

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://www.frontaliereticino.ch/)';

/* ── Matchers ──────────────────────────────────────────────── */
function isRaiffeisenVCJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === RAIFF_KEY ||
    key === 'raiffeisen-vedeggio-cassarate' ||
    (company.includes('raiffeisen') && company.includes('vedeggio')) ||
    (company.includes('raiffeisen') && company.includes('cassarate')) ||
    (host === RAIFF_JOBS_HOST && url.includes('vedeggio'))
  );
}

/* ── Discovery ─────────────────────────────────────────────── */
/**
 * Scrape the Raiffeisen Vedeggio Cassarate careers pages for
 * jobs.raiffeisen.ch links (Prospective career center).
 */
async function fetchJobUrls() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  const urls = new Set();

  for (const pageUrl of CAREERS_URLS) {
    console.log(`🔍 Fetching: ${pageUrl}`);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(pageUrl, {
        signal: controller.signal,
        headers: { Accept: 'text/html', 'User-Agent': UA },
        redirect: 'follow',
      });
      clearTimeout(timer);

      if (!res.ok) {
        console.warn(`   ⚠️ HTTP ${res.status}`);
        continue;
      }

      const html = await res.text();

      // Extract all jobs.raiffeisen.ch links (Prospective career center)
      const hrefPattern = /href="(https?:\/\/jobs\.raiffeisen\.ch\/[^"]+)"/g;
      let match;
      while ((match = hrefPattern.exec(html)) !== null) {
        const href = match[1];
        // Only include detail pages (posti-vacanti / offene-stellen / postes-vacants)
        // Skip the main portal link (/?lang=...)
        if (href.includes('/posti-vacanti/') ||
            href.includes('/offene-stellen/') ||
            href.includes('/postes-vacants/') ||
            href.includes('/open-positions/')) {
          urls.add(href);
        }
      }
    } catch (err) {
      console.warn(`   ⚠️ Failed: ${err.message}`);
    }
  }

  console.log(`✅ Discovered ${urls.size} Raiffeisen VC job detail URLs`);
  return [...urls];
}

/* ── Adapter ───────────────────────────────────────────────── */
function ensureAdapterSeedUrls(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${RAIFF_KEY}.json`);

  // Build seedMetaByUrl so the base crawler knows these are TI jobs
  // (avoids false-positive rejection from Italian-language descriptions
  // containing substrings that match foreign location markers).
  const seedMetaByUrl = {};
  for (const u of seedUrls) {
    seedMetaByUrl[u] = { canton: 'TI', location: 'Gravesano' };
  }

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${RAIFF_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: RAIFF_KEY,
      companyName: RAIFF_COMPANY_NAME,
      companyHost: RAIFF_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['jsonld', 'html', 'generic_ats'],
      seedUrls,
      seedMetaByUrl,
      notes: 'Banca Raiffeisen Vedeggio Cassarate — local cooperative bank in TI. Jobs on Prospective career center (jobs.raiffeisen.ch). Seed URLs auto-discovered from careers page.',
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
    adapter.seedUrls = seedUrls;
    adapter.seedMetaByUrl = seedMetaByUrl;
    adapter.updatedAt = new Date().toISOString();
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    console.log(`📝 Adapter ${RAIFF_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

/* ── Base Crawler ──────────────────────────────────────────── */
function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: RAIFF_KEY,
    localizeOnlyCompanyKeys: RAIFF_KEY,
    forceLocalizeKeys: RAIFF_KEY,
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
  const jobs = allJobs.filter(isRaiffeisenVCJob);
  const tiJobs = jobs.filter((j) => normalize(j?.canton) === 'ti');
  const grJobs = jobs.filter((j) => normalize(j?.canton) === 'gr');

  console.log(`\n📊 === Raiffeisen Vedeggio Cassarate Job Stats ===`);
  console.log(`  🏦 Total jobs: ${jobs.length}`);
  console.log(`  ✅ Ticino: ${tiJobs.length}`);
  console.log(`  ✅ Grigioni: ${grJobs.length}`);
  console.log('');

  const afterSnapshot = snapshotJobSlugs(jobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Raiffeisen VC');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Raiffeisen VC');

  return { total: jobs.length };
}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_RAIFFEISEN_VC_STRICT',
    label: 'Raiffeisen VC',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isRaiffeisenVCJob,
    noJobsMessage: 'No Raiffeisen Vedeggio Cassarate jobs found after crawl.',
    maxToleratedMissingDescriptions: 5,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  console.log('🏦 Running dedicated Raiffeisen Vedeggio Cassarate jobs crawler...');
  console.log(`   Careers: ${CAREERS_URLS[0]}`);
  console.log(`   Jobs portal: ${RAIFF_JOBS_HOST}`);
  console.log('');

  // Step 1: Discover job detail URLs from careers page
  const detailUrls = await fetchJobUrls();
  if (detailUrls.length === 0) {
    console.log('ℹ️ No Raiffeisen VC job URLs discovered. Exiting OK.');
    return;
  }

  console.log(`📋 Found ${detailUrls.length} job URLs:`);
  for (const u of detailUrls) console.log(`   ${u}`);
  console.log('');

  // Step 2: Update the adapter with discovered seed URLs
  ensureAdapterSeedUrls(detailUrls);

  // Snapshot before crawl for diff summary
  let _beforeSnapshot = new Map();
  if (fs.existsSync(DATA_JOBS)) {
    try {
      const pre = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
      _beforeSnapshot = snapshotJobSlugs(Array.isArray(pre) ? pre.filter(isRaiffeisenVCJob) : []);
    } catch {}
  }

  // Step 3: Run the base crawler
  await runBaseCrawler();

  // Step 4: Translate missing locales
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isRaiffeisenVCJob,
  });

  // Step 5: Stats + validation
  const stats = logStats(_beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No Raiffeisen VC jobs found after crawl. Exiting OK.');
    return;
  }

  validateLocaleCoverage();
}

main().catch((err) => {
  console.error(`❌ Raiffeisen VC crawler failed: ${err?.message || err}`);
  process.exit(1);
});
