#!/usr/bin/env node
/**
 * Dedicated Giorgio Armani crawler runner.
 * Crawls the Giorgio Armani SAP SuccessFactors careers portal for
 * Switzerland-based positions.
 *
 * Architecture note: SuccessFactors (career5.successfactors.eu) switched BOTH
 * the listing AND detail pages to a client-rendered SPA. The listing tiles are
 * injected via an in-browser DWR POST (getInitialJobSearchData.dwr) that needs
 * runtime tokens — NOT replicable with curl (curl returns an empty JS shell,
 * which is why the old req-id scan started returning 0 jobs, issue #1956). The
 * crawler now renders the pages with a headless browser (Playwright) and parses
 * the resulting hydrated HTML.
 *
 * Discovery flow:
 *   1. Render the listing page with a headless browser; wait for the hydrated
 *      `tr.jobResultItem` tiles, then paginate through every page via the
 *      "Next Page" arrow, collecting { reqId, title, area, country } per job.
 *   2. Filter for Swiss jobs (country="Switzerland" or Swiss city names).
 *   3. Render each Swiss reqId's detail page and parse the hydrated
 *      `.joqReqDescription` for the full description.
 *   4. Merge into data/jobs.json (preserving existing data when 0 Swiss found).
 *   5. Run locale fill + validation.
 *
 * Giorgio Armani S.p.A. is an Italian luxury fashion house with retail
 * stores across Switzerland (Zurich, Landquart outlet, etc.), making
 * their positions relevant for Italian cross-border workers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './lib/ensure-chromium.mjs';
import {
  printPublishedJobUrls,
  writeJobsSummary,
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
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
  mergeLocaleTextMap,
  captureLostSlugs,
} from './lib/dedicated-crawler-common.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import {
  parseGiorgioArmaniListingHtml,
  listingHasRenderedJobs,
  parseGiorgioArmaniJobDetail,
  isGiorgioArmaniSwissJob,
  inferGiorgioArmaniCanton,
  inferGiorgioArmaniCategory,
  buildGiorgioArmaniLocalizedContent,
} from './lib/giorgio-armani-job-parser.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'giorgio-armani.json');

const COMPANY_KEY = 'giorgio-armani';
const COMPANY_NAME = 'Giorgio Armani S.p.A.';
const COMPANY_HOST = 'career5.successfactors.eu';
const COMPANY_DOMAIN = 'armani.com';
const CAREERS_URL = 'https://career5.successfactors.eu/career?company=3397177P&career_ns=job_listing_summary&navBarLevel=JOB_SEARCH';
const SF_COMPANY_ID = '3397177P';
const DETAIL_URL_BASE = `https://career5.successfactors.eu/career?career_ns=job_listing&company=${SF_COMPANY_ID}&navBarLevel=JOB_SEARCH&rcm_site_locale=en_US&selected_lang=it_IT&career_job_req_id=`;
const LOCALES = ['it', 'en', 'de', 'fr'];

// Headless browser configuration. Default is headless (required for CI). Set
// JOBS_GIORGIO_ARMANI_HEADLESS=0 locally to watch the browser while debugging.
const HEADLESS = process.env.JOBS_GIORGIO_ARMANI_HEADLESS !== '0';
const BROWSER_TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 60000;
const MAX_LISTING_PAGES = Number(process.env.ARMANI_MAX_LISTING_PAGES) || 25;
const DEFAULT_UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toIsoDate(value = '') {
  const parsed = new Date(String(value || '').trim());
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return key === COMPANY_KEY || company.includes('giorgio armani') || url.includes('career5.successfactors.eu/career') && url.includes(SF_COMPANY_ID);
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'career5.successfactors.eu' || host.endsWith('.armani.com');
  } catch {
    return false;
  }
}

/**
 * Run `fn(page)` inside a headless Chromium session (self-healing install).
 */
