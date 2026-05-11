#!/usr/bin/env node
/**
 * PwC Switzerland — Dedicated Crawler
 *
 * Crawls PwC Switzerland careers via Prospective.ch API:
 *   https://ohws.prospective.ch/public/v1/medium/1000311/jobs?lang=en&offset=0&limit=500
 *
 * 1. Fetches all PwC job listings via JSON API (medium 1000311)
 * 2. All data is in the API response (no detail page fetching needed)
 * 3. Crawls ALL jobs (canton filter in frontend handles geographic filtering)
 * 4. Merges into data/jobs.json
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
  isLocationExplicitlyForeign,
} from './lib/dedicated-crawler-common.mjs';
import {
  parsePwcJobs,
  inferPwcCategory,
  buildPwcLocalizedContent,
} from './lib/pwc-job-parser.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'pwc.json');

const COMPANY_KEY = 'pwc';
const COMPANY_NAME = 'PwC Switzerland';
const COMPANY_HOST = 'www.pwc.ch';
const COMPANY_DOMAIN = 'pwc.ch';
const CAREERS_URL = 'https://www.pwc.ch/en/careers-with-pwc/open-positions.html';
const API_URL = 'https://ohws.prospective.ch/public/v1/medium/1000311/jobs?lang=en&offset=0&limit=500';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 25000;

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

async function fetchJson(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
        Origin: 'https://www.pwc.ch',
        Referer: 'https://www.pwc.ch/',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    key === 'pwc-switzerland' ||
    company.includes('pwc') ||
    url.includes('pwc.ch')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.endsWith('pwc.ch') || host.endsWith('prospective.ch');
  } catch {
    return false;
  }
}

async function fetchAllListings() {
  console.log('Fetching PwC Switzerland job listings via Prospective API...');
  console.log(`  API: ${API_URL}`);

  const data = await fetchJson(API_URL);
  const { items, total } = parsePwcJobs(data);

  console.log(`API returned ${total} PwC jobs total`);
  console.log(`Parsed ${items.length} job items`);

  return items;
}

function buildPwcJob(row) {
  const city = row._explodedCity || row.city || row.location || 'Switzerland';
  const canton = inferAnyCanton(city) || '';
  const localized = buildPwcLocalizedContent({ ...row, city });
  const detailUrl = row.directLink || CAREERS_URL;
  const applyUrl = row.applyUrl || row.directLink || CAREERS_URL;

  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: detailUrl,
    applyUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: city,
    addressLocality: city,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferPwcCategory(row.title, row.description),
    sector: 'Consulenza',
    source: 'pwc-dedicated-crawler',
    sourceLang: detectLang(`${row.title} ${row.description}`, row.language || 'en'),
    postedDate: row.startDate ? row.startDate.slice(0, 10) : new Date().toISOString().slice(0, 10),
    validThrough: row.endDate ? row.endDate.slice(0, 10) : '',
    employmentType: row.employmentType || 'full-time',
    contractType: row.employmentType || 'full-time',
    description: localized.descriptionByLocale.it,
    titleByLocale: localized.titleByLocale,
    descriptionByLocale: localized.descriptionByLocale,
    slugByLocale: localized.slugByLocale,
  };
}

function jobMatchKey(job = {}) {
  const url = String(job.url || '').trim().toLowerCase();
  const city = String(job.addressLocality || job.location || '').trim().toLowerCase();
  if (url) return `${url}#${city}`;
  return String(job.slug || '').trim().toLowerCase();
}

function dedupeCitiesByCanton(cities) {
  const seen = new Set();
  const result = [];
  for (const raw of cities) {
    const c = String(raw || '').trim();
    if (!c) continue;
    const canton = inferAnyCanton(c);
    const key = canton || c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c);
  }
  return result;
}

function explodeListings(listings) {
  const exploded = [];
  for (const row of listings) {
    const candidates = [row.city, ...(row.locationAttrs || [])].filter(Boolean);
    const cities = dedupeCitiesByCanton(candidates);
    if (cities.length === 0) cities.push(row.city || row.location || 'Switzerland');
    for (const city of cities) {
      exploded.push({ ...row, _explodedCity: city });
    }
  }
  return exploded;
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
  printCrawlChangeSummary(diff, 'PwC');
  writeCrawlChangeSummaryToGH(diff, 'PwC');
  writeJobsSummary(mergedTarget, 'PwC');
  printPublishedJobUrls(mergedTarget, 'PwC');
  return { total: mergedTarget.length, added, updated, diff };
}

function updateAdapterConfig(jobs) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = {
      location: job.location,
      canton: job.canton || '',
      company: COMPANY_NAME,
      postedDate: job.postedDate,
    };
  }
  writeJson(ADAPTER_PATH, {
    companyKey: COMPANY_KEY,
    companyName: COMPANY_NAME,
    companyHost: COMPANY_HOST,
    enabled: true,
    priority: 10,
    crawlerModes: ['api'],
    seedUrls: [API_URL],
    notes: 'Dedicated PwC Switzerland crawler. Uses Prospective.ch API (medium 1000311). Full job data in API response, no detail page fetching needed. Crawls ALL jobs; canton filter in frontend handles geographic filtering.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_PWC_STRICT',
    label: 'PwC Switzerland',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_pwc_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No PwC jobs found after dedicated crawl.',
    detectSourceLang: (job) => job.sourceLang || 'en',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'PwC Switzerland');
  console.log('===============================================');
  console.log('  PwC Switzerland — Dedicated Crawler');
  console.log('===============================================');
  console.log(`  API: ${API_URL}`);
  console.log(`  Careers: ${CAREERS_URL}\n`);

  const listings = await fetchAllListings();
  if (listings.length === 0) {
    console.log('No PwC jobs found — skipping.');
    return;
  }

  const explodedListings = explodeListings(listings);
  if (explodedListings.length !== listings.length) {
    console.log(`🏙️  Multi-location explosion: ${listings.length} listings → ${explodedListings.length} per-city records`);
  }
  const allBuilt = explodedListings.map(buildPwcJob);
  const jobs = allBuilt.filter((job) => {
    const loc = String(job.addressLocality || job.location || '');
    if (isLocationExplicitlyForeign(loc)) {
      console.log(`  ⏭️  Skipped foreign location: ${loc} — ${job.title}`);
      return false;
    }
    return true;
  });
  if (jobs.length < allBuilt.length) {
    console.log(`🌍 Foreign location filter: ${allBuilt.length} → ${jobs.length} Swiss jobs`);
  }

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\nRunning locale fill for PwC jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n=== PwC Switzerland Job Stats ===');
  console.log(`  Total PwC jobs: ${total}`);
  console.log(`  Added: ${added}`);
  console.log(`  Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'PwC Switzerland',
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
  console.error(`PwC crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
