#!/usr/bin/env node
/**
 * Dedicated A++ Group crawler.
 *
 * A++ Group is an architecture, design & sustainability firm based in
 * Massagno (TI).  Jobs are published on the InRecruiting/Intervieweb portal
 * at https://inrecruiting.intervieweb.it/a2plus/en/career.
 *
 * This crawler:
 *   1. Fetches the InRecruiting listing page for the a2plus tenant.
 *   2. Filters cards to Swiss (TI / GR) positions.
 *   3. Fetches each detail page — prefers JSON-LD, falls back to HTML.
 *   4. Merges results into data/jobs.json.
 *   5. Updates the adapter config with current seed URLs.
 *   6. Runs locale fill + validation.
 *   7. Exits OK with 0 jobs when no Swiss vacancies are active.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  parseAplusListings,
  parseAplusJobDetail,
  isAplusSwissLocation,
  inferAplusCanton,
  buildAplusLocalizedContent,
} from './lib/a-plus-plus-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'a-group.json');

const COMPANY_KEY = 'a-group';
const COMPANY_NAME = 'A++ Group';
const COMPANY_HOST = 'inrecruiting.intervieweb.it';
const COMPANY_DOMAIN = 'a2plus.green';
const HQ = getCompanyDefaults(COMPANY_KEY);
const LISTING_URL = 'https://inrecruiting.intervieweb.it/a2plus/en/career';
const LOCALES = ['it', 'en', 'de', 'fr'];

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

async function fetchText(url, timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': BROWSER_UA,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
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
    key === 'a-group' ||
    key.startsWith('a-plus-plus') ||
    company.includes('a++ group') ||
    company.includes('a2plus') ||
    url.includes('inrecruiting.intervieweb.it/a2plus/') ||
    url.includes('a2plus.green')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'inrecruiting.intervieweb.it' ||
      host === 'a2plus.green' ||
      host.endsWith('.a2plus.green')
    );
  } catch {
    return false;
  }
}

function inferCategory(detail = {}) {
  const haystack = normalize(`${detail.title || ''} ${detail.description || ''}`);
  if (haystack.includes('bim') || haystack.includes('software') || haystack.includes('developer') || haystack.includes('informatica')) return 'tech';
  if (haystack.includes('ingegner') || haystack.includes('engineer') || haystack.includes('ingénieur')) return 'tech';
  if (haystack.includes('contabil') || haystack.includes('accounting') || haystack.includes('finance')) return 'finance';
  if (haystack.includes('receptionist') || haystack.includes('reception') || haystack.includes('assistente')) return 'admin';
  if (haystack.includes('project manager') || haystack.includes('immobil') || haystack.includes('real estate')) return 'real-estate';
  return 'architecture';
}

/* ── Fetch listings ────────────────────────────────────────── */

async function fetchListings() {
  console.log(`🔍 Fetching A++ Group jobs from InRecruiting: ${LISTING_URL}`);
  const html = await fetchText(LISTING_URL);
  const all = parseAplusListings(html);
  const target = all.filter((row) => !row.location || isAplusSwissLocation(row.location));
  console.log(`📋 Total listing cards: ${all.length}`);
  console.log(`📋 Swiss-located cards: ${target.length}`);
  for (const row of target) {
    console.log(`  📄 ${row.title}${row.location ? ` (${row.location})` : ''}`);
  }
  return target;
}

/* ── Build individual job ──────────────────────────────────── */

function absoluteUrl(raw = '') {
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return new URL(raw, LISTING_URL).toString();
}