async function withBrowser(fn) {
  const browser = await launchChromium({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent: DEFAULT_UA,
    viewport: { width: 1440, height: 1200 },
    locale: 'en-US',
  });
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await context.close();
    await browser.close();
  }
}

/** Poll until the SPA injects the hydrated job tiles (or timeout). */
async function waitForListingHydration(page) {
  const started = Date.now();
  while (Date.now() - started < BROWSER_TIMEOUT_MS) {
    if (listingHasRenderedJobs(await page.content().catch(() => ''))) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

/**
 * Render the listing SPA and paginate through every page, collecting every
 * job summary across all countries. Returns { reqId, title, area, country }[].
 *
 * Pagination is driven by clicking the `a.paginationArrow[aria-label="Next Page"]`
 * control (the SF SPA re-renders the same `tr.jobResultItem` table in place).
 * We stop when the arrow disappears/disables or the first-row title stops
 * changing (terminal page), with a hard MAX_LISTING_PAGES safety cap.
 */
async function discoverAllListings(page) {
  await page.goto(CAREERS_URL, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
  const hydrated = await waitForListingHydration(page);
  if (!hydrated) throw new Error('Giorgio Armani listing did not hydrate in browser session');

  const byReqId = new Map();

  for (let pageNum = 1; pageNum <= MAX_LISTING_PAGES; pageNum += 1) {
    const html = await page.content();
    const rows = parseGiorgioArmaniListingHtml(html);
    for (const row of rows) {
      if (!byReqId.has(row.reqId)) byReqId.set(row.reqId, row);
    }
    const firstTitle = rows[0]?.title || '';
    console.log(`  📄 Listing page ${pageNum}: ${rows.length} jobs (total unique so far: ${byReqId.size})`);

    // Advance to the next page if a live "Next Page" arrow exists.
    const advanced = await page.evaluate(() => {
      const arrow = document.querySelector('a.paginationArrow[aria-label="Next Page"]');
      if (!arrow) return false;
      if (arrow.getAttribute('aria-disabled') === 'true' || arrow.classList.contains('disabled')) return false;
      arrow.click();
      return true;
    }).catch(() => false);

    if (!advanced) break;

    // Wait for the table to re-render with a new first-row title (terminal
    // page guard: if it never changes, stop to avoid spinning on the cap).
    const startedWait = Date.now();
    let changed = false;
    while (Date.now() - startedWait < BROWSER_TIMEOUT_MS) {
      await page.waitForTimeout(800);
      const nextFirst = parseGiorgioArmaniListingHtml(await page.content())[0]?.title || '';
      if (nextFirst && nextFirst !== firstTitle) { changed = true; break; }
    }
    if (!changed) break;
  }

  return [...byReqId.values()];
}

/** Render one detail page and return its hydrated HTML (or null on failure). */
async function fetchDetailHtml(page, reqId) {
  try {
    await page.goto(buildJobUrl(reqId), { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
    const started = Date.now();
    while (Date.now() - started < BROWSER_TIMEOUT_MS) {
      const html = await page.content();
      if (/joqReqDescription/i.test(html)) return html;
      await page.waitForTimeout(800);
    }
    return await page.content();
  } catch (err) {
    console.warn(`  ⚠️  Failed to render detail for reqId ${reqId}: ${err.message}`);
    return null;
  }
}

/**
 * Discover Swiss Giorgio Armani jobs via a headless browser.
 * Returns an array of { reqId, title, area, country, html } for Swiss jobs.
 *
 * Returns null on a transient browser/site failure so the caller preserves the
 * existing dataset rather than wiping it.
 */
async function discoverSwissJobs() {
  console.log('🔍 Rendering SuccessFactors listing with headless browser...');
  try {
    return await withBrowser(async (page) => {
      const listings = await discoverAllListings(page);
      console.log(`📋 Discovered ${listings.length} total jobs across all pages.`);
      if (listings.length === 0) {
        throw new Error('Giorgio Armani listing rendered 0 jobs');
      }

      const swiss = listings.filter((l) => isGiorgioArmaniSwissJob(l.title, l.country));
      console.log(`🇨🇭 ${swiss.length}/${listings.length} jobs match Switzerland (TI/GR).`);

      const out = [];
      for (const job of swiss) {
        console.log(`  📄 Rendering Swiss detail: ${job.title} (${job.reqId}) — ${job.country}`);
        const html = await fetchDetailHtml(page, job.reqId);
        if (!html) continue;
        out.push({ ...job, html });
      }
      return out;
    });
  } catch (err) {
    const msg = err?.message || String(err);
    const isTransient = /did not hydrate|rendered 0 jobs|net::ERR_|timeout|TimeoutError|403/i.test(msg);
    if (isTransient) {
      console.warn(`⚠️  Giorgio Armani listing unavailable: ${msg}`);
      console.log('ℹ️  Keeping existing data — no updates this run.');
      return null;
    }
    throw err;
  }
}

function buildJobUrl(reqId) {
  return `${DETAIL_URL_BASE}${reqId}`;
}

function buildApplyUrl(reqId) {
  return `https://career5.successfactors.eu/sfcareer/jobreqcareer?jobId=${reqId}&company=${SF_COMPANY_ID}`;
}

/**
 * Extract city/location from the job title.
 * Giorgio Armani titles often contain the city: "Client Advisor - Giorgio Armani Zurigo"
 */
function extractLocationFromTitle(title = '') {
  // Common patterns: "Role - Brand Location", "Role - Location"
  const parts = title.split(/\s+-\s+/);
  if (parts.length >= 2) {
    const lastPart = parts[parts.length - 1].trim();
    // Remove brand prefixes
    const location = lastPart
      .replace(/^(?:Giorgio Armani|Emporio Armani|Armani Outlet|Armani Exchange|A\|X)\s*/i, '')
      .trim();
    if (location && location.length > 2) return location;
  }
  return '';
}

async function buildGiorgioArmaniJob(discovery) {
  const detail = parseGiorgioArmaniJobDetail(discovery.html);
  const location = extractLocationFromTitle(detail.title);
  const canton = inferGiorgioArmaniCanton(detail.title, location);
  const localized = buildGiorgioArmaniLocalizedContent(
    { ...detail, location },
    COMPANY_NAME
  );

  return {
    title: detail.title,
    slug: localized.slugByLocale.it,
    url: buildJobUrl(discovery.reqId),
    applyUrl: detail.applyHref ? `https://career5.successfactors.eu${detail.applyHref}` : buildApplyUrl(discovery.reqId),
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: location || detail.country,
    addressLocality: location || '',
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferGiorgioArmaniCategory(detail.area, detail.title),
    sector: 'Moda & Lusso',
    source: 'giorgio-armani-dedicated-crawler',
    sourceLang: detectLang(detail.description || '', 'en'),
    postedDate: toIsoDate(),
    employmentType: 'full-time',
    contractType: 'full-time',
    validThrough: '',
    description: detail.description,
    titleByLocale: localized.titleByLocale,
    descriptionByLocale: localized.descriptionByLocale,
    slugByLocale: localized.slugByLocale,
  };
}

function jobMatchKey(job = {}) {
  // Match by URL (which contains the unique reqId)
  const url = String(job.url || '').trim().toLowerCase();
  const reqIdMatch = url.match(/career_job_req_id=(\d+)/);
  if (reqIdMatch) return `armani-${reqIdMatch[1]}`;
  return String(job.slug || '').trim().toLowerCase();
}

function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonTargetJobs = existing.filter((job) => !isTargetJob(job));
  const targetExisting = existing.filter(isTargetJob);
  const beforeSnapshot = snapshotJobSlugs(targetExisting);
  const existingByKey = new Map(targetExisting.map((job) => [jobMatchKey(job), job]));

  let added = 0;
  let updated = 0;
  const mergedTarget = discoveredJobs.map((job) => {
    const prev = existingByKey.get(jobMatchKey(job));
    if (!prev) {
      added += 1;
      return job;
    }
    updated += 1;
    const merged = {
      ...prev,
      ...job,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, job.descriptionByLocale, 30),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3),
    };
    captureLostSlugs(merged, prev.slugByLocale, prev.slug, 20);
    return merged;
  });

  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  writeJson(PUBLIC_JOBS, allJobs);

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  writeJobsSummary(mergedTarget, COMPANY_NAME);
  printPublishedJobUrls(mergedTarget, COMPANY_NAME);
  return { total: mergedTarget.length, added, updated, diff };
}

function updateAdapterConfig(jobs) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = {
      location: job.location,
      canton: job.canton,
      company: COMPANY_NAME,
      postedDate: job.postedDate,
    };
  }
  writeJson(ADAPTER_PATH, {
    companyKey: COMPANY_KEY,
    companyName: COMPANY_NAME,
    companyHost: COMPANY_HOST,
    enabled: true,
    priority: 16,
    crawlerModes: ['playwright', 'html'],
    seedUrls: [CAREERS_URL],
    notes: `Dedicated Giorgio Armani crawler renders the SuccessFactors SPA (company=${SF_COMPANY_ID}) with a headless browser (Playwright): paginates the hydrated job listing, filters for Switzerland-based positions (TI/GR), and parses the hydrated detail .joqReqDescription. The listing/detail pages are no longer curl-fetchable (DWR-rendered SPA).`,
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_GIORGIO_ARMANI_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_armani_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Giorgio Armani Swiss jobs found (this may be normal — positions fluctuate).',
    detectSourceLang: (text) => detectLang(text, 'en'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'giorgio-armani');
  console.log('═══════════════════════════════════════════════');
  console.log('  Giorgio Armani — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}`);
  console.log(`  SuccessFactors company: ${SF_COMPANY_ID}`);
  console.log(`  Headless browser: ${HEADLESS ? 'on' : 'off'}\n`);

  const discoveries = await discoverSwissJobs();

  // Transient browser/site failure → discoverSwissJobs returned null. Preserve
  // the existing dataset untouched rather than wiping target jobs on a bad run.
  if (discoveries === null) {
    console.log('⏩ Skipping Giorgio Armani update — listing unavailable this run.');
    validateLocales();
    return;
  }

  if (discoveries.length === 0) {
    // Render succeeded but no Swiss roles are currently open (the common case —
    // Armani usually has only IT roles). Keep existing data: do NOT call
    // mergeJobs([]) (which would drop the existing Swiss entries), just refresh
    // the adapter timestamp and re-validate.
    console.log('\n⚠️  Rendered listing has 0 Swiss jobs. Preserving existing data.');
    const existingSwiss = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isTargetJob);
    updateAdapterConfig(existingSwiss);
    validateLocales();
    console.log('\n✅ Giorgio Armani crawler complete (0 Swiss jobs found, existing data preserved).');
    return;
  }

  const jobs = [];
  for (const disc of discoveries) {
    console.log(`  📄 Processing: ${disc.title} (${disc.reqId})`);
    jobs.push(await buildGiorgioArmaniJob(disc));
  }

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Giorgio Armani jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();
  console.log(`\n✅ Giorgio Armani crawler complete (${total} jobs, added=${added}, updated=${updated}).`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'giorgio-armani',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: diff.newJobs.length,
    updatedCount: diff.updatedJobs.length,
    removedCount: diff.removedJobs.length,
    unchangedCount: diff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: diff.newJobs.slice(0, 30),
    updatedJobs: diff.updatedJobs.slice(0, 30),
    removedJobs: diff.removedJobs.slice(0, 30),
    unchangedJobs: (diff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

main().catch((err) => exitCrawlerOnError(err, 'Giorgio Armani'));
