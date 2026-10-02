#!/usr/bin/env node
/**
 * Dedicated Linnea SA crawler runner.
 *
 * Linnea SA is a pharmaceutical company (botanical ingredients, APIs)
 * headquartered in Riazzino, Ticino, Switzerland (near Locarno).
 *
 * The Linnea careers page at https://www.linnea.ch/careers/ is a WordPress site
 * using Foundation's accordion component. Jobs are listed under an
 * "OPEN POSITIONS" heading with each position as an accordion item.
 *
 * There are NO individual job detail page URLs. All job titles and full
 * descriptions are embedded inline in accordion items on a single page.
 *
 * Discovery flow:
 *   1. Fetch https://www.linnea.ch/careers/ (server-side rendered HTML)
 *   2. Locate the "OPEN POSITIONS" section
 *   3. Parse each accordion item: title from <h4>, description from <article>
 *   4. Build job objects (description = the accordion article, verbatim);
 *      an explicit "No open positions at this time" page retires stored jobs
 *   5. Merge into data/jobs.json (add new, update existing, prune stale)
 *   6. Run the base crawler for AI localization of descriptions (4 locales)
 *   7. Post-process: fix company name, location, canton
 *   8. Validate locale coverage across IT/EN/DE/FR
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeJobsCrawlerSliceVerified,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { validateJobUrls } from './lib/validate-job-url.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergePreserveLocaleData, detectLang,
} from './lib/dedicated-crawler-common.mjs';
import { dropStaleLocaleDescriptions, sourceSlotTitleAndSlug } from './lib/source-locale-slots.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import {
  classifyLinneaCareersPage,
  normalizeSpace,
  slugify,
  detectCategory,
  detectExperienceLevel,
} from './lib/linnea-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { archiveRemovedJobsToSlice } from './lib/expired-jobs-archive.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { meetsSourceBodyFloor } from './lib/source-body-floor.mjs';
import { keepStoredSourceBodies } from './lib/stored-source-body.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';
import { rewritePreparedStoredJobs } from './lib/stored-jobs-soft-exit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const LINNEA_KEY = 'linnea';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(LINNEA_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const HQ = getCompanyDefaults('linnea');
const LINNEA_COMPANY_NAME = 'Linnea SA';
const LINNEA_COMPANY_HOST = 'www.linnea.ch';
const LINNEA_CAREERS_URL = 'https://www.linnea.ch/careers/';
const LOCALES = ['it', 'en', 'de', 'fr'];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function isLinneaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();

  return (
    key === LINNEA_KEY ||
    key === 'linnea-sa' ||
    key.startsWith('linnea') ||
    (company.includes('linnea') && company.includes('sa')) ||
    url.includes('linnea.ch')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'www.linnea.ch' || host === 'linnea.ch';
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// HTML fetching
// ─────────────────────────────────────────────────────────────

async function fetchPage(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en,it-CH;q=0.9',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse all Linnea jobs from the careers page.
 */
