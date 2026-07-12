#!/usr/bin/env node
/**
 * Dedicated Fust crawler runner.
 *
 * Fust is a national household-electronics retailer (subsidiary of the Coop
 * Group) with stores throughout all of Switzerland, so this crawler collects
 * Fust jobs CH-wide across all 26 cantons (Cathedral). It uses the same
 * Prospective.ch JobBooster platform as Coop (Career Center 1000103).
 *
 * This script:
 *   1. Fetches the Prospective.ch JSON API UNFILTERED (no canton facet),
 *      paginating through the full national result set.
 *   2. Filters for jobs where the company attribute (70) is "Fust"
 *      (the medium is a Coop-group feed; keep only the Fust subsidiary).
 *   3. Drops any Fust job whose canton label doesn't resolve to a Swiss
 *      canton (CH-only gate — foreign/unresolved postings are dropped, never
 *      defaulted to TI).
 *   4. Sets those detail page URLs as adapter seed URLs.
 *   5. Runs the base crawler to fetch JSON-LD JobPosting data from each page.
 *   6. Re-tags discovered jobs with companyKey "fust".
 *   7. Translates missing locales and validates coverage.
 *
 * Per-job canton is inferred from the canton label the API returns in
 * attribute 30 (e.g. "Zurigo", "Vallese", "San Gallo", "Ticino") via the
 * shared CH-wide inferAnyCanton helper.
 *
 * Detail pages live at jobs.fust.ch and contain JSON-LD JobPosting.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
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
import { assertJsonListShape } from './lib/assert-json-list-shape.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const FUST_KEY = 'fust';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(FUST_KEY);
const FUST_COMPANY_NAME = 'Fust';

/**
 * Prospective.ch API — same medium as Coop (1000103).
 *
 * CH-wide fetch: we issue an UNFILTERED query (no `f=30:{cantonId}` canton
 * facet), which the API answers with every Coop-group job across all 26
 * cantons. We then keep only the Fust subsidiary (attribute 70 = "Fust") and
 * paginate via offset/limit until the full national result set is drained.
 *
 *   https://ohws.prospective.ch/public/v1/medium/1000103/jobs?lang=it&offset=0&limit=500
 *
 * Per-job canton comes from attribute 30 (a localized canton label such as
 * "Zurigo", "Vallese", "San Gallo", "Ticino"), resolved CH-wide by
 * inferAnyCanton.
 */
const API_BASE = 'https://ohws.prospective.ch/public/v1/medium/1000103';
const API_LIMIT = 500; // max jobs per request
const API_MAX_PAGES = 20; // hard ceiling: 20 * 500 = 10000 jobs (safety stop)

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

/**
 * Resolve a Prospective.ch attribute-30 canton label (e.g. "Zurigo",
 * "Vallese", "San Gallo", "Ticino") to a 2-letter Swiss canton code, CH-wide.
 * Returns '' (never a TI default) when the label doesn't resolve to a Swiss
 * canton — the caller uses that to drop foreign/unresolved postings.
 */
function normalizeCantonCode(raw = '', fallback = '') {
  const label = String(raw || '').trim();
  if (!label) return fallback || '';
  return inferAnyCanton(label) || fallback || '';
}

function cantonLabel(canton = '') {
  return canton || '';
}

function dateOnly(raw = '') {
  const dt = new Date(raw || Date.now());
  if (Number.isNaN(dt.getTime())) return new Date().toISOString().slice(0, 10);
  return dt.toISOString().slice(0, 10);
}

