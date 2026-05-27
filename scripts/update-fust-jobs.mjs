#!/usr/bin/env node
/**
 * Dedicated Fust crawler runner.
 *
 * Fust is a subsidiary of the Coop Group and uses the same
 * Prospective.ch JobBooster platform (Career Center 1000103).
 *
 * This script:
 *   1. Fetches the Prospective.ch JSON API for TI + GR job listings.
 *   2. Filters for jobs where the company attribute (70) is "Fust".
 *   3. Sets those detail page URLs as adapter seed URLs.
 *   4. Runs the base crawler to fetch JSON-LD JobPosting data from each page.
 *   5. Re-tags discovered jobs with companyKey "fust".
 *   6. Translates missing locales and validates coverage.
 *
 * Fust has stores throughout Switzerland including Ticino (Bellinzona,
 * Lugano, etc.) and specialises in household electronics, kitchens, and
 * bathroom installations.
 *
 * Detail pages live at jobs.fust.ch and contain JSON-LD JobPosting.
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

const FUST_KEY = 'fust';
const FUST_COMPANY_NAME = 'Fust';

/**
 * Prospective.ch API — same medium as Coop (1000103).
 * Canton filter IDs: TI = 1024522, GR = 1024512.
 */
const API_BASE = 'https://ohws.prospective.ch/public/v1/medium/1000103';
const CANTON_IDS = { TI: '1024522', GR: '1024512' };
const API_LIMIT = 500;

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Matchers ──────────────────────────────────────────────── */
function isFustJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  return (
    key === FUST_KEY ||
    key.includes('fust') ||
    company.includes('fust')
  );
}

function normalizeCantonCode(raw = '', fallback = '') {
  const lower = String(raw || '').trim().toLowerCase();
  if (['ti', 'ticino', 'tessin'].includes(lower)) return 'TI';
  if (['gr', 'grigioni', 'graubunden', 'graubünden', 'grisons'].includes(lower)) return 'GR';
  return fallback || '';
}

function cantonLabel(canton = '') {
  return canton === 'GR' ? 'Grigioni' : 'Ticino';
}

function dateOnly(raw = '') {
  const dt = new Date(raw || Date.now());
  if (Number.isNaN(dt.getTime())) return new Date().toISOString().slice(0, 10);
  return dt.toISOString().slice(0, 10);
}

function buildSeedMetaFromApiJob(job, fallbackCanton) {
  const attr30 = String(job?.attributes?.['30']?.[0] || '').trim();
  const canton = normalizeCantonCode(attr30, fallbackCanton);
  const location = attr30 || cantonLabel(canton || fallbackCanton);
  const company = String(job?.attributes?.['70']?.[0] || job?.company || '').trim();
  const contract = String(job?.attributes?.['40']?.[0] || '').trim();
  return {
    location,
    canton: canton || fallbackCanton,
    ...(company ? { company } : {}),
    ...(contract ? { contract } : {}),
    ...(job?.date || job?.datePosted
      ? { postedDate: dateOnly(job?.date || job?.datePosted) }
      : {}),
  };
}

/* ── API Discovery ─────────────────────────────────────────── */
async function fetchFustJobUrls() {
  const allUrls = new Set();
  const seedMetaByUrl = {};
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;

  for (const [canton, cantonId] of Object.entries(CANTON_IDS)) {
    const params = new URLSearchParams({
      lang: 'it',
      offset: '0',
      limit: String(API_LIMIT),
    });
    params.append('f', `30:${cantonId}`);

    const apiUrl = `${API_BASE}/jobs?${params}`;
    console.log(`🔍 Fetching Coop Group jobs for ${canton} from Prospective API…`);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(apiUrl, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': UA },
      });
      clearTimeout(timer);

      if (!res.ok) {
        console.warn(`⚠️ API returned ${res.status} for ${canton} — skipping.`);
        continue;
      }

      const data = await res.json();
      const jobs = data?.jobs || [];
      console.log(`  📦 ${canton}: ${jobs.length} total Coop Group jobs`);

      let fustCount = 0;
      for (const job of jobs) {
        const company = normalize(job?.attributes?.['70']?.[0] || job?.company || '');
        if (!company.includes('fust')) continue;

        const directLink = String(job?.links?.directlink || '').trim();
        if (directLink && directLink.startsWith('http')) {
          allUrls.add(directLink);
          if (!seedMetaByUrl[directLink]) {
            seedMetaByUrl[directLink] = buildSeedMetaFromApiJob(job, canton);
          }
          fustCount++;
        }
      }
      console.log(`  🏪 ${canton}: ${fustCount} Fust jobs found`);
    } catch (err) {
      console.warn(`⚠️ API fetch failed for ${canton}: ${err.message}`);
    }
  }

  console.log(`\n✅ Total unique Fust detail URLs discovered: ${allUrls.size}\n`);
  return { urls: [...allUrls], seedMetaByUrl };
}

