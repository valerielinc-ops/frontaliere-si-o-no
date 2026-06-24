#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeLocationToken } from './lib/safe-location-token.mjs';
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
  slugify,
} from './lib/dedicated-crawler-common.mjs';
import {
  parseSkyguideListings,
  parseSkyguideJobDetail,
  isSkyguideTargetLocation,
  inferSkyguideCanton,
  buildSkyguideLocalizedContent,
} from './lib/skyguide-job-parser.mjs';
import { fetchHtml, exitCrawlerOnError } from './lib/crawler-template.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'skyguide-sa.json');

const COMPANY_KEY = 'skyguide-sa';
const COMPANY_NAME = 'Skyguide';
const COMPANY_HOST = 'jobs.skyguide.ch';
const COMPANY_DOMAIN = 'skyguide.ch';
const DETAIL_BASE = 'https://jobs.skyguide.ch';
const LISTING_URLS = [
  'https://jobs.skyguide.ch/search/?createNewAlert=false&q=&locationsearch=&optionsFacetsDD_department=&optionsFacetsDD_location=Locarno%2C+CH',
  'https://jobs.skyguide.ch/search/?createNewAlert=false&q=&locationsearch=&optionsFacetsDD_department=&optionsFacetsDD_location=Lugano+Agno%2C+CH',
];
const LOCALES = ['it', 'en', 'de', 'fr'];

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

// fetchText removed: replaced by shared fetchHtml from crawler-template.mjs,
// which adds connection-level Jina fallback for datacenter egress blocks (the
// root cause of the 2026-04-18 Skyguide CI outage). fetchHtml already includes
// retry+backoff via fetchWithRetry; no local loop needed.
//
// Skyguide's WAF gates on a realistic browser fingerprint, so we MUST keep the
// Chrome User-Agent + Accept-Language this crawler always sent (the bot DEFAULT_UA
// risks a 403, which is an HTTP error → NOT proxied via Jina → hard fail every wave).
// options.headers override DEFAULT_UA; 30s timeout preserved.
const SKYGUIDE_FETCH_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8,de;q=0.7,fr;q=0.6',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};
const SKYGUIDE_FETCH_OPTS = { headers: SKYGUIDE_FETCH_HEADERS, timeoutMs: 30000 };

function absoluteUrl(raw = '') {
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return new URL(raw, DETAIL_BASE).toString();
}

function normalizeLocation(raw = '') {
  const value = String(raw || '').trim();
  if (/lugano agno/i.test(value)) return 'Lugano Agno';
  if (/locarno/i.test(value)) return 'Locarno';
  return value.replace(/,\s*CH$/i, '').trim();
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  const applyUrl = String(job.applyUrl || '').toLowerCase();
  return key === COMPANY_KEY
    || company.includes('skyguide')
    || url.includes('jobs.skyguide.ch/job/')
    || applyUrl.includes('jobs.skyguide.ch/talentcommunity/apply/');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'jobs.skyguide.ch' || host.endsWith('.skyguide.ch') || host === 'skyguide.ch';
  } catch {
    return false;
  }
}

async function fetchListings() {
  console.log('🔍 Fetching Skyguide jobs from filtered listings...');
  const discovered = [];
  const seen = new Set();

  for (const listingUrl of LISTING_URLS) {
    const html = await fetchHtml(listingUrl, SKYGUIDE_FETCH_OPTS);
    const rows = parseSkyguideListings(html);
    console.log(`📋 Rows from filter ${listingUrl}: ${rows.length}`);
    for (const row of rows) {
      if (!isSkyguideTargetLocation(row.location)) continue;
      const key = absoluteUrl(row.href);
      if (seen.has(key)) continue;
      seen.add(key);
      discovered.push(row);
      console.log(`  📄 ${row.title} (${row.location})`);
    }
  }

  if (discovered.length < 1) {
    throw new Error(`Expected at least 1 Skyguide job in Ticino/Grigioni, found ${discovered.length}`);
  }
  return discovered;
}

function inferCategory(detail = {}) {
  const haystack = normalize(`${detail.title || ''} ${detail.description || ''}`);
  if (haystack.includes('controllore') || haystack.includes('traffico aereo')) return 'aviation';
  return 'other';
}

