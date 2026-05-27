#!/usr/bin/env node
/**
 * Convit Holding GmbH — Dedicated Crawler (TI + GR)
 *
 * Crawls https://www.careers-page.com/convit-holding-gmbh (Manatal ATS)
 * 1. Fetches listing page → extracts job codes
 * 2. Fetches each detail page → extracts title, location, description, date from JSON-LD
 * 3. Filters TI/GR-relevant jobs via shared geographic filter
 * 4. Assigns canton dynamically using inferConvitCanton()
 * 5. Merges into data/jobs.json
 * 6. Updates adapter config
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
  parseConvitListingPage,
  parseConvitDetailPage,
  buildConvitLocalizedContent,
  isConvitTicinoRelevant,
  inferConvitCanton,
} from './lib/convit-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'convit-holding.json');

const COMPANY_KEY = 'convit-holding';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Convit Holding GmbH';
const COMPANY_HOST = 'www.careers-page.com';
const COMPANY_DOMAIN = 'careers-page.com';
const CAREERS_URL = 'https://www.careers-page.com/convit-holding-gmbh';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
const MAX_DETAIL_PAGES = Number(process.env.CONVIT_MAX_DETAIL_PAGES) || 60;
const DETAIL_DELAY_MS = 800;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    company.includes('convit') ||
    url.includes('careers-page.com/convit-holding')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'www.careers-page.com' || host === 'careers-page.com';
  } catch {
    return false;
  }
}

function inferCategory(title = '') {
  const haystack = normalize(title);
  if (/finanz|financial|pianificaz|budgeting/i.test(haystack)) return 'finance';
  if (/sales|vendita|consulen|consultant/i.test(haystack)) return 'sales';
  if (/tirocinante|stage|intern|junior/i.test(haystack)) return 'internship';
  if (/marketing|communication/i.test(haystack)) return 'marketing';
  if (/admin|segretari|assistente/i.test(haystack)) return 'admin';
  return 'finance';
}

async function fetchAllListings() {
  console.log('🔍 Fetching Convit listing page...');

  // Manatal paginates — fetch multiple pages until no more jobs
  const allItems = [];
  const seenCodes = new Set();
  let page = 1;

  while (true) {
    const url = page === 1 ? CAREERS_URL : `${CAREERS_URL}?page=${page}`;
    console.log(`  📄 Page ${page}: ${url}`);
    let html;
    try {
      html = await fetchText(url);
    } catch (err) {
      console.log(`  ⚠️ Page ${page} fetch failed: ${err.message}`);
      break;
    }
    const items = parseConvitListingPage(html);
    const newItems = items.filter((item) => !seenCodes.has(item.code));
    if (newItems.length === 0) break;
    for (const item of newItems) {
      seenCodes.add(item.code);
      allItems.push(item);
    }
    console.log(`     Found ${newItems.length} new jobs (total: ${allItems.length})`);
    page += 1;
    await sleep(DETAIL_DELAY_MS);
  }

  console.log(`📋 Total unique listings: ${allItems.length}`);
  return allItems;
}

async function enrichWithDetails(listings) {
  const enriched = [];
  const toFetch = listings.slice(0, MAX_DETAIL_PAGES);

  console.log(`\n🔎 Fetching up to ${toFetch.length} detail pages...`);

  for (let i = 0; i < toFetch.length; i++) {
    const item = toFetch[i];
    try {
      const html = await fetchText(item.detailUrl);
      const detail = parseConvitDetailPage(html, item.title);
      enriched.push({
        ...item,
        title: detail.title || item.title,
        location: detail.location || '',
        description: detail.description || '',
        datePosted: detail.datePosted,
      });
      if ((i + 1) % 10 === 0) {
        console.log(`  ✅ ${i + 1}/${toFetch.length} detail pages fetched`);
      }
    } catch (err) {
      console.log(`  ⚠️ Detail fetch failed for ${item.code}: ${err.message}`);
      enriched.push({ ...item, location: '', description: '', datePosted: new Date().toISOString().slice(0, 10) });
    }
    if (i < toFetch.length - 1) await sleep(DETAIL_DELAY_MS);
  }

  // Filter to TI/GR-relevant only and assign canton
  const relevant = enriched.filter((job) => isConvitTicinoRelevant(job.location));
  for (const job of relevant) {
    job.canton = inferConvitCanton(job.location);
  }
  const tiCount = relevant.filter((j) => j.canton === 'TI').length;
  const grCount = relevant.filter((j) => j.canton === 'GR').length;
  console.log(`\n📍 TI/GR-relevant jobs: ${relevant.length} / ${enriched.length} (TI: ${tiCount}, GR: ${grCount})`);
  return relevant;
}

function buildConvitJob(row) {
  const canton = row.canton || inferConvitCanton(row.location) || DEFAULT_CANTON;
  const localized = buildConvitLocalizedContent({ ...row, canton });
  const defaultCity = canton === 'GR' ? 'Graubünden' : 'Massagno';
  const urlHash = createHash('sha1').update(row.detailUrl || row.title || '').digest('hex').slice(0, 12);
  return {
    id: `convit-${urlHash}`,
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: row.detailUrl,
    applyUrl: row.applyUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: row.location || defaultCity,
    addressLocality: row.location || defaultCity,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferCategory(row.title),
    sector: 'Finanza & Previdenza',
    source: 'convit-dedicated-crawler',
    sourceLang: detectLang(`${row.title} ${row.description}`, 'it'),
    postedDate: row.datePosted || new Date().toISOString().slice(0, 10),
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
  printCrawlChangeSummary(diff, 'Convit Holding');
  writeCrawlChangeSummaryToGH(diff, 'Convit Holding');
  writeJobsSummary(mergedTarget, 'Convit Holding');
  printPublishedJobUrls(mergedTarget, 'Convit Holding');
  return { total: mergedTarget.length, added, updated, diff };
}

function updateAdapterConfig(jobs) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = {
      location: job.location,
      canton: job.canton || DEFAULT_CANTON,
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
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated Convit Holding crawler reads the Manatal (careers-page.com) listing and detail pages, extracting JobPosting JSON-LD. Keeps TI + GR vacancies.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_CONVIT_STRICT',
    label: 'Convit Holding',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_convit_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Convit jobs found after dedicated crawl.',
    detectSourceLang: () => 'it',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Convit Holding');
  console.log('═══════════════════════════════════════════════');
  console.log('  Convit Holding GmbH — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const listings = await fetchAllListings();
  if (listings.length === 0) {
    console.log('⚠️ No listings found on Convit careers page — skipping.');
    return;
  }

  const enrichedListings = await enrichWithDetails(listings);

  // Deduplicate by title (Convit posts many duplicates for different regions)
  const seenTitles = new Map();
  const deduplicated = [];
  for (const listing of enrichedListings) {
    const key = normalize(listing.title);
    if (!seenTitles.has(key)) {
      seenTitles.set(key, listing);
      deduplicated.push(listing);
    }
  }
  if (deduplicated.length < enrichedListings.length) {
    console.log(`🔄 Deduplicated: ${enrichedListings.length} → ${deduplicated.length} unique titles`);
  }

  const jobs = deduplicated.map(buildConvitJob);

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Convit jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n📊 === Convit Holding Job Stats ===');
  const tiCount = jobs.filter((j) => j.canton === 'TI').length;
  const grCount = jobs.filter((j) => j.canton === 'GR').length;
  console.log(`  🏢 Total Convit jobs (TI+GR): ${total}`);
  console.log(`  📍 TI: ${tiCount} | GR: ${grCount}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Convit Holding',
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
  console.error(`❌ Convit Holding crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
