#!/usr/bin/env node
/**
 * Boggi Milano — Dedicated Crawler
 *
 * Crawls https://boggimilano1.recruitee.com/api/offers (Recruitee JSON API)
 * 1. Fetches all offers via public API (no HTML parsing needed)
 * 2. Filters Swiss/Ticino-relevant jobs by country_code + location
 * 3. Transforms to standard job format with localized content
 * 4. Merges into data/jobs.json
 * 5. Updates adapter config
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
} from './jobs-url-helper.mjs';
import {
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
} from './lib/dedicated-crawler-common.mjs';
import {
  parseBoggiApiResponse,
  buildBoggiJobFromApi,
  buildBoggiLocalizedContent,
  inferBoggiCategory,
} from './lib/boggi-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'boggi-milano.json');

const COMPANY_KEY = 'boggi-milano';
const COMPANY_NAME = 'Boggi Milano';
const COMPANY_HOST = 'boggimilano1.recruitee.com';
const COMPANY_DOMAIN = 'recruitee.com';
const CAREERS_URL = 'https://boggimilano1.recruitee.com/l/it';
const API_URL = 'https://boggimilano1.recruitee.com/api/offers';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

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
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://www.frontaliereticino.ch/)',
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
    company.includes('boggi') ||
    url.includes('boggimilano1.recruitee.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'boggimilano1.recruitee.com' || host.endsWith('.recruitee.com');
  } catch {
    return false;
  }
}

async function fetchAllOffers() {
  console.log('🔍 Fetching Boggi Milano offers via Recruitee API...');
  console.log(`  📡 ${API_URL}`);

  const apiResponse = await fetchJson(API_URL);
  const allOffers = apiResponse?.offers || [];
  console.log(`  📋 Total offers from API: ${allOffers.length}`);

  const ticinoOffers = parseBoggiApiResponse(apiResponse);
  console.log(`  📍 Ticino/Swiss-relevant: ${ticinoOffers.length}`);

  return ticinoOffers;
}

function buildBoggiJob(offer) {
  const parsed = buildBoggiJobFromApi(offer);
  const localized = buildBoggiLocalizedContent(parsed);

  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: parsed.detailUrl,
    applyUrl: parsed.applyUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: parsed.location,
    addressLocality: parsed.city,
    addressRegion: 'TI',
    addressCountry: 'CH',
    canton: 'TI',
    country: 'CH',
    category: inferBoggiCategory(parsed.title, parsed.department),
    sector: 'Moda & Retail',
    source: 'boggi-dedicated-crawler',
    sourceLang: detectLang(`${parsed.title} ${parsed.description}`, 'it'),
    postedDate: parsed.datePosted,
    employmentType: parsed.employmentType,
    contractType: parsed.employmentType,
    validThrough: parsed.validThrough,
    description: localized.descriptionByLocale.it,
    titleByLocale: localized.titleByLocale,
    descriptionByLocale: localized.descriptionByLocale,
    slugByLocale: localized.slugByLocale,
  };
}

function jobMatchKey(job = {}) {
  return String(job.url || '').trim().toLowerCase() || String(job.slug || '').trim().toLowerCase();
}

function mergeJobs(discoveredJobs) {
  const existing = readJson(DATA_JOBS, []);
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
      titleByLocale: { ...(prev.titleByLocale || {}), ...(job.titleByLocale || {}) },
      descriptionByLocale: { ...(prev.descriptionByLocale || {}), ...(job.descriptionByLocale || {}) },
      slugByLocale: { ...(prev.slugByLocale || {}), ...(job.slugByLocale || {}) },
    };
  });

  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  writeJson(PUBLIC_JOBS, allJobs);

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'Boggi Milano');
  writeCrawlChangeSummaryToGH(diff, 'Boggi Milano');
  writeJobsSummary(mergedTarget, 'Boggi Milano');
  printPublishedJobUrls(mergedTarget, 'Boggi Milano');
  return { total: mergedTarget.length, added, updated };
}

function updateAdapterConfig(jobs) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = {
      location: job.location,
      canton: 'TI',
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
    crawlerModes: ['api'],
    seedUrls: [API_URL],
    notes: 'Dedicated Boggi Milano crawler uses the public Recruitee JSON API. Filters Swiss/Ticino jobs by country_code and location fields. No HTML parsing needed.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_BOGGI_STRICT',
    label: 'Boggi Milano',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_boggi_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Boggi Milano jobs found after dedicated crawl.',
    detectSourceLang: () => 'it',
  });
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Boggi Milano — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  API endpoint: ${API_URL}`);
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const ticinoOffers = await fetchAllOffers();
  if (ticinoOffers.length === 0) {
    console.log('⚠️ No Ticino offers found from Boggi Milano API — skipping.');
    return;
  }

  // Deduplicate by slug (shouldn't happen with API but safe)
  const seenSlugs = new Map();
  const deduplicated = [];
  for (const offer of ticinoOffers) {
    const key = normalize(offer.slug || offer.title || '');
    if (!seenSlugs.has(key)) {
      seenSlugs.set(key, offer);
      deduplicated.push(offer);
    }
  }
  if (deduplicated.length < ticinoOffers.length) {
    console.log(`🔄 Deduplicated: ${ticinoOffers.length} → ${deduplicated.length} unique offers`);
  }

  const jobs = deduplicated.map(buildBoggiJob);

  const { total, added, updated } = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Boggi Milano jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n📊 === Boggi Milano Job Stats ===');
  console.log(`  🏢 Total Boggi jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);
}

main().catch((error) => {
  console.error(`❌ Boggi Milano crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
