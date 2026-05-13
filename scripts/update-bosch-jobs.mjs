#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
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
  parseBoschListingsPage,
  isBoschTargetListing,
  parseBoschJobDetail,
  buildBoschLocalizedContent,
  inferBoschCategory,
} from './lib/bosch-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'bosch-thermotechnik-ag.json');

const COMPANY_KEY = 'bosch-thermotechnik-ag';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Bosch Thermotechnik AG';
const COMPANY_HOST = 'jobs.bosch.com';
const COMPANY_DOMAIN = 'bosch.ch';
const CAREERS_URL = 'https://jobs.bosch.com/en/?country=ch';
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

function toIsoDate(raw = '') {
  const value = String(raw || '').trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
    const [mm, dd, yyyy] = value.split('/');
    return `${yyyy}-${mm}-${dd}`;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
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

async function fetchRenderedBoschListings() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
    });
    await page.goto(CAREERS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const declineCookies = page.getByRole('button', { name: /decline|reject|only necessary/i });
    if (await declineCookies.count()) {
      try {
        await declineCookies.first().click({ timeout: 2000 });
      } catch {}
    }
    await page.waitForSelector('a[href*="/job/"]', { timeout: 20000 });
    await page.waitForTimeout(1500);
    return await page.content();
  } finally {
    await browser.close();
  }
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return key === COMPANY_KEY || company.includes('bosch thermotechnik') || url.includes('jobs.bosch.com/en/job/');
}

async function fetchBoschListings() {
  console.log('🔍 Fetching Bosch jobs from career portal...');
  let html = await fetchText(CAREERS_URL);
  let discovered = parseBoschListingsPage(html);
  if (!discovered.length) {
    console.log('🌐 Browser fallback: rendering Bosch listing page...');
    html = await fetchRenderedBoschListings();
    discovered = parseBoschListingsPage(html);
  }
  const seen = new Set();
  discovered = discovered.filter((row) => {
    if (seen.has(row.url)) return false;
    seen.add(row.url);
    return true;
  });
  const target = discovered.filter(isBoschTargetListing);
  console.log(`📋 Total CH jobs discovered: ${discovered.length}`);
  console.log(`📋 Ticino/Grigioni rows: ${target.length}`);
  for (const row of target) console.log(`  📄 ${row.title} (${row.location})`);
  // Fail only if the site is unreachable (0 CH jobs) — a genuine crawler error.
  // 0 Ticino/Grigioni results is valid when Bosch has no current openings in the region.
  if (discovered.length < 1) throw new Error(`Bosch career portal unreachable or returned 0 CH jobs — possible site change or network error`);
  if (target.length < 1) console.log('ℹ️  No Bosch jobs in Ticino/Grigioni today — skipping (not an error)');
  return target;
}

async function buildBoschJob(listing) {
  const html = await fetchText(listing.url);
  const detail = parseBoschJobDetail(html);
  const localized = buildBoschLocalizedContent(detail);
  return {
    title: localized.titleByLocale.it || detail.title || listing.title,
    slug: localized.slugByLocale.it,
    url: listing.url,
    applyUrl: detail.applyUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: detail.location || listing.location || 'Rivera',
    addressLocality: detail.location || listing.location || 'Rivera',
    addressRegion: detail.canton || DEFAULT_CANTON,
    addressCountry: 'CH',
    canton: detail.canton || DEFAULT_CANTON,
    country: 'CH',
    employmentType: normalize(detail.employmentType).includes('part') ? 'part-time' : 'full-time',
    contractType: normalize(detail.employmentType).includes('part') ? 'part-time' : 'full-time',
    category: inferBoschCategory(detail),
    sector: 'Energia',
    source: 'bosch-dedicated-crawler',
    sourceLang: detectLang(detail.description || '', 'it'),
    postedDate: toIsoDate(listing.postedDate),
    validThrough: '',
    description: detail.description,
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
  printCrawlChangeSummary(diff, 'Bosch Thermotechnik AG');
  writeCrawlChangeSummaryToGH(diff, 'Bosch Thermotechnik AG');
  writeJobsSummary(mergedTarget, 'Bosch Thermotechnik AG');
  printPublishedJobUrls(mergedTarget, 'Bosch Thermotechnik AG');
  return { diff };
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
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated Bosch career crawler for Swiss vacancies, filtered with shared Ticino/Grigioni location matching and parsed from the Bosch job portal HTML.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_BOSCH_STRICT',
    label: 'Bosch Thermotechnik AG',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: ['it', 'en', 'de', 'fr'],
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Bosch Thermotechnik AG');
  console.log('═══════════════════════════════════════════════');
  console.log('  Bosch Thermotechnik AG — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  const listings = await fetchBoschListings();
  const jobs = [];
  for (const listing of listings) jobs.push(await buildBoschJob(listing));
  updateAdapterConfig(jobs);
  const { diff } = mergeJobs(jobs);
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });
  validateLocales();
  console.log(`🏢 Total Bosch jobs: ${jobs.length}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Bosch Thermotechnik AG',
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

main().catch((error) => {
  console.error(`❌ Bosch Thermotechnik AG crawler failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