function normalizePostedDate(raw = '') {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

async function buildSkyguideJob(listing) {
  const detailUrl = absoluteUrl(listing.href);
  const html = await fetchHtml(detailUrl, SKYGUIDE_FETCH_OPTS);
  const detail = parseSkyguideJobDetail(html);
  const localized = buildSkyguideLocalizedContent(detail, COMPANY_NAME);
  const location = normalizeLocation(detail.location || listing.location);
  const canton = inferSkyguideCanton(detail.location || listing.location);
  return {
    title: localized.titleByLocale.it || detail.title || listing.title,
    slug: localized.slugByLocale.it,
    url: detailUrl,
    applyUrl: absoluteUrl(detail.applyPath),
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location,
    addressLocality: location,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferCategory(detail),
    sector: 'Logistica',
    source: 'skyguide-dedicated-crawler',
    sourceLang: detectLang(detail.description || '', 'it'),
    postedDate: normalizePostedDate(detail.datePostedRaw),
    employmentType: 'full-time',
    contractType: 'full-time',
    validThrough: '',
    description: localized.descriptionByLocale.it,
    titleByLocale: localized.titleByLocale,
    descriptionByLocale: localized.descriptionByLocale,
    slugByLocale: localized.slugByLocale,
  };
}

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
  return { total: mergedTarget.length, diff };
}

function refreshLocalizedSlugs() {
  const jobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  let changed = 0;
  const nextJobs = jobs.map((job) => {
    if (!isTargetJob(job)) return job;
    const next = { ...job, slugByLocale: { ...(job.slugByLocale || {}) } };
    for (const locale of LOCALES) {
      const localizedTitle = String(next.titleByLocale?.[locale] || '').trim();
      if (!localizedTitle) continue;
      // Slug-only guard: `addressLocality`/`location` can be the literal
      // "undefined"/"null" string (truthy → slips past `|| 'Ticino'`) → `-undefined`
      // in an active slug (#952, class #900/#901). Stored addressLocality untouched.
      // Guard each operand BEFORE the `||`: a literal "undefined" addressLocality is
      // truthy, so `addressLocality || location` would short-circuit on it and mask a
      // valid `location`, yielding the 'Ticino' fallback instead of the real city
      // (#1151). `safeLocationToken(x, null)` returns null for missing/"undefined"/
      // "null", letting the `||` fall through to `location`.
      const localizedLocation =
        safeLocationToken(next.addressLocality, null) || safeLocationToken(next.location, 'Ticino');
      const slug = slugify(`${localizedTitle} ${COMPANY_NAME} ${localizedLocation}`);
      if (slug && next.slugByLocale[locale] !== slug) {
        next.slugByLocale[locale] = slug;
        changed += 1;
      }
    }
    return next;
  });
  if (changed > 0) {
    writeJson(DATA_JOBS, nextJobs);
    writeJson(PUBLIC_JOBS, nextJobs);
  }
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
    priority: 15,
    crawlerModes: ['html'],
    seedUrls: LISTING_URLS,
    notes: 'Dedicated Skyguide crawler parses the SuccessFactors filtered listings for Locarno and Lugano Agno and extracts full detail pages.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_SKYGUIDE_STRICT',
    label: 'Skyguide',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_skyguide_domain',
    failWhenNoJobs: true,
    noJobsMessage: 'No Skyguide jobs found after dedicated crawl.',
    detectSourceLang: (text) => detectLang(text, 'it'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Skyguide');
  console.log('═══════════════════════════════════════════════');
  console.log('  Skyguide — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Listing filters: ${LISTING_URLS.length}\n`);

  const listings = await fetchListings();
  const jobs = [];
  for (const listing of listings) {
    jobs.push(await buildSkyguideJob(listing));
  }
  const { total , diff } = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Skyguide jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });
  refreshLocalizedSlugs();

  validateLocales();
  console.log(`\n✅ Skyguide crawler complete (${total} jobs).`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Skyguide',
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

main().catch((err) => exitCrawlerOnError(err, 'Skyguide'));