function buildSeedMetaFromApiJob(job, fallbackCanton = '') {
  const attr30 = String(job?.attributes?.['30']?.[0] || '').trim();
  // Canton inferred from the clean attribute-30 label ALONE (never a combined
  // "city + region" string, which would mislead inferAnyCanton).
  const canton = normalizeCantonCode(attr30, fallbackCanton);
  const apiCity = String(job?.location || job?.place || job?.city || job?.address?.city || '').trim();
  const location = apiCity || attr30 || cantonLabel(canton || fallbackCanton);
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
/**
 * Fetch Fust job detail URLs from the Prospective.ch JSON API CH-wide.
 *
 * Uses a single UNFILTERED query (no canton facet) paginated over the full
 * national result set. Keeps only the Fust subsidiary (company attribute 70 =
 * "Fust"), and drops any Fust posting whose canton label doesn't resolve to a
 * Swiss canton (CH-only gate — never defaulted to TI).
 */
async function fetchFustJobUrls() {
  const allUrls = new Set();
  const seedMetaByUrl = {};
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;

  /** Canton distribution for logging (2-letter code → count). */
  const cantonCounts = {};
  let apiTotal = null;
  let fetched = 0;
  let fustFound = 0;
  let droppedNonCh = 0;

  for (let page = 0; page < API_MAX_PAGES; page += 1) {
    const offset = page * API_LIMIT;
    const params = new URLSearchParams({
      lang: 'it',
      offset: String(offset),
      limit: String(API_LIMIT),
    });
    const apiUrl = `${API_BASE}/jobs?${params}`;
    console.log(`🔍 Fetching Coop Group feed CH-wide page ${page + 1} (offset ${offset})…`);

    let jobs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(apiUrl, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': UA },
      });
      if (!res.ok) {
        console.warn(`⚠️ API returned ${res.status} at offset ${offset} — stopping pagination.`);
        break;
      }

      const data = await res.json();
      jobs = assertJsonListShape(data, { key: 'jobs', source: 'fust', lang: `offset:${offset}` });
      if (apiTotal === null && typeof data?.total === 'number') apiTotal = data.total;
    } catch (err) {
      console.warn(`⚠️ API fetch failed at offset ${offset}: ${err.message}`);
      break;
    } finally {
      clearTimeout(timer);
    }

    if (jobs.length === 0) break;
    fetched += jobs.length;

    for (const job of jobs) {
      const company = normalize(job?.attributes?.['70']?.[0] || job?.company || '');
      if (!company.includes('fust')) continue; // keep only the Fust subsidiary
      fustFound++;

      const directLink = String(job?.links?.directlink || '').trim();
      if (!directLink || !directLink.startsWith('http') || allUrls.has(directLink)) continue;

      const meta = buildSeedMetaFromApiJob(job);
      // CH-only gate: drop foreign/unresolved postings whose label doesn't
      // resolve to a Swiss canton (never defaulted to TI).
      if (!meta.canton) { droppedNonCh += 1; continue; }

      allUrls.add(directLink);
      seedMetaByUrl[directLink] = meta;
      cantonCounts[meta.canton] = (cantonCounts[meta.canton] || 0) + 1;
    }

    console.log(`  📦 page ${page + 1}: ${jobs.length} jobs (cumulative ${fetched}${apiTotal !== null ? `/${apiTotal}` : ''})`);

    // Drained the full result set.
    if (apiTotal !== null && offset + jobs.length >= apiTotal) break;
    if (jobs.length < API_LIMIT) break;
  }

  // Surface the safety-ceiling so a silent stop ≠ a fully drained feed.
  if (apiTotal !== null && fetched < apiTotal) {
    console.warn(`  ⚠️ Pagination stopped at ${fetched}/${apiTotal} jobs (API_MAX_PAGES=${API_MAX_PAGES} ceiling) — raise the ceiling if the Coop-group listing has grown.`);
  }

  console.log(`\n📋 Fust API Discovery Summary (CH-wide):`);
  console.log(`  API total: ${apiTotal ?? '?'} · Fust matched: ${fustFound} · dropped non-CH/unresolved: ${droppedNonCh} · unique detail URLs: ${allUrls.size}`);
  const sortedCantons = Object.entries(cantonCounts).sort((a, b) => b[1] - a[1]);
  console.log(`  Cantons seen (${sortedCantons.length}): ${sortedCantons.map(([c, n]) => `${c}=${n}`).join(', ')}`);
  console.log(`✅ Total unique Fust detail URLs discovered: ${allUrls.size}\n`);
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
    writeJsonAtomic(DATA_JOBS, raw);
    const publicPath = path.resolve(ROOT, 'public', 'data', 'jobs.json');
    if (fs.existsSync(publicPath)) {
      writeJsonAtomic(publicPath, raw);
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
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '100000',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '100000',
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

  // CH-wide canton distribution (2-letter code → count).
  const byCanton = {};
  for (const job of jobs) {
    const code = String(job?.canton || '').toUpperCase() || '??';
    byCanton[code] = (byCanton[code] || 0) + 1;
  }
  const sortedCantons = Object.entries(byCanton).sort((a, b) => b[1] - a[1]);

  console.log(`\n📊 === Fust Job Stats (CH-wide) ===`);
  console.log(`  🏪 Total Fust jobs: ${jobs.length}`);
  console.log(`  🇨🇭 Cantons covered (${sortedCantons.length}): ${sortedCantons.map(([c, n]) => `${c}=${n}`).join(', ')}`);
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
  console.log('   Scope: CH-wide (all 26 cantons, unfiltered national query; Fust subsidiary only)');
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

main().catch((err) => exitCrawlerOnError(err, 'Fust'));
