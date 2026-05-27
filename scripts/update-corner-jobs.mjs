#!/usr/bin/env node
/**
 * Dedicated Cornèr Banca crawler runner.
 *
 * Cornèr Banca uses Recruitee as their ATS. The careers portal at jobs.corner.ch
 * is a JavaScript SPA that cannot be crawled with HTML scraping. Instead, this
 * script fetches the public Recruitee API which returns structured JSON for all
 * open positions.
 *
 * API endpoint:
 *   https://cornerbancasa.recruitee.com/api/offers/
 *
 * Careers page URL pattern:
 *   https://jobs.corner.ch/o/{slug}
 *
 * The API returns full job data including multi-locale translations (it, en, de),
 * descriptions, requirements, locations, and employment details.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  detectLang,
  deriveLocalizedSlug,
  mergePreserveLocaleData,
} from './lib/dedicated-crawler-common.mjs';
import {
  parseCornerOfferFull,
  stripHtml,
  parseBullets,
  MIN_CORNER_DESC_LENGTH,
} from './lib/corner-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const CORNER_KEY = 'corner-banca';
const RECRUITEE_API = 'https://cornerbancasa.recruitee.com/api/offers/';

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isCornerJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key.includes(CORNER_KEY) ||
    host.includes('corner.ch') ||
    host.includes('cornerbancasa.recruitee.com')
  );
}

function isTrustedCornerDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.endsWith('corner.ch') || host.endsWith('cornerbancasa.recruitee.com');
  } catch {
    return false;
  }
}

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' e ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

// stripHtml and parseBullets imported from ./lib/corner-job-parser.mjs

function toIsoDate(raw = '') {
  const value = String(raw || '').trim();
  if (!value) return new Date().toISOString().slice(0, 10);
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

// ──────────────────────────────────────────────────────────────
// Category & contract mapping
// ──────────────────────────────────────────────────────────────

const CATEGORY_MAP = {
  banking: 'finance',
  administrative: 'admin',
  customer_service: 'sales',
  information_technology: 'tech',
  finance: 'finance',
  marketing: 'sales',
  engineering: 'engineering',
  hr: 'admin',
};

const CONTRACT_MAP = {
  fulltime_permanent: 'full-time',
  fulltime: 'full-time',
  parttime: 'part-time',
  temporary: 'temporary',
  contract: 'temporary',
  internship: 'temporary',
};

function inferCategory(offer) {
  return CATEGORY_MAP[offer?.category_code] || 'other';
}

function inferContract(offer) {
  const code = String(offer?.employment_type_code || '').toLowerCase();
  if (CONTRACT_MAP[code]) return CONTRACT_MAP[code];
  // Check for part-time indicators in title
  const title = String(offer?.title || '').toLowerCase();
  if (/\b\d{1,2}%/.test(title) && !/100%/.test(title)) return 'part-time';
  return 'full-time';
}

// ──────────────────────────────────────────────────────────────
// API fetch
// ──────────────────────────────────────────────────────────────

async function fetchRecruiteeOffers() {
  console.log('🔍 Fetching Corner jobs from Recruitee API...');
  console.log(`  📡 ${RECRUITEE_API}`);

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let body;
  try {
    const res = await fetch(RECRUITEE_API, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.error(`❌ HTTP ${res.status} for ${RECRUITEE_API}`);
      return [];
    }
    body = await res.text();
  } catch (err) {
    clearTimeout(timer);
    console.error(`❌ Fetch failed for ${RECRUITEE_API}: ${err.message}`);
    return [];
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    console.error(`❌ Failed to parse Recruitee API JSON: ${err.message}`);
    return [];
  }

  const offers = data?.offers;
  if (!Array.isArray(offers)) {
    console.error('❌ Recruitee API returned unexpected structure (no offers array).');
    return [];
  }

  console.log(`  📦 Total offers in API: ${offers.length}`);
  return offers;
}

// ──────────────────────────────────────────────────────────────
// Parse offer → job object
// ──────────────────────────────────────────────────────────────

function parseCornerOffer(offer) {
  // Parse content fields (description, offer_sections, requirements, locale titles)
  const parsed = parseCornerOfferFull(offer);
  if (!parsed) return null;

  const { title, titleByLocale, description, descriptionByLocale, requirements } = parsed;

  // Location
  const loc = (offer.locations || [])[0] || {};
  const city = loc.city || offer.city || 'Lugano';
  const canton = loc.state_code || offer.state_code || getCompanyDefaults('corner').canton;

  // URL
  const careersUrl = offer.careers_url || `https://jobs.corner.ch/o/${offer.slug}`;

  // ID and slug
  const urlHash = createHash('sha1').update(careersUrl).digest('hex').slice(0, 12);
  const id = `corner-banca-${urlHash}`;

  // Build locale requirements — only use actual Recruitee translations
  const translations = offer?.translations || {};
  const itTrans = translations.it || {};
  const enTrans = translations.en || {};
  const deTrans = translations.de || {};
  const frTrans = translations.fr || {};
  const reqIt = itTrans.requirements ? parseBullets(itTrans.requirements) : requirements;
  const reqEn = enTrans.requirements ? parseBullets(enTrans.requirements) : requirements;
  const reqDe = deTrans.requirements ? parseBullets(deTrans.requirements) : [];
  const reqFr = frTrans.requirements ? parseBullets(frTrans.requirements) : [];
  const requirementsByLocale = { it: reqIt, en: reqEn, de: reqDe, fr: reqFr };

  // Build locale slugs
  const slugByLocale = {
    it: slugify(`${titleByLocale.it}-corner-banca-${city}`),
    en: slugify(`${titleByLocale.en}-corner-banca-${city}`),
    de: slugify(`${titleByLocale.de}-corner-banca-${city}`),
    fr: slugify(`${titleByLocale.fr}-corner-banca-${city}`),
  };

  return {
    id,
    slug: slugify(`${title}-corner-banca-${city}`),
    slugByLocale,
    company: 'Cornèr Banca',
    companyKey: CORNER_KEY,
    companyDomain: 'corner.ch',
    title,
    titleByLocale,
    description,
    descriptionByLocale,
    requirements,
    requirementsByLocale,
    location: city,
    canton,
    addressLocality: city,
    addressCountry: 'CH',
    category: inferCategory(offer),
    contract: inferContract(offer),
    currency: 'CHF',
    featured: false,
    postedDate: toIsoDate(offer.published_at || offer.created_at),
    url: careersUrl,
    source: 'Corner Dedicated Parser (Recruitee API)',
    sourceLang: detectLang(description || title, 'en'),
    crawledAt: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────
// Merge & write
// ──────────────────────────────────────────────────────────────

function writeJobsFiles(jobs) {
  fs.writeFileSync(DATA_JOBS, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
  if (fs.existsSync(PUBLIC_DATA_JOBS)) {
    fs.writeFileSync(PUBLIC_DATA_JOBS, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
  }
}

function mergeParsedCornerJobs(parsedJobs) {
  const existing = readExistingCrawlerJobs(CORNER_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? existing : [];
  const nonCorner = allJobs.filter((job) => !isCornerJob(job));
  const cornerExisting = allJobs.filter(isCornerJob);

  const byUrl = new Map();
  for (const job of parsedJobs) {
    const key = String(job?.url || '').trim().replace(/\/+$/, '');
    if (!key) continue;
    byUrl.set(key, job);
  }
  const deduped = [...byUrl.values()];

  // Preserve existing AI translations and slugs
  const cleanCornerJobs = mergePreserveLocaleData(cornerExisting, deduped).sort(
    (a, b) => String(b.postedDate || '').localeCompare(String(a.postedDate || ''))
  );
  const merged = [...nonCorner, ...cleanCornerJobs];
  writeJobsFiles(merged);
  return cleanCornerJobs;
}

// ──────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────

function validateCornerLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_CORNER_STRICT',
    label: 'Corner',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isCornerJob,
    failOnMissingJobsFile: true,
    failWhenNoJobs: true,
    noJobsMessage: 'No Corner jobs found after crawl.',
    detectSourceLang: (text) => detectLang(text, 'it'),
    deriveSlug: deriveLocalizedSlug,
    isTrustedDomain: isTrustedCornerDomain,
    untrustedDomainReason: 'untrusted_domain_for_corner_job',
  });
}

async function runBaseCrawler() {
  console.log('🚀 Running shared crawler for AI localization...');
  await runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: CORNER_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    forceLocalizationWhenAiEnabledOnly: true,
  });
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(CORNER_KEY, 'Corner');
  console.log('🏦 Running dedicated Corner jobs crawler (Recruitee API)...');

  // Snapshot Corner jobs before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(CORNER_KEY, DATA_JOBS).filter(isCornerJob))

  // Step 1: Fetch offers from Recruitee API
  const offers = await fetchRecruiteeOffers();
  if (offers.length === 0) {
    console.log('⚠️ No offers returned from Recruitee API. Keeping existing Corner jobs unchanged.');
    return;
  }

  // Step 2: Parse offers into job objects
  console.log(`🧩 Parsing ${offers.length} Recruitee offers...`);
  const parsedJobs = [];
  for (const offer of offers) {
    const job = parseCornerOffer(offer);
    if (job) {
      parsedJobs.push(job);
      console.log(`  ✅ ${job.title} — ${job.location} (${job.canton})`);
    }
  }
  console.log(`✅ Parsed Corner jobs: ${parsedJobs.length}`);

  if (parsedJobs.length === 0) {
    console.log('⚠️ No valid jobs parsed — keeping existing Corner jobs unchanged.');
    return;
  }

  // Step 3: Merge into jobs.json
  const publishedJobs = mergeParsedCornerJobs(parsedJobs);
  printPublishedJobUrls(publishedJobs, 'Corner');
  writeJobsSummary(publishedJobs, 'Corner');

  // Crawl change summary (new/updated/removed)
  const afterSnapshot = snapshotJobSlugs(publishedJobs);
  const crawlDiff = computeCrawlDiff(_beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Corner');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Corner');

  // Step 4: Run shared localization pass
  await runBaseCrawler();

  // Step 5: Validate locale coverage
  validateCornerLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isCornerJob) : [];
  writeJobsCrawlerSlice(CORNER_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: CORNER_KEY,
    label: 'Corner',
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
  console.error(`❌ Corner crawler failed: ${err?.message || err}`);
  process.exit(1);
});