/* ── Adapter ───────────────────────────────────────────────── */
function ensureAdapterSeedUrls(seedUrls, seedMetaByUrl = {}) {
  const adapterPath = path.join(ADAPTERS_DIR, `${FUST_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${FUST_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: FUST_KEY,
      companyName: FUST_COMPANY_NAME,
      companyHost: 'fust.ch',
      enabled: true,
      priority: 10,
      crawlerModes: ['generic_ats', 'html', 'jsonld'],
      seedUrls,
      seedMetaByUrl,
      notes: 'Fust (Coop Group) — Prospective.ch JobBooster (Career Center 1000103). Detail pages on jobs.fust.ch with JSON-LD JobPosting.',
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
    console.log(`📝 Adapter ${FUST_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

/* ── Re-tag existing Fust jobs ─────────────────────────────── */
function retagFustJobs() {
  if (!fs.existsSync(DATA_JOBS)) return 0;

  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(raw)) return 0;

  let retagged = 0;
  for (const job of raw) {
    const company = normalize(job?.company || '');
    if (company.includes('fust') && job.companyKey !== FUST_KEY) {
      job.companyKey = FUST_KEY;
      retagged++;
    }
    if (isFustJob(job) && !job.sourceLang) {
      job.sourceLang = detectLang((job.description || job.title || ''), 'de');
    }
  }

  if (retagged > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(raw, null, 2) + '\n');
    const publicPath = path.resolve(ROOT, 'public', 'data', 'jobs.json');
    if (fs.existsSync(publicPath)) {
      fs.writeFileSync(publicPath, JSON.stringify(raw, null, 2) + '\n');
    }
    console.log(`🔄 Re-tagged ${retagged} existing Fust jobs from coop-ticino → ${FUST_KEY}`);
  }
  return retagged;
}

/* ── Base Crawler ──────────────────────────────────────────── */
function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: FUST_KEY,
    localizeOnlyCompanyKeys: FUST_KEY,
    forceLocalizeKeys: FUST_KEY,
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
  const jobs = allJobs.filter(isFustJob);
  const tiJobs = jobs.filter((j) => normalize(j?.canton) === 'ti');
  const grJobs = jobs.filter((j) => normalize(j?.canton) === 'gr');

  console.log(`\n📊 === Fust Job Stats ===`);
  console.log(`  🏪 Total Fust jobs: ${jobs.length}`);
  console.log(`  ✅ Ticino: ${tiJobs.length}`);
  console.log(`  ✅ Grigioni: ${grJobs.length}`);
  console.log('');

  const afterSnapshot = snapshotJobSlugs(jobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Fust');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Fust');

  return { total: jobs.length, crawlDiff };

}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_FUST_STRICT',
    label: 'Fust',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isFustJob,
    noJobsMessage: 'No Fust jobs found after crawl.',
    maxToleratedMissingDescriptions: 5,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(FUST_KEY, 'Fust');
  console.log('🏪 Running dedicated Fust jobs crawler...');
  console.log('   Platform: Prospective.ch JobBooster (Career Center 1000103, Coop Group)');
  console.log('   Cantons: TI (Ticino) + GR (Grigioni)');
  console.log('');

  // Step 0: Re-tag existing Fust jobs that may have coop-ticino key
  retagFustJobs();

  // Step 1: Discover Fust job URLs from the Prospective.ch API
  const discovery = await fetchFustJobUrls();
  const detailUrls = discovery.urls;
  if (detailUrls.length === 0) {
    console.log('ℹ️ No Fust detail URLs found from API. Exiting OK.');
    return;
  }

  // Step 2: Update the adapter with discovered seed URLs
  ensureAdapterSeedUrls(detailUrls, discovery.seedMetaByUrl);

  // Snapshot before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(FUST_KEY, DATA_JOBS).filter(isFustJob))

  // Step 3: Run the base crawler (fetches JSON-LD from detail pages)
  await runBaseCrawler();

  // Step 4: Re-tag any newly crawled Fust jobs
  retagFustJobs();

  // Step 5: Translate missing locales
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isFustJob,
  });

  // Step 6: Stats + validation
  const stats = logStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ No Fust jobs found after crawl. Exiting OK.');
    return;
  }

  validateLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isFustJob) : [];
  writeJobsCrawlerSlice(FUST_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: FUST_KEY,
    label: 'Fust',
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
  console.error(`❌ Fust crawler failed: ${err?.message || err}`);
  process.exit(1);
});
