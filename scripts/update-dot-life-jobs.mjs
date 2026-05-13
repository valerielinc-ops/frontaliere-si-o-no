#!/usr/bin/env node
/**
 * Dedicated DOT Life crawler.
 *
 * DOT Life SA is a hospitality & wellness group based in Paradiso (TI) that
 * owns Villa Principe Leopoldo, Villa Sassa, Kurhaus Cademario, and
 * Park Hotel Principe.
 *
 * Their website has no dedicated careers page — jobs are published on LinkedIn
 * under company ID 9425984. This crawler uses LinkedIn's public guest
 * endpoints which are accessible without a logged-in session:
 *
 *   Listing: https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
 *            ?f_C=9425984&geoId=92000000&start=0
 *   Detail:  https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{jobId}
 *   Fallback listing: https://www.linkedin.com/jobs/search/?f_C=9425984&geoId=92000000
 */
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { extractStableJobId } from './lib/job-match-key.mjs';
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
} from './lib/dedicated-crawler-common.mjs';
import {
  parseDotLifeLinkedInCards,
  parseDotLifeLinkedInDetail,
  extractLinkedInJobId,
  linkedInJobUrl,
  buildDotLifeLocalizedContent,
} from './lib/dot-life-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'dot-life.json');

const COMPANY_KEY = 'dot-life';
const HQ = getCompanyDefaults(COMPANY_KEY);
const COMPANY_NAME = 'DOT Life SA';
const COMPANY_DOMAIN = 'dotlifestyle.ch';
const COMPANY_HOST = 'inrecruiting.intervieweb.it'; // not used as host anymore; kept for adapter compatibility
const LINKEDIN_COMPANY_ID = '9425984';

// Public guest listing endpoint — no login required
const GUEST_LISTING_URL = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?f_C=${LINKEDIN_COMPANY_ID}&geoId=92000000&start=0`;
// Fallback: public search page HTML
const SEARCH_PAGE_URL = `https://www.linkedin.com/jobs/search/?f_C=${LINKEDIN_COMPANY_ID}&geoId=92000000`;
// Guest job detail fragment endpoint — no login required
const GUEST_DETAIL_BASE = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting';

const LOCALES = ['it', 'en', 'de', 'fr'];

// Minimum description length to consider a parsed job valid
const MIN_DESCRIPTION_LENGTH = 80;

const BROWSER_UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/* ── Utilities ─────────────────────────────────────────────── */

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
        'User-Agent': BROWSER_UA,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    // LinkedIn redirects to login when the session wall is hit
    if (
      /Sign in to LinkedIn/i.test(text) ||
      /uas\/login/i.test(text) ||
      /authwall/i.test(text)
    ) {
      throw new Error('LinkedIn session wall encountered — guest access blocked');
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/* ── Matchers ──────────────────────────────────────────────── */

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    key === 'dot-life-sa' ||
    key.startsWith('dot-life') ||
    company.includes('dot life') ||
    company.includes('dotlife') ||
    url.includes('dotlifestyle.ch') ||
    url.includes('dotlife.swiss')
  );
}

/**
 * LinkedIn IS the trusted source for DOT Life jobs — they have no
 * first-party careers page.
 */
function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'www.linkedin.com' ||
      host === 'linkedin.com' ||
      host === 'www.dotlifestyle.ch' ||
      host.endsWith('.dotlifestyle.ch') ||
      host.endsWith('.dotlife.swiss')
    );
  } catch {
    return false;
  }
}

function inferCategory(detail = {}) {
  const haystack = normalize(`${detail.title || ''} ${detail.description || ''} ${detail.jobFunction || ''}`);
  if (haystack.includes('chef') || haystack.includes('cuoco') || haystack.includes('cucina') || haystack.includes('food')) return 'hospitality';
  if (haystack.includes('front office') || haystack.includes('reception') || haystack.includes('concierge')) return 'hospitality';
  if (haystack.includes('spa') || haystack.includes('wellness') || haystack.includes('beauty')) return 'hospitality';
  if (haystack.includes('selezione') || haystack.includes('recruiting') || haystack.includes('hr') || haystack.includes('personale')) return 'hr';
  if (haystack.includes('marketing') || haystack.includes('comunicazion')) return 'marketing';
  if (haystack.includes('contabil') || haystack.includes('accounting') || haystack.includes('finance')) return 'finance';
  return 'hospitality';
}