async function fetchLinneaJobs() {
  console.log(`🔍 Fetching Linnea SA jobs from ${LINNEA_CAREERS_URL}`);

  const html = await fetchPage(LINNEA_CAREERS_URL, 25000);
  if (!html) {
    console.error('❌ Failed to fetch Linnea careers page.');
    return { state: 'unknown', jobs: [] };
  }

  console.log(`  📄 Page fetched (${html.length} chars)`);

  // Parse accordion jobs. `empty` is the page's own "No open positions at this
  // time" statement; `unknown` (template drift, unparseable items) keeps the
  // stored rows exactly as before.
  const { state, jobs: parsedJobs } = classifyLinneaCareersPage(html);
  console.log(`  📋 Accordion items found: ${parsedJobs.length} (page state: ${state})`);

  if (parsedJobs.length === 0) {
    console.log('  ℹ️ No active job listings found on Linnea careers page.');
    return { state, jobs: [] };
  }

  // Build job objects
  const jobs = [];
  for (const parsed of parsedJobs) {
    const slug = slugify(parsed.title, 'linnea');
    // Use query param for stable canonical URL (hash fragments get stripped by shared crawler)
    const canonicalUrl = `${LINNEA_CAREERS_URL}?position=${parsed.idx}`;

    // The accordion article IS the vacancy text: publish it as-is in its own
    // language. The former EN company blurb appended here and the IT wrapper
    // ("Posizione aperta presso Linnea SA…" around untranslated English) were
    // text the source never published; the base crawler translates the other
    // locales from this source slot.
    // Only an article over the shared word floor is published; a shorter or
    // empty one emits no body (the merge keeps the stored source body, or
    // omits the job this run).
    const description = meetsSourceBodyFloor(parsed.descriptionText) ? parsed.descriptionText : '';
    const sourceLang = detectLang(description || parsed.title, 'en');

    const employmentType = /full\s*time/i.test(parsed.contractType) ? 'FULL_TIME'
      : /part\s*time/i.test(parsed.contractType) ? 'PART_TIME'
      : 'FULL_TIME';

    const job = {
      url: canonicalUrl,
      applyUrl: LINNEA_CAREERS_URL,
      title: parsed.title,
      company: LINNEA_COMPANY_NAME,
      companyKey: LINNEA_KEY,
      location: parsed.location || 'Riazzino',
      canton: HQ.canton,
      country: 'CH',
      description,
      descriptionByLocale: {
        [sourceLang]: description,
      },
      // Title and slug in the body's source slot, not a fixed `en`/`it`.
      ...sourceSlotTitleAndSlug(parsed.title, slug, sourceLang),
      slug,
      category: detectCategory(parsed.title),
      datePosted: new Date().toISOString().split('T')[0],
      source: 'linnea-careers-crawler',
      employmentType,
      experienceLevel: detectExperienceLevel(parsed.title),
      sector: 'Farmaceutica / Ingredienti botanici',
      sourceLang,
      _targetScope: { canton: HQ.canton, location: 'Riazzino' },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total unique Linnea jobs discovered: ${jobs.length}`);
  return { state, jobs };
}

// ─────────────────────────────────────────────────────────────
// Merge into data/jobs.json
// ─────────────────────────────────────────────────────────────

function filterEmpty(obj = {}) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && String(v).trim()) out[k] = v;
  }
  return out;
}

// Text the former builders wrote themselves: the English company paragraph
// appended to every article and the Italian wrapper around it.
const LINNEA_FABRICATED_RE = /Linnea SA is a leading pharmaceutical company specializing in botanical ingredients|Posizione aperta presso Linnea SA a Riazzino/;

async function mergeLinneaJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(LINNEA_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonLinneaJobs = allJobs.filter((j) => !isLinneaJob(j));
  // The former builders' own text (EN company paragraph, IT wrapper) goes
  // before the merge, so a stored body kept below is always source text.
  const existingLinneaJobs = dropFabricatedDescriptions(allJobs.filter(isLinneaJob), LINNEA_FABRICATED_RE, LINNEA_COMPANY_NAME);
  // Under the shared word floor the builder emits no body: keep the stored
  // source body (fossils already dropped above), or omit the job this run.
  const withBody = keepStoredSourceBodies(discoveredJobs, existingLinneaJobs, (url) => extractStableJobId(url) || url);
  if (withBody.length < discoveredJobs.length) {
    console.log(`  ⏭️ ${discoveredJobs.length - withBody.length} job(s) without a source body over the word floor: not published this run`);
  }
  discoveredJobs = withBody;

  const existingKeys = new Set(
    existingLinneaJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean)
  );
  const discoveredKeys = new Set(
    discoveredJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean)
  );
  const added = [...discoveredKeys].filter((k) => !existingKeys.has(k)).length;
  const updated = [...discoveredKeys].filter((k) => existingKeys.has(k)).length;
  const removed = [...existingKeys].filter((k) => !discoveredKeys.has(k)).length;

  // mergePreserveLocaleData matches on the stable trailing job id extracted
  // from the URL (falls back to the normalized full URL when no stable
  // token is found), so a vendor title/slug rewrite no longer orphans the
  // job's previousSlugs/previousSlugsByLocale/firstSeenAt history the way
  // the previous exact-URL-keyed merge did (issue #3699).
  const merged = mergePreserveLocaleData(existingLinneaJobs, discoveredJobs).map((job) => ({
    ...job,
    company: LINNEA_COMPANY_NAME,
    companyKey: LINNEA_KEY,
    canton: HQ.canton,
    country: 'CH',
    source: 'linnea-careers-crawler',
  }));
  // Non-source slots the merge kept that are not in their own language go
  // back to the translation pipeline.
  for (const job of merged) dropStaleLocaleDescriptions(job);

  const final = [...nonLinneaJobs, ...merged];

  writeJsonAtomic(DATA_JOBS, final);
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  writeJsonAtomic(PUBLIC_JOBS, final);

  console.log(`\n📦 Merge results:`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);
  console.log(`  🗑️  Removed (stale): ${removed}`);
  console.log(`  📊 Total jobs in file: ${final.length}`);

  return { added, updated, removed, total: final.length };
}

// ─────────────────────────────────────────────────────────────
// Adapter management
// ─────────────────────────────────────────────────────────────

function updateAdapterConfig() {
  const adapterPath = path.join(ADAPTERS_DIR, `${LINNEA_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = LINNEA_KEY;
  adapter.companyName = LINNEA_COMPANY_NAME;
  adapter.companyHost = LINNEA_COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['html'];
  adapter.seedUrls = [LINNEA_CAREERS_URL];
  adapter.notes = 'WordPress + Foundation accordion at linnea.ch/careers/ — job listings extracted directly from inline accordion items, no individual detail pages.';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${LINNEA_KEY} updated.`);
}

// ─────────────────────────────────────────────────────────────
// Base crawler (AI localization only)
// ─────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: LINNEA_KEY,
    localizeOnlyCompanyKeys: LINNEA_KEY,
    forceLocalizeKeys: LINNEA_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '100000',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '100000',
    },
  });
}

// ─────────────────────────────────────────────────────────────
// Post-processing
// ─────────────────────────────────────────────────────────────

function postProcessLinneaJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isLinneaJob(job)) continue;

    if (job.company !== LINNEA_COMPANY_NAME) {
      job.company = LINNEA_COMPANY_NAME;
      fixed++;
    }
    if (job.companyKey !== LINNEA_KEY) {
      job.companyKey = LINNEA_KEY;
      fixed++;
    }
    job.canton = HQ.canton;
    job.country = 'CH';
    if (!job.location) {
      job.location = 'Riazzino';
      fixed++;
    }
  }

  if (fixed > 0) {
    writeJsonAtomic(DATA_JOBS, jobs);
    writeJsonAtomic(PUBLIC_JOBS, jobs);
    console.log(`🔧 Post-processed ${fixed} Linnea jobs (fixed company/location/canton).`);
  }
}

// ─────────────────────────────────────────────────────────────
// Stats & validation
// ─────────────────────────────────────────────────────────────

function logStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json not found — no stats available.');
    return { total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const linneaJobs = allJobs.filter(isLinneaJob);

  console.log(`\n📊 === Linnea SA Job Stats ===`);
  console.log(`  🏢 Total Linnea jobs: ${linneaJobs.length}`);

  if (linneaJobs.length > 0) {
    console.log(`  📋 Jobs:`);
    for (const job of linneaJobs) {
      console.log(`     - ${job.title} (${job.location || 'Riazzino'})`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(linneaJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Linnea SA');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Linnea SA');
  return { total: linneaJobs.length, crawlDiff };

}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_LINNEA_STRICT',
    label: 'Linnea SA',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isLinneaJob,
    locales: LOCALES,
    isTrustedDomain: isTrustedDomain,
    untrustedDomainReason: 'url_not_linnea_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Linnea SA jobs found — the company may not have active openings.',
  });
}

async function rewriteStoredJobsWithoutThinSource(storedJobs) {
  return rewritePreparedStoredJobs({
    prepare: (jobs) => jobs,
    storedJobs,
    companyKey: LINNEA_KEY,
    companyLabel: LINNEA_COMPANY_NAME,
    write: (jobs, options) => writeJobsCrawlerSliceVerified(LINNEA_KEY, jobs, {
      isTargetJob: isLinneaJob,
      ...options,
    }),
    assemble: () => assembleJobsDataset(),
  });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(LINNEA_KEY, 'Linnea SA');
  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  console.log('═══════════════════════════════════════════════');
  console.log('  Linnea SA — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${LINNEA_CAREERS_URL}\n`);

  // Snapshot before
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(LINNEA_KEY, DATA_JOBS).filter(isLinneaJob))

  // Phase 1: Fetch and parse jobs
  const { state: pageState, jobs: discoveredJobs } = await fetchLinneaJobs();

  if (pageState === 'empty') {
    // The source says nothing is open: retire every stored row (archived to the
    // expired slice so indexed URLs land on the soft-expired page) and persist
    // the zero, as the TPL Lugano runner does for its authoritative empty marker.
    const priorJobs = readExistingCrawlerJobs(LINNEA_KEY, DATA_JOBS).filter(isLinneaJob);
    const retiredDiff = computeCrawlDiff(beforeSnapshot, new Map());
    const archived = archiveRemovedJobsToSlice(priorJobs, LINNEA_KEY);
    writeJobsCrawlerSlice(LINNEA_KEY, [], { skipShrinkGuard: true, preserveExistingSlugs: true });
    writeSummaryCrawlerSlice({
      key: LINNEA_KEY,
      label: 'Linnea SA',
      generatedAt: new Date().toISOString(),
      total: 0,
      discovered: 0,
      written: 0,
      authoritativeEmptySnapshot: true,
      newCount: 0,
      updatedCount: 0,
      removedCount: retiredDiff.removedJobs.length,
      unchangedCount: 0,
      newJobs: [],
      updatedJobs: [],
      removedJobs: retiredDiff.removedJobs.slice(0, 30),
      unchangedJobs: [],
      durationMs: getCrawlerElapsedMs(),
    });
    printCrawlChangeSummary(retiredDiff, 'Linnea SA');
    writeCrawlChangeSummaryToGH(retiredDiff, 'Linnea SA');
    await assembleJobsDataset();
    console.log(`ℹ️ Linnea careers page states "No open positions": retired ${priorJobs.length} stored job(s), archived ${archived}.`);
    return;
  }

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No Linnea jobs discovered.');
    console.log('   The careers page may have changed structure or have no current openings.');
    console.log('   Keeping valid existing jobs and quarantining thin-source rows.');
    await rewriteStoredJobsWithoutThinSource(
      readExistingCrawlerJobs(LINNEA_KEY, DATA_JOBS).filter(isLinneaJob),
    );
    const _cdResult = logStats(beforeSnapshot);
    crawlDiff = _cdResult.crawlDiff || crawlDiff;
    return;
  }

  // Phase 2: Update adapter config
  updateAdapterConfig();

  // Phase 3: Merge into data/jobs.json
  await mergeLinneaJobs(discoveredJobs);

  // Phase 4: Run base crawler for AI localization (DE/FR translations)
  console.log('\n🌐 Running base crawler for AI localization of Linnea jobs...');
  await runBaseCrawler();

  // Phase 5: Post-process
  postProcessLinneaJobs();

  // Phase 6: Log stats
  const stats = logStats(beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No Linnea jobs found after crawl. No error — exiting OK.');
    return;
  }

  // Phase 7: Validate locale coverage
  validateLocales();

  console.log('\n✅ Linnea SA crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isLinneaJob) : [];
  writeJobsCrawlerSlice(LINNEA_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: LINNEA_KEY,
    label: 'Linnea SA',
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

main().catch((err) => exitCrawlerOnError(err, 'Linnea SA'));
