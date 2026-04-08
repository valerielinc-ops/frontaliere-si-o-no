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
  parseRaiffeisenDetailPage,
  MIN_DESC_LENGTH,
} from './lib/raiffeisen-vc-job-parser.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
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
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

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

/* ── Detail page fetching ──────────────────────────────────── */
/**
 * Fetch a single Raiffeisen detail page and return its parsed body.
 * Returns null on fetch failure or parse failure.
 *
 * @param {string} url
 * @returns {Promise<import('./lib/raiffeisen-vc-job-parser.mjs').ReturnType<typeof parseRaiffeisenDetailPage> | null>}
 */
async function fetchDetailBody(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/html', 'User-Agent': UA },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`   ⚠️ HTTP ${res.status} for ${url}`);
      return null;
    }
    const html = await res.text();
    const parsed = parseRaiffeisenDetailPage(html);
    for (const w of parsed.warnings) {
      console.warn(`   ⚠️  ${url}: ${w}`);
    }
    return parsed;
  } catch (err) {
    console.warn(`   ⚠️ Fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch each detail page and update the matching job's description if the
 * freshly-parsed body is more complete than what's already stored.
 *
 * A "more complete" description is one that is longer than the stored version
 * by more than 10% — this avoids spurious rewrites while still catching the
 * case where the base crawler stored only a short summary.
 *
 * @param {string[]} urls - detail page URLs
 * @returns {Promise<Map<string, {descriptionText: string, title: string, workload: string}>>}
 *   Map from canonical URL to extracted body data.
 */
async function enrichJobsWithDetailBody(urls) {
  const results = new Map();
  console.log(`\n📖 Fetching ${urls.length} detail page(s) for full body extraction…`);

  for (const url of urls) {
    const parsed = await fetchDetailBody(url);
    if (!parsed || !parsed.valid) {
      console.warn(`   ⚠️  ${url}: detail body extraction failed or too short — skipped`);
      continue;
    }
    results.set(url, parsed);
    console.log(
      `   ✅ ${url.replace(/.*\//, '')} — ` +
      `"${parsed.title}" ${parsed.workload} · ${parsed.descriptionText.length} chars`
    );
  }

  return results;
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

  return { total: jobs.length, crawlDiff };

}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_RAIFFEISEN_VC_STRICT',
    label: 'Raiffeisen VC',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isRaiffeisenVCJob,
    detectSourceLang: (text) => detectLang(text, 'it'),
    noJobsMessage: 'No Raiffeisen Vedeggio Cassarate jobs found after crawl.',
    maxToleratedMissingDescriptions: 5,
  });
}

/* ── Description patching ──────────────────────────────────── */
function ensureSourceLang() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(jobs)) return;
  let changed = 0;
  for (const job of jobs) {
    if (!isRaiffeisenVCJob(job)) continue;
    const lang = detectLang(job.description || job.title, 'it');
    if (job.sourceLang !== lang) { job.sourceLang = lang; changed++; }
  }
  if (changed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(`📝 Set sourceLang on ${changed} Raiffeisen VC job(s).`);
  }
}

/**
 * For each detail URL in `detailBodies`, find the matching job in jobs.json
 * by URL and update its description if the freshly-parsed body is longer than
 * the currently stored description by more than 10%.
 *
 * Uses URL substring matching (UUID) to handle canonical URL variations.
 *
 * @param {Map<string, {descriptionText: string, title: string, workload: string}>} detailBodies
 */
function patchDescriptionsFromDetailBodies(detailBodies) {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];

  let patched = 0;
  for (const [url, body] of detailBodies) {
    // Match by UUID in the URL (last path segment before query)
    const uuid = url.split('/').pop()?.split('?')[0] || '';
    const job = jobs.find(j => j.url && j.url.includes(uuid));
    if (!job) continue;

    const currentLen = (job.description || '').length;
    const newLen = body.descriptionText.length;

    // Only update if the new body is meaningfully longer (> 10% gain)
    if (newLen > currentLen * 1.1 || currentLen < MIN_DESC_LENGTH) {
      job.description = body.descriptionText;
      job.sourceLang = detectLang(body.descriptionText || job.title, 'it');
      // Update English locale description too
      if (job.descriptionByLocale?.en) {
        job.descriptionByLocale.en = body.descriptionText;
      }
      console.log(
        `  🔄 Patched "${job.title}" (${job.url}): ` +
        `${currentLen} → ${newLen} chars`
      );
      patched++;
    }
  }

  if (patched > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(`\n✅ Patched ${patched} job description(s) with full vacancy body.`);
  } else {
    console.log('\nℹ️  All stored descriptions are already up-to-date (no patch needed).');
  }
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(RAIFF_KEY, 'Raiffeisen VC');
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

  // Step 2b: Fetch detail pages and extract full vacancy bodies
  const detailBodies = await enrichJobsWithDetailBody(detailUrls);

  // Snapshot before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(RAIFF_KEY, DATA_JOBS).filter(isRaiffeisenVCJob))

  // Step 3: Run the base crawler
  await runBaseCrawler();
  ensureSourceLang();

  // Step 3b: Patch stored descriptions with fully-extracted bodies where longer
  if (detailBodies.size > 0 && fs.existsSync(DATA_JOBS)) {
    patchDescriptionsFromDetailBodies(detailBodies);
  }

  // Step 4: Translate missing locales
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isRaiffeisenVCJob,
  });

  // Step 5: Stats + validation
  const stats = logStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ No Raiffeisen VC jobs found after crawl. Exiting OK.');
    return;
  }

  validateLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isRaiffeisenVCJob) : [];
  writeJobsCrawlerSlice(RAIFF_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: RAIFF_KEY,
    label: 'Raiffeisen VC',
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
  console.error(`❌ Raiffeisen VC crawler failed: ${err?.message || err}`);
  process.exit(1);
});