/* ── Discovery ─────────────────────────────────────────────── */

async function fetchListingsFromGuestApi() {
  console.log('🔍 Fetching DOT Life jobs from LinkedIn guest API...');
  const html = await fetchText(GUEST_LISTING_URL);
  const cards = parseDotLifeLinkedInCards(html);
  if (cards.length > 0) return cards;

  // If the guest API returned empty, fall back to the search page HTML
  console.log('⚠️  Guest API returned no cards — trying search page fallback...');
  const searchHtml = await fetchText(SEARCH_PAGE_URL);
  return parseDotLifeLinkedInCards(searchHtml);
}

async function fetchListings() {
  let cards;
  try {
    cards = await fetchListingsFromGuestApi();
  } catch (err) {
    // Treat LinkedIn session wall / connectivity errors as transient
    const isTransient = /session wall|blocked|net::ERR_|timeout|HTTP 4[0-9]{2}|HTTP 5[0-9]{2}/i.test(err.message);
    if (isTransient) {
      console.warn(`⚠️  LinkedIn guest listing unavailable: ${err.message}`);
      console.log('ℹ️  Keeping existing data — no updates this run.');
      return null;
    }
    throw err;
  }

  console.log(`📋 Total LinkedIn cards discovered: ${cards.length}`);
  for (const card of cards) {
    console.log(`  📄 ${card.title}${card.location ? ` (${card.location})` : ''}`);
  }
  return cards;
}

/* ── Detail fetch with Playwright fallback ─────────────────── */

/**
 * Fetch the LinkedIn guest job detail fragment.
 * Tries plain HTTP first; falls back to the public jobs/view page via
 * Playwright when LinkedIn's bot detection serves a login wall.
 */
async function fetchDetailHtml(jobId, playwrightPage) {
  const guestUrl = `${GUEST_DETAIL_BASE}/${jobId}`;
  const publicUrl = linkedInJobUrl(jobId);

  // Fast path: plain HTTP to the guest fragment endpoint
  try {
    return await fetchText(guestUrl);
  } catch (err) {
    if (!/session wall|blocked/i.test(err.message)) throw err;
  }

  // Slow path: Playwright headless browser on the public job page
  console.log(`  ↩️  HTTP blocked — using browser for /jobs/view/${jobId}/`);
  await playwrightPage.goto(publicUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // Wait for job title to be rendered
  const started = Date.now();
  while (Date.now() - started < 20000) {
    const title = await playwrightPage.textContent('h1').catch(() => '');
    if (title && title.trim().length > 3) break;
    await playwrightPage.waitForTimeout(800);
  }
  return playwrightPage.content();
}

/* ── Build individual job ──────────────────────────────────── */

async function buildDotLifeJob(card, playwrightPage) {
  const html = await fetchDetailHtml(card.jobId, playwrightPage);
  const detail = parseDotLifeLinkedInDetail(html, linkedInJobUrl(card.jobId));


  // Quality guards
  const title = detail.title || card.title;
  if (!title || title.length < 3) throw new Error('Missing or too-short title');
  if (detail.description.length < MIN_DESCRIPTION_LENGTH) {
    throw new Error(`Description too short (${detail.description.length} chars)`);
  }

  const rawLocation = detail.location || card.location || 'Paradiso';
  const localized = buildDotLifeLocalizedContent({ ...detail, title });
  const canonicalSlug =
    localized.slugByLocale.en ||
    localized.slugByLocale.it ||
    `${normalizeKey(title)}-dot-life-sa-${normalizeKey(rawLocation)}`;

  const postedDate = detail.postedDate || card.postedDate || new Date().toISOString().slice(0, 10);

  return {
    title,
    slug: canonicalSlug,
    url: linkedInJobUrl(card.jobId),
    applyUrl: linkedInJobUrl(card.jobId),
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: rawLocation,
    addressLocality: rawLocation,
    addressRegion: HQ.addressRegion,
    addressCountry: 'CH',
    canton: HQ.canton,
    country: 'CH',
    category: inferCategory(detail),
    sector: 'Hospitality & Wellness',
    source: 'dot-life-linkedin-crawler',
    sourceLang: detectLang(detail.description || card.title, 'it'),
    postedDate,
    employmentType: detail.employmentType || 'full-time',
    contractType: detail.employmentType || 'full-time',
    validThrough: '',
    description: detail.description,
    linkedInJobId: card.jobId,
    titleByLocale: localized.titleByLocale,
    descriptionByLocale: localized.descriptionByLocale,
    slugByLocale: localized.slugByLocale,
  };
}

/* ── Merge & write ─────────────────────────────────────────── */

function jobMatchKey(job = {}) {
  // Deduplicate by LinkedIn job ID when present, else by URL
  if (job.linkedInJobId) return `linkedin:${job.linkedInJobId}`;
  return extractStableJobId(job.url) || String(job.slug || '').trim().toLowerCase();
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
    return {
      ...prev,
      ...job,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, job.descriptionByLocale, 30),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3),
    };
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

