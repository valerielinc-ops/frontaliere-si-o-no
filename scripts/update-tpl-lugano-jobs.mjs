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
  normalize,
  normalizeKey,
  detectLang,
} from './lib/dedicated-crawler-common.mjs';
import {
  parseTplListingState,
  parseTplDetailPage,
  inferEmploymentType,
} from './lib/tpl-lugano-job-parser.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { archiveRemovedJobsToSlice } from './lib/expired-jobs-archive.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const TPL_KEY = 'tpl-lugano';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(TPL_KEY);
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
async function fetchTplHtml(url, label, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': UA,
      },
    });
    if (!res.ok) throw new Error(`${label} returned HTTP ${res.status}`);

    // Direct-detail adapter seeds must never follow a CMS redirect to another
    // host. `redirect: error` blocks that network hop; this check also guards
    // custom/test fetch implementations that do not implement redirect mode.
    if (res.url) {
      const effectiveUrl = new URL(res.url);
      if (effectiveUrl.protocol !== 'https:' || effectiveUrl.hostname.toLowerCase() !== TPL_HOST) {
        throw new Error(`${label} resolved outside ${TPL_HOST}`);
      }
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and validate one coherent TPL source snapshot. Network errors,
 * unrecognised empty listings, and stale/thin detail pages all throw so the
 * last persisted slice is preserved. Only TPL's explicit empty-state copy is
 * accepted as an authoritative zero.
 *
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 * @returns {Promise<{state: 'jobs'|'empty', jobs: Array<{url:string,title:string,body:string,location:string}>}>}
 */
export async function fetchTplSourceSnapshot(options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  const fetchImpl = options.fetchImpl || fetch;
  console.log(`🔍 Fetching TPL careers page: ${TPL_LISTING_URL}`);
  const listingHtml = await fetchTplHtml(TPL_LISTING_URL, 'TPL careers listing', {
    fetchImpl,
    timeoutMs,
  });
  const listing = parseTplListingState(listingHtml);
  if (listing.state === 'invalid') {
    throw new Error('TPL careers listing contained neither vacancy rows nor the authoritative empty marker.');
  }
  if (listing.state === 'empty') {
    console.log('✅ TPL source explicitly reports 0 open positions.');
    return { state: 'empty', jobs: [] };
  }

  const jobs = [];
  for (const listedJob of listing.jobs) {
    const detailHtml = await fetchTplHtml(listedJob.url, `TPL detail ${listedJob.url}`, {
      fetchImpl,
      timeoutMs,
    });
    const detail = parseTplDetailPage(detailHtml, listedJob.title);
    if (!detail) {
      throw new Error(`TPL detail failed the authoritative content gate: ${listedJob.url}`);
    }
    jobs.push({ ...listedJob, ...detail });
  }

  console.log(`✅ Validated ${jobs.length}/${listing.jobs.length} TPL detail pages`);
  return { state: 'jobs', jobs };
}

/* ── Adapter ───────────────────────────────────────────────── */
export function buildTplAdapterSeedFields(sourceJobs = []) {
  const seedDetailUrls = sourceJobs.map((job) => job.url);
  return {
    // Keep the historical field for adapter compatibility, but explicitly
    // declare the exact same URLs as details so the shared crawler bypasses
    // its intentionally generic detail-URL classifier.
    seedUrls: seedDetailUrls,
    seedDetailUrls,
    seedMetaByUrl: Object.fromEntries(seedDetailUrls.map((url) => [
      url,
      { location: 'Lugano', canton: 'TI', company: TPL_COMPANY_NAME },
    ])),
  };
}

function ensureAdapterSeedUrls(sourceJobs) {
  const adapterPath = path.join(ADAPTERS_DIR, `${TPL_KEY}.json`);
  const seedFields = buildTplAdapterSeedFields(sourceJobs);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${TPL_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: TPL_KEY,
      companyName: TPL_COMPANY_NAME,
      companyHost: TPL_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['html', 'generic_ats'],
      ...seedFields,
      notes: 'TPL Lugano public transport careers page. Positions listed when available.',
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
    Object.assign(adapter, seedFields);
    adapter.updatedAt = new Date().toISOString();
    writeJsonAtomic(adapterPath, adapter);
    console.log(`📝 Adapter ${TPL_KEY} updated with ${seedFields.seedDetailUrls.length} direct detail seeds.`);
  } catch (err) {
    throw new Error(`Could not update TPL adapter: ${err.message}`, { cause: err });
  }
}

function canonicalTplDetailUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

/**
 * Replace generic HTML fallback content with the source-owned TPL block while
 * retaining the shared crawler's stable id/slug/history. Any missing or
 * duplicate expected URL is a hard parity failure; retained stale rows are
 * removed because the listing snapshot is the authoritative active set.
 */
export function applyTplAuthoritativeDetails(allJobs, sourceJobs) {
  const expected = new Map(sourceJobs.map((job) => [canonicalTplDetailUrl(job.url), job]));
  const matched = new Set();
  const jobs = [];
  let removed = 0;

  for (const job of Array.isArray(allJobs) ? allJobs : []) {
    if (!isTplJob(job)) {
      jobs.push(job);
      continue;
    }
    const key = canonicalTplDetailUrl(job.url);
    const source = expected.get(key);
    if (!source) {
      removed++;
      continue;
    }
    if (matched.has(key)) throw new Error(`TPL base crawler emitted duplicate URL: ${key}`);
    matched.add(key);
    jobs.push({
      ...job,
      title: source.title,
      description: source.body,
      location: source.location,
      sourceLang: 'it',
      titleByLocale: { ...(job.titleByLocale || {}), it: source.title },
      descriptionByLocale: { ...(job.descriptionByLocale || {}), it: source.body },
    });
  }

  const missing = [...expected.keys()].filter((key) => !matched.has(key));
  if (missing.length > 0) {
    throw new Error(`TPL base crawler lost ${missing.length} validated detail URL(s): ${missing.join(', ')}`);
  }
  return { jobs, matched: matched.size, removed };
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
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '100000',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '100000',
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
  const sourceCounts = { discovered: null };
  registerCrawlerSummaryGuard(TPL_KEY, 'TPL Lugano', sourceCounts);
  console.log('🚌 Running dedicated TPL Lugano jobs crawler...');
  console.log(`   Portal: ${TPL_HOST}`);
  console.log('');

  const sourceSnapshot = await fetchTplSourceSnapshot();
  sourceCounts.discovered = sourceSnapshot.jobs.length;
  ensureAdapterSeedUrls(sourceSnapshot.jobs);

  const priorJobs = readExistingCrawlerJobs(TPL_KEY, DATA_JOBS).filter(isTplJob);
  const _beforeSnapshot = snapshotJobSlugs(priorJobs);

  if (sourceSnapshot.state === 'empty') {
    const crawlDiff = computeCrawlDiff(_beforeSnapshot, new Map());
    const archived = archiveRemovedJobsToSlice(priorJobs, TPL_KEY);
    writeJobsCrawlerSlice(TPL_KEY, [], { skipShrinkGuard: true, preserveExistingSlugs: true });
    writeSummaryCrawlerSlice({
      key: TPL_KEY,
      label: 'TPL Lugano',
      generatedAt: new Date().toISOString(),
      total: 0,
      discovered: 0,
      written: 0,
      sourceProvenEmpty: true,
      newCount: 0,
      updatedCount: 0,
      removedCount: crawlDiff.removedJobs.length,
      unchangedCount: 0,
      newJobs: [],
      updatedJobs: [],
      removedJobs: crawlDiff.removedJobs.slice(0, 30),
      unchangedJobs: [],
      durationMs: getCrawlerElapsedMs(),
    });
    await assembleJobsDataset();
    console.log(`ℹ️ Persisted authoritative TPL zero; archived ${archived} expired route(s).`);
    return;
  }

  await runBaseCrawler();

  // Replace generic fallback content with the validated, source-owned detail
  // block. The shared engine remains responsible for identity and slug history.
  if (fs.existsSync(DATA_JOBS)) {
    try {
      const rawJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
      const authoritative = applyTplAuthoritativeDetails(rawJobs, sourceSnapshot.jobs);
      const allJobs = authoritative.jobs;
      let patched = 0;
      for (const j of allJobs) {
        if (!isTplJob(j)) continue;
        if (!j.addressLocality) j.addressLocality = 'Lugano';
        if (!j.addressRegion) j.addressRegion = 'TI';
        // Deliberately does NOT default addressCountry to 'CH' here (#5403/#5384)
        // — an undeclared country and a declared-Swiss one are different pieces
        // of evidence; overwriting the former destroys that distinction at rest.
        // Consumers already fall back to 'CH' at read time.
        if (!j.postalCode) j.postalCode = '6900';
        if (!j.streetAddress) j.streetAddress = 'Via Campagna 15';
        if (!j.employmentType) j.employmentType = inferEmploymentType(j.title || '', j.description || '');
        if (!j.sourceLang) j.sourceLang = detectLang(j.description || j.title, 'it');
        patched++;
      }
      if (patched > 0) {
        writeJsonAtomic(DATA_JOBS, allJobs);
        console.log(
          `📍 Applied ${authoritative.matched}/${sourceSnapshot.jobs.length} authoritative TPL details` +
          `; removed ${authoritative.removed} stale row(s); patched ${patched} address records.`,
        );
      }
    } catch (err) {
      throw new Error(`Failed TPL authoritative detail/parity gate: ${err.message}`, { cause: err });
    }
  } else {
    throw new Error('TPL base crawler produced no scratch dataset.');
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
  if (_sliceJobs.length !== sourceSnapshot.jobs.length) {
    throw new Error(`TPL source/slice parity failed: source=${sourceSnapshot.jobs.length}, slice=${_sliceJobs.length}.`);
  }
  const removedPriorJobs = priorJobs.filter((job) => (
    !sourceSnapshot.jobs.some((source) => canonicalTplDetailUrl(source.url) === canonicalTplDetailUrl(job.url))
  ));
  archiveRemovedJobsToSlice(removedPriorJobs, TPL_KEY);
  writeJobsCrawlerSlice(TPL_KEY, _sliceJobs, { skipShrinkGuard: true, preserveExistingSlugs: true });
  writeSummaryCrawlerSlice({
    key: TPL_KEY,
    label: 'TPL Lugano',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    discovered: sourceSnapshot.jobs.length,
    written: _sliceJobs.length,
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => exitCrawlerOnError(err, 'TPL Lugano'));
}
