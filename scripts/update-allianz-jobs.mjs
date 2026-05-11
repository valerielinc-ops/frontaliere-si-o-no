#!/usr/bin/env node
/**
 * Allianz Suisse — Dedicated Crawler
 *
 * Crawls https://recruitingapp-2872.umantis.com/Jobs/All (Abacus-Umantis ATS)
 * 1. POSTs listing page with Region Tessin + Region Graubünden filters → extracts vacancy IDs
 * 2. Fetches each detail page (Italian) → extracts title, location, description
 * 3. Filters TI/GR-relevant jobs (by agency, location, or shared geo filter)
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
  parseAllianzListingPage,
  parseAllianzDetailPage,
  buildAllianzLocalizedContent,
  inferAllianzCanton,
} from './lib/allianz-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'allianz-suisse.json');

const COMPANY_KEY = 'allianz-suisse';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Allianz Suisse';
const COMPANY_HOST = 'recruitingapp-2872.umantis.com';
const COMPANY_DOMAIN = 'umantis.com';
const CAREERS_URL = 'https://recruitingapp-2872.umantis.com/Jobs/All';
const LOCALES = ['it', 'en', 'de', 'fr'];

// Region filter IDs from Umantis ATS
const REGION_FILTERS = [
  { id: '38999405', label: 'Tessin', canton: 'TI' },
  { id: '38999401', label: 'Graubünden', canton: 'GR' },
];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
const MAX_DETAIL_PAGES = Number(process.env.ALLIANZ_MAX_DETAIL_PAGES) || 40;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || TIMEOUT_MS);
  try {
    const fetchOptions = {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereBot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'it-CH,it;q=0.9,de;q=0.5',
        ...(options.headers || {}),
      },
    };
    if (options.method) fetchOptions.method = options.method;
    if (options.body) {
      fetchOptions.body = options.body;
      fetchOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const resp = await fetch(url, fetchOptions);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    return await resp.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    key === 'allianz' ||
    company.includes('allianz suisse') ||
    url.includes('recruitingapp-2872.umantis.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'recruitingapp-2872.umantis.com';
  } catch {
    return false;
  }
}

function inferCategory(title = '') {
  const haystack = normalize(title);
  if (/previd|pension|vorsorge|prévoyance/i.test(haystack)) return 'insurance';
  if (/vendite|responsabile.*vend|sales|verkauf/i.test(haystack)) return 'sales';
  if (/consulen|berater|consult|conseill/i.test(haystack)) return 'sales';
  if (/innendienst|servizio interno|admin|back.?office/i.test(haystack)) return 'admin';
  if (/broker|makler/i.test(haystack)) return 'insurance';
  return 'insurance';
}

function inferLocation(listing, detail) {
  const loc = detail?.location || listing.location || '';
  if (loc) return loc;
  const agency = (detail?.agency || listing.agency || '').toLowerCase();
  if (agency.includes('bellinzona')) return 'Bellinzona';
  if (agency.includes('lugano')) return 'Lugano';
  if (agency.includes('chur') || agency.includes('graubünden')) return 'Chur';
  return '';
}

async function fetchAllListings() {
  console.log('🔍 Fetching Allianz Suisse listing pages (Tessin + Graubünden filters)...');

  const allItems = [];
  const seenIds = new Set();

  for (const region of REGION_FILTERS) {
    const filterBody = `searchSkill1004=${region.id}&Search=Suchen`;
    let page = 1;
    const maxPages = 10;

    console.log(`\n🔎 Region: ${region.label} (filter ID ${region.id})`);

    while (page <= maxPages) {
      const url = page === 1 ? CAREERS_URL : `${CAREERS_URL}?tc1152481=p${page}&_search_token1152481=*`;

      console.log(`  📄 Page ${page}: POST ${url}`);
      let html;
      try {
        html = await fetchText(url, { method: 'POST', body: filterBody });
      } catch (err) {
        console.log(`  ⚠️ Page ${page} fetch failed: ${err.message}`);
        break;
      }

      const items = parseAllianzListingPage(html);
      const newItems = items.filter((item) => !seenIds.has(item.vacancyId));
      if (newItems.length === 0) break;

      for (const item of newItems) {
        seenIds.add(item.vacancyId);
        allItems.push(item);
      }
      console.log(`     Found ${newItems.length} new jobs (total: ${allItems.length})`);

      if (items.length < 10) break;

      page += 1;
      await sleep(DETAIL_DELAY_MS);
    }
  }

  console.log(`\n📋 Total unique TI/GR listings: ${allItems.length}`);
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
      const detail = parseAllianzDetailPage(html, item.title, item.location);
      enriched.push({
        ...item,
        title: detail.title || item.title,
        agency: detail.agency || item.agency,
        location: inferLocation(item, detail),
        description: detail.description || '',
        contractType: detail.contractType || '',
      });
      console.log(`  ✅ [${i + 1}/${toFetch.length}] ${item.vacancyId}: ${detail.title || item.title} — ${inferLocation(item, detail)}`);
    } catch (err) {
      console.log(`  ⚠️ Detail fetch failed for ${item.vacancyId}: ${err.message}`);
      enriched.push({
        ...item,
        description: '',
        contractType: '',
      });
    }
    if (i < toFetch.length - 1) await sleep(DETAIL_DELAY_MS);
  }

  // Check TI/GR relevance after detail enrichment and assign canton
  const relevant = [];
  for (const job of enriched) {
    const canton = inferAllianzCanton(job.agency || '', job.location || '');
    if (canton) {
      job._canton = canton;
      relevant.push(job);
    }
  }
  const tiCount = relevant.filter((j) => j._canton === 'TI').length;
  const grCount = relevant.filter((j) => j._canton === 'GR').length;
  console.log(`\n📍 Target jobs after enrichment: ${relevant.length} / ${enriched.length} (TI: ${tiCount}, GR: ${grCount})`);
  return relevant;
}

function buildAllianzJob(row) {
  const localized = buildAllianzLocalizedContent(row);
  const location = row.location || '';
  const canton = row._canton || DEFAULT_CANTON;
  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: row.detailUrl,
    applyUrl: row.applyUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location,
    addressLocality: location,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferCategory(row.title),
    sector: 'Assicurazioni',
    source: 'allianz-dedicated-crawler',
    sourceLang: detectLang(`${row.title} ${row.description}`, 'it'),
    postedDate: new Date().toISOString().slice(0, 10),
    employmentType: 'full-time',
    contractType: row.contractType || 'full-time',
    validThrough: '',
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
      title: job.title || prev.title,
      description: job.description || prev.description,
      location: job.location || prev.location,
      addressLocality: job.addressLocality || prev.addressLocality,
      applyUrl: job.applyUrl || prev.applyUrl,
      postedDate: job.postedDate || prev.postedDate,
      contractType: job.contractType || prev.contractType,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, job.descriptionByLocale, 30),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3),
      source: job.source,
    };
  });

  const merged = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, merged);
  if (fs.existsSync(path.dirname(PUBLIC_JOBS))) {
    writeJson(PUBLIC_JOBS, merged);
  }

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'Allianz Suisse');
  writeCrawlChangeSummaryToGH(diff, 'Allianz Suisse');
  writeJobsSummary(mergedTarget, 'Allianz Suisse');
  printPublishedJobUrls(mergedTarget, 'Allianz Suisse');
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
    notes: 'Dedicated Allianz Suisse crawler POSTs the Umantis listing with Region Tessin + Region Graubünden filters, fetches Italian detail pages. Keeps TI/GR vacancies.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_ALLIANZ_STRICT',
    label: 'Allianz Suisse',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_allianz_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Allianz Suisse jobs found after dedicated crawl.',
    detectSourceLang: () => 'it',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Tessin');
  console.log('═══════════════════════════════════════════════');
  console.log('  Allianz Suisse — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const listings = await fetchAllListings();
  if (listings.length === 0) {
    console.log('⚠️ No TI/GR listings found on Allianz Suisse — skipping.');
    return;
  }

  const enrichedListings = await enrichWithDetails(listings);

  // Deduplicate by title (Allianz may list same role for different agencies)
  const seenTitles = new Map();
  const deduplicated = [];
  for (const listing of enrichedListings) {
    const key = normalize(listing.title) + '|' + normalize(listing.location);
    if (!seenTitles.has(key)) {
      seenTitles.set(key, listing);
      deduplicated.push(listing);
    }
  }
  if (deduplicated.length < enrichedListings.length) {
    console.log(`🔄 Deduplicated: ${enrichedListings.length} → ${deduplicated.length} unique title+location combinations`);
  }

  const jobs = deduplicated.map(buildAllianzJob);

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Allianz Suisse jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n📊 === Allianz Suisse Job Stats ===');
  console.log(`  🏢 Total Allianz Suisse jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Tessin',
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
  console.error(`❌ Allianz Suisse crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