/* ── Adapter config ────────────────────────────────────────── */

function updateAdapterConfig(jobs) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = {
      location: job.location,
      canton: job.canton || HQ.canton,
      company: COMPANY_NAME,
      postedDate: job.postedDate,
      linkedInJobId: job.linkedInJobId,
    };
  }
  writeJson(ADAPTER_PATH, {
    companyKey: COMPANY_KEY,
    companyName: COMPANY_NAME,
    companyHost: 'www.linkedin.com',
    enabled: true,
    priority: 12,
    crawlerModes: ['html'],
    seedUrls: [GUEST_LISTING_URL, SEARCH_PAGE_URL],
    notes: `Dedicated DOT Life crawler uses LinkedIn public guest endpoints for company ${LINKEDIN_COMPANY_ID} (DOT Life SA). No login required. Guest listing: ${GUEST_LISTING_URL}. Guest detail: ${GUEST_DETAIL_BASE}/{jobId}. Canonicalizes to /jobs/view/{jobId}/ URLs.`,
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

/* ── Locale validation ─────────────────────────────────────── */

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_DOT_LIFE_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_linkedin_or_dotlife',
    // Company may have no active openings at times
    failWhenNoJobs: false,
    noJobsMessage: 'No DOT Life jobs found — company may have no active LinkedIn openings.',
    detectSourceLang: (text) => detectLang(text, 'it'),
  });
}

/* ── Main ──────────────────────────────────────────────────── */

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'dot-life');
  console.log('═══════════════════════════════════════════════');
  console.log('  DOT Life SA — LinkedIn Guest Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Listing: ${GUEST_LISTING_URL}\n`);

  const cards = await fetchListings();
  if (!cards) {
    // Transient failure — preserve existing data
    printCrawlChangeSummary(
      { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0 },
      COMPANY_NAME,
    );
    return;
  }

  if (cards.length === 0) {
    console.log('\nℹ️  No DOT Life LinkedIn jobs found. Skipping merge & translation.');
    updateAdapterConfig([]);
    printCrawlChangeSummary(
      { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0 },
      COMPANY_NAME,
    );
    console.log('✅ DOT Life crawler complete (0 jobs).');
    return;
  }

  const jobs = [];
  let skipped = 0;

  // Open a shared browser session for Playwright fallback on detail pages
  const browser = await chromium.launch({ headless: true });
  const bContext = await browser.newContext({
    userAgent: BROWSER_UA,
    viewport: { width: 1440, height: 900 },
    locale: 'it-IT',
  });
  const bPage = await bContext.newPage();

  try {
    for (const card of cards) {
      console.log(`  📄 Processing: ${card.title} (ID: ${card.jobId})`);
      try {
        const job = await buildDotLifeJob(card, bPage);
        jobs.push(job);
      } catch (err) {
        skipped += 1;
        console.warn(`  ⚠️  Skipping "${card.title}" (${card.jobId}): ${err.message}`);
      }
      // Rate-limit: ~1 req/s to respect LinkedIn
      await sleep(800);
    }
  } finally {
    await bContext.close();
    await browser.close();
  }

  if (skipped > 0) {
    console.warn(`  ⚠️  Skipped ${skipped}/${cards.length} jobs due to errors`);
  }

  if (jobs.length === 0) {
    console.warn('⚠️  All detail fetches failed — preserving existing data.');
    printCrawlChangeSummary(
      { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0 },
      COMPANY_NAME,
    );
    return;
  }

  const result = mergeJobs(jobs);
  const diff = result.diff;
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for DOT Life jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();
  console.log(`\n🏨 Total DOT Life jobs: ${result.total}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'dot-life',
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

main().catch((err) => {
  console.error(`❌ DOT Life crawler failed: ${err?.message || err}`);
  process.exit(1);
});
