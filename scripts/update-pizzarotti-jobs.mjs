#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  parsePizzarottiListings,
  parsePizzarottiPageCount,
  isPizzarottiSwissLocation,
  inferPizzarottiCanton,
  parsePizzarottiJobDetail,
  buildPizzarottiLocalizedContent,
} from './lib/pizzarotti-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'impresa-pizzarotti.json');

const COMPANY_KEY = 'impresa-pizzarotti';
const COMPANY_NAME = 'Impresa Pizzarotti & C. S.p.A.';
const COMPANY_HOST = 'www.pizzarotti.it';
const COMPANY_DOMAIN = 'pizzarotti.it';
const CAREERS_URL = 'https://www.pizzarotti.it/persone/carriere/selezioni-in-corso/';
const LISTING_BASE_URL = 'https://inrecruiting.intervieweb.it/app.php?module=iframeAnnunci&lang=it&k=4b540470d86438622d22d56b1b3e761a&d=www.pizzarotti.it&LAC=impresapizzarotti&utype=&act1=23&defgroup=name&gnavenable=1&desc=1&annType=published&h=&typeView=large';
const LOCALES = ['it', 'en', 'de', 'fr'];

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
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  const applyUrl = String(job.applyUrl || '').toLowerCase();
  return key === COMPANY_KEY
    || company.includes('pizzarotti')
    || url.includes('inrecruiting.intervieweb.it/impresapizzarotti/')
    || applyUrl.includes('inrecruiting.intervieweb.it/impresapizzarotti/');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'inrecruiting.intervieweb.it' || host === 'www.pizzarotti.it' || host.endsWith('.pizzarotti.it');
  } catch {
    return false;
  }
}

function inferCategory(detail = {}) {
  const haystack = normalize(`${detail.category || ''} ${detail.title || ''} ${detail.description || ''}`);
  if (haystack.includes('ingegner') || haystack.includes('engineer') || haystack.includes('ingénieur')) return 'tech';
  if (haystack.includes('cantiere') || haystack.includes('chantier') || haystack.includes('construction')) return 'construction';
  if (haystack.includes('contabil') || haystack.includes('comptab') || haystack.includes('accounting')) return 'finance';
  if (haystack.includes('progett') || haystack.includes('projet') || haystack.includes('project')) return 'tech';
  if (haystack.includes('bim') || haystack.includes('software') || haystack.includes('developer')) return 'tech';
  return 'construction';
}

async function fetchPizzarottiListings() {
  console.log('🔍 Fetching Pizzarotti jobs from InRecruiting listing...');
  const firstPageHtml = await fetchText(LISTING_BASE_URL);
  const totalPages = parsePizzarottiPageCount(firstPageHtml);
  let allListings = parsePizzarottiListings(firstPageHtml);
  console.log(`📋 Page 1: ${allListings.length} listings (${totalPages} page(s) total)`);

  for (let page = 2; page <= totalPages; page++) {
    const pageUrl = `${LISTING_BASE_URL}&CurPag=${page}`;
    const html = await fetchText(pageUrl);
    const pageListings = parsePizzarottiListings(html);
    console.log(`📋 Page ${page}: ${pageListings.length} listings`);
    allListings = allListings.concat(pageListings);
  }

  // Deduplicate by href (same job can appear across pagination boundaries)
  const seen = new Set();
  allListings = allListings.filter((row) => {
    if (seen.has(row.href)) return false;
    seen.add(row.href);
    return true;
  });

  // Filter for Swiss locations only
  const target = allListings.filter((row) => isPizzarottiSwissLocation(row.location));
  console.log(`📋 Total unique listing rows: ${allListings.length}`);
  console.log(`📋 Swiss-located rows: ${target.length}`);
  for (const row of target) {
    console.log(`  📄 ${row.title} (${row.location})`);
  }
  if (target.length < 1) {
    console.warn(`⚠️  No Swiss-located Pizzarotti jobs found. Current listings are all in Italy.`);
    return [];
  }
  return target;
}

async function buildPizzarottiJob(listing) {
  const html = await fetchText(listing.href);
  const detail = parsePizzarottiJobDetail(html);
  const canton = inferPizzarottiCanton(`${detail.location} ${listing.location}`);
  const localized = buildPizzarottiLocalizedContent(detail, COMPANY_NAME);
  const sourceUrl = detail.shareUrl || listing.href;
  const canonicalTitle = detail.title || listing.title;
  const canonicalSlug =
    localized.slugByLocale.it ||
    normalizeKey(`${canonicalTitle} ${COMPANY_NAME} ${detail.location || listing.location}`);
  return {
    title: canonicalTitle,
    slug: canonicalSlug,
    url: sourceUrl,
    applyUrl: sourceUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: detail.location || listing.location,
    addressLocality: detail.location || listing.location,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferCategory(detail),
    sector: 'Costruzioni & Infrastrutture',
    source: 'pizzarotti-dedicated-crawler',
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
    priority: 18,
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL, LISTING_BASE_URL],
    notes: 'Dedicated Pizzarotti crawler parses InRecruiting/Intervieweb listing and detail pages, keeping only Swiss-located vacancies.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_PIZZAROTTI_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_pizzarotti_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Pizzarotti Swiss jobs found — company may have no active Swiss vacancies.',
    detectSourceLang: (text) => detectLang(text, 'it'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'pizzarotti');
  console.log('═══════════════════════════════════════════════════');
  console.log('  Impresa Pizzarotti & C. S.p.A. — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const listings = await fetchPizzarottiListings();
  if (listings.length === 0) {
    console.log('\nℹ️  No Swiss-located jobs found. Skipping merge & translation.');
    updateAdapterConfig([]);
    console.log('✅ Pizzarotti crawler complete (0 Swiss jobs).');
    return;
  }

  const jobs = [];
  for (const listing of listings) {
    jobs.push(await buildPizzarottiJob(listing));
  }

  const result = mergeJobs(jobs);
  const diff = result.diff;
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Pizzarotti jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();
  console.log(`\n✅ Pizzarotti crawler complete (${result.total} Swiss job(s)).`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'pizzarotti',
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
  console.error(`❌ Pizzarotti crawler failed: ${err?.message || err}`);
  process.exit(1);
});