async function buildAplusJob(listing) {
  const detailUrl = absoluteUrl(listing.href);
  const html = await fetchText(detailUrl);
  const detail = parseAplusJobDetail(html, detailUrl);
  if (!detail.title) {
    throw new Error(`Missing title while parsing ${detailUrl}`);
  }
  // Discard purely numeric locations (postal codes, not city names)
  const detailLoc = /^\d+$/.test(String(detail.location || '').trim()) ? '' : (detail.location || '');
  const listingLoc = /^\d+$/.test(String(listing.location || '').trim()) ? '' : (listing.location || '');
  const rawLocation = detailLoc || listingLoc || 'Massagno';
  const canton = inferAplusCanton(rawLocation);
  const postalCode = rawLocation.toLowerCase().includes('massagno') || !rawLocation ? HQ.postalCode : '6900';
  const streetAddress = rawLocation.toLowerCase().includes('massagno') || !rawLocation ? 'Via Molinazzo 4' : '';
  const localized = buildAplusLocalizedContent(detail);
  const canonicalTitle = detail.title;
  const canonicalSlug =
    localized.slugByLocale.en ||
    localized.slugByLocale.it ||
    `${normalizeKey(canonicalTitle)}-a-plus-plus-group-${normalizeKey(rawLocation)}`;
  const sourceUrl = detail.shareUrl || detailUrl;

  return {
    title: canonicalTitle,
    slug: canonicalSlug,
    url: sourceUrl,
    applyUrl: sourceUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: rawLocation,
    addressLocality: rawLocation,
    postalCode,
    streetAddress,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferCategory(detail),
    sector: 'Architettura & Design',
    source: 'a-plus-plus-dedicated-crawler',
    sourceLang: detectLang(detail.description || listing.teaser || '', 'it'),
    postedDate: new Date().toISOString().slice(0, 10),
    employmentType: 'full-time',
    contractType: 'full-time',
    validThrough: '',
    description: detail.description || listing.teaser || '',
    titleByLocale: localized.titleByLocale,
    descriptionByLocale: localized.descriptionByLocale,
    slugByLocale: localized.slugByLocale,
  };
}

/* ── Merge & write ─────────────────────────────────────────── */

function jobMatchKey(job = {}) {
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
    };
  }
  writeJson(ADAPTER_PATH, {
    companyKey: COMPANY_KEY,
    companyName: COMPANY_NAME,
    companyHost: COMPANY_HOST,
    enabled: true,
    priority: 14,
    crawlerModes: ['html', 'jsonld'],
    seedUrls: [LISTING_URL],
    notes: 'Dedicated A++ Group crawler uses the InRecruiting portal at inrecruiting.intervieweb.it/a2plus/en/career. Prefers JobPosting JSON-LD on detail pages; falls back to standard InRecruiting HTML structure. Filters to Swiss (TI/GR) positions. A++ Group is an architecture, design & sustainability firm headquartered in Massagno (TI).',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

/* ── Locale validation ─────────────────────────────────────── */

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_A_GROUP_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_a2plus_domain',
    // A++ Group may legitimately have no active Swiss vacancies
    failWhenNoJobs: false,
    noJobsMessage: 'No A++ Group Swiss jobs found — company may have no active vacancies.',
    detectSourceLang: (text) => detectLang(text, 'it'),
  });
}

/* ── Main ──────────────────────────────────────────────────── */

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'a-plus-plus-group');
  console.log('═══════════════════════════════════════════════');
  console.log('  A++ Group — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Portal: ${LISTING_URL}\n`);

  const listings = await fetchListings();

  if (listings.length === 0) {
    console.log('\nℹ️  No Swiss-located A++ Group jobs found. Skipping merge & translation.');
    updateAdapterConfig([]);
    printCrawlChangeSummary(
      { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0 },
      COMPANY_NAME,
    );
    console.log('✅ A++ Group crawler complete (0 Swiss jobs).');
    return;
  }

  const jobs = [];
  let skipped = 0;
  for (const listing of listings) {
    console.log(`  📄 Processing: ${listing.title}`);
    try {
      const job = await buildAplusJob(listing);
      jobs.push(job);
    } catch (err) {
      skipped += 1;
      console.warn(`  ⚠️  Skipping "${listing.title}": ${err.message}`);
    }
  }
  if (skipped > 0) {
    console.warn(`  ⚠️  Skipped ${skipped}/${listings.length} detail pages due to errors`);
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

  console.log('\n🌐 Running locale fill for A++ Group jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  const tiCount = jobs.filter((j) => j.canton === 'TI').length;
  const grCount = jobs.filter((j) => j.canton === 'GR').length;
  console.log(`\n🏢 Total A++ Group jobs: ${result.total} (TI: ${tiCount}, GR: ${grCount})`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'a-plus-plus-group',
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
  console.error(`❌ A++ Group crawler failed: ${err?.message || err}`);
  process.exit(1);
});
