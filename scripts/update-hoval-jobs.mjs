#!/usr/bin/env node
/**
 * Hoval — Dedicated Crawler
 *
 * Crawls https://www.hoval.it/it_IT/jobs via SAP Hybris JSON API
 * 1. Fetches JSON listing API filtered by country=Switzerland
 * 2. Fetches each detail page → extracts description + apply URL
 * 3. Filters Ticino-relevant jobs
 * 4. Merges into data/jobs.json
 * 5. Updates adapter config
 */

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
  parseHovalListingJson,
  parseHovalDetailPage,
  buildHovalLocalizedContent,
  isHovalTicinoRelevant,
  inferHovalCanton,
} from './lib/hoval-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'hoval.json');

const COMPANY_KEY = 'hoval';
const COMPANY_NAME = 'Hoval';
const COMPANY_HOST = 'www.hoval.it';
const COMPANY_DOMAIN = 'hoval.it';
const CAREERS_URL = 'https://www.hoval.it/it_IT/jobs';
const LISTING_API = 'https://www.hoval.it/jobs/results?q=:sortIndex:country:Switzerland';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
const MAX_DETAIL_PAGES = Number(process.env.HOVAL_MAX_DETAIL_PAGES) || 30;
const DETAIL_DELAY_MS = 1000;

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

async function fetchText(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
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
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    company === 'hoval' ||
    url.includes('hoval.it/') ||
    url.includes('hoval.com/')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.endsWith('hoval.it') || host.endsWith('hoval.com');
  } catch {
    return false;
  }
}

function inferCategory(title = '', department = '') {
  const haystack = normalize(`${title} ${department}`);
  if (/it\b|software|system|engineer|developer|azure|sap/i.test(haystack)) return 'it';
  if (/service|techni|kundendienst|assistenza|tecnico/i.test(haystack)) return 'technician';
  if (/sales|vendita|verkauf|distribution|commercial/i.test(haystack)) return 'sales';
  if (/admin|segretari|office|front.*office|back.*office/i.test(haystack)) return 'admin';
  if (/produz|fabbricaz|production|manufactur/i.test(haystack)) return 'production';
  if (/finanz|financial|controlling|buchhalter/i.test(haystack)) return 'finance';
  if (/marketing|communicat/i.test(haystack)) return 'marketing';
  if (/r&s|ingegneria|r&d|engineer|entwickl/i.test(haystack)) return 'engineering';
  if (/formazione|ausbildung|apprendista|lehr/i.test(haystack)) return 'internship';
  return 'technician';
}

function inferSector(department = '') {
  const dept = normalize(department);
  if (/it|digitale/i.test(dept)) return 'IT & Digital';
  if (/service|assistenza|kundendienst/i.test(dept)) return 'Assistenza Tecnica';
  if (/vendite|sales|distribution/i.test(dept)) return 'Vendite';
  if (/amministrazione/i.test(dept)) return 'Amministrazione';
  if (/produzione|fabbricazione/i.test(dept)) return 'Produzione';
  if (/r&s|ingegneria|tecnologia/i.test(dept)) return 'Ingegneria';
  return 'Energia & Clima';
}

async function fetchAllListings() {
  console.log('🔍 Fetching Hoval Swiss jobs via JSON API...');
  console.log(`  📡 ${LISTING_API}`);

  const json = await fetchJson(LISTING_API);
  const { items, totalResults } = parseHovalListingJson(json);

  console.log(`📋 Total Swiss listings: ${totalResults} (parsed: ${items.length})`);
  return items;
}

async function enrichWithDetails(listings) {
  const toFetch = listings.slice(0, MAX_DETAIL_PAGES);
  const enriched = [];

  console.log(`\n🔎 Fetching up to ${toFetch.length} detail pages...`);

  for (let i = 0; i < toFetch.length; i++) {
    const item = toFetch[i];
    try {
      const html = await fetchText(item.detailUrl);
      const detail = parseHovalDetailPage(html);
      enriched.push({
        ...item,
        description: detail.description || '',
        applyUrl: detail.applyUrl || '',
      });
      if ((i + 1) % 5 === 0) {
        console.log(`  ✅ ${i + 1}/${toFetch.length} detail pages fetched`);
      }
    } catch (err) {
      console.log(`  ⚠️ Detail fetch failed for ${item.jobId}: ${err.message}`);
      enriched.push({ ...item, description: '', applyUrl: '' });
    }
    if (i < toFetch.length - 1) await sleep(DETAIL_DELAY_MS);
  }

  // Filter to Ticino-relevant only
  const ticino = enriched.filter((job) => isHovalTicinoRelevant(job.location));
  console.log(`\n📍 Ticino-relevant jobs: ${ticino.length} / ${enriched.length}`);
  return ticino;
}

function buildHovalJob(row) {
  const localized = buildHovalLocalizedContent(row);
  const canton = inferHovalCanton(row.location);
  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: row.detailUrl,
    applyUrl: row.applyUrl || '',
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: row.location || 'Switzerland',
    addressLocality: row.location || 'Switzerland',
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferCategory(row.title, row.department),
    sector: inferSector(row.department),
    source: 'hoval-dedicated-crawler',
    sourceLang: detectLang(`${row.title} ${row.description}`, row.language === 'Italiano' ? 'it' : row.language === 'German' ? 'de' : row.language === 'Francese' ? 'fr' : 'it'),
    postedDate: new Date().toISOString().slice(0, 10),
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
  printCrawlChangeSummary(diff, 'Hoval');
  writeCrawlChangeSummaryToGH(diff, 'Hoval');
  writeJobsSummary(mergedTarget, 'Hoval');
  printPublishedJobUrls(mergedTarget, 'Hoval');
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
    crawlerModes: ['api'],
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated Hoval crawler uses SAP Hybris JSON API (/jobs/results?q=:sortIndex:country:Switzerland) filtered by country. Extracts description from detail pages. ATS: Umantis (recruitingapp-2710.umantis.com).',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_HOVAL_STRICT',
    label: 'Hoval',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_hoval_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Hoval jobs found after dedicated crawl.',
    detectSourceLang: () => 'it',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Hoval');
  console.log('═══════════════════════════════════════════════');
  console.log('  Hoval — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}`);
  console.log(`  JSON API:     ${LISTING_API}\n`);

  const listings = await fetchAllListings();
  if (listings.length === 0) {
    console.log('⚠️ No Swiss listings found on Hoval JSON API — skipping.');
    return;
  }

  const enrichedListings = await enrichWithDetails(listings);

  // Deduplicate by detail URL
  const seenUrls = new Map();
  const deduplicated = [];
  for (const listing of enrichedListings) {
    const key = normalize(listing.detailUrl);
    if (!seenUrls.has(key)) {
      seenUrls.set(key, listing);
      deduplicated.push(listing);
    }
  }
  if (deduplicated.length < enrichedListings.length) {
    console.log(`🔄 Deduplicated: ${enrichedListings.length} → ${deduplicated.length} unique URLs`);
  }

  const jobs = deduplicated.map(buildHovalJob);

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Hoval jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n📊 === Hoval Job Stats ===');
  console.log(`  🏢 Total Hoval jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Hoval',
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
  console.error(`❌ Hoval crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
