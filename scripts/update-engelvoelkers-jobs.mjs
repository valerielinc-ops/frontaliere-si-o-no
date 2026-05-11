#!/usr/bin/env node
/**
 * Engel & Völkers Switzerland — Dedicated Crawler
 *
 * Crawls https://www.engelvoelkers.com/ch/it/azienda/carriera/offerte-di-lavoro
 * 1. Fetches listing page → extracts job cards (title, location, company, UUID)
 * 2. Fetches each detail page → extracts rich description
 * 3. Filters Ticino-relevant jobs (Lugano, Ascona, Bellinzona, etc.)
 * 4. Merges into data/jobs.json
 * 5. Updates adapter config
 *
 * Note: The site is a Next.js SSR app. Pagination is client-side only,
 * so we parse whatever is server-rendered on the first page load.
 * Ticino jobs are typically from "Ticino Premium Properties SA".
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
  parseEngelvoelkersListingPage,
  parseEngelvoelkersDetailPage,
  buildEngelvoelkersLocalizedContent,
  isEngelvoelkersTicinoRelevant,
  inferEngelvoelkersCanton,
} from './lib/engelvoelkers-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'engel-voelkers.json');

const COMPANY_KEY = 'engel-voelkers';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Engel & Völkers';
const COMPANY_HOST = 'www.engelvoelkers.com';
const COMPANY_DOMAIN = 'engelvoelkers.com';
const CAREERS_URL = 'https://www.engelvoelkers.com/ch/it/azienda/carriera/offerte-di-lavoro';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 25000;
const MAX_DETAIL_PAGES = Number(process.env.ENGELVOELKERS_MAX_DETAIL_PAGES) || 30;
const DETAIL_DELAY_MS = 1200;

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
        'Accept-Language': 'it-CH,it;q=0.9,en;q=0.5',
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
    key === 'engel-volkers' ||
    key === 'ticino-premium-properties' ||
    company.includes('engel') && company.includes('völkers') ||
    company.includes('engel') && company.includes('volkers') ||
    company.includes('ticino premium properties') ||
    url.includes('engelvoelkers.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.endsWith('engelvoelkers.com');
  } catch {
    return false;
  }
}

function inferCategory(title = '', department = '') {
  const haystack = normalize(`${title} ${department}`);
  if (/marketing|communication|brand|content/i.test(haystack)) return 'marketing';
  if (/sales|vendita|account|immobilien.*makler|immobilien.*berater|consulen/i.test(haystack)) return 'sales';
  if (/technology|developer|engineer|software|it\b|devops/i.test(haystack)) return 'tech';
  if (/finance|legal|contabilit|buchhaltu/i.test(haystack)) return 'finance';
  if (/people|culture|hr\b|human/i.test(haystack)) return 'hr';
  if (/stage|intern|tirocinante|junior|trainee|apprentice/i.test(haystack)) return 'internship';
  if (/admin|segretari|assistente|office/i.test(haystack)) return 'admin';
  return 'real-estate';
}

function inferEmploymentType(rawType = '') {
  const t = normalize(rawType);
  if (/stage|intern/i.test(t)) return 'internship';
  if (/temporar/i.test(t)) return 'temporary';
  if (/apprendista|apprentice/i.test(t)) return 'apprenticeship';
  if (/part[\s-]?time/i.test(t)) return 'part-time';
  return 'full-time';
}

async function fetchAllListings() {
  console.log('🔍 Fetching Engel & Völkers listing page...');
  console.log(`  📄 URL: ${CAREERS_URL}`);

  let html;
  try {
    html = await fetchText(CAREERS_URL);
  } catch (err) {
    console.log(`  ⚠️ Listing page fetch failed: ${err.message}`);
    return [];
  }

  const items = parseEngelvoelkersListingPage(html);
  console.log(`📋 Total listings found on page: ${items.length}`);

  // Log all found jobs for debugging
  for (const item of items) {
    const loc = item.location || '(no location)';
    const comp = item.company || '(no company)';
    console.log(`  • ${item.title} — ${loc} — ${comp}`);
  }

  return items;
}

async function enrichWithDetails(listings) {
  const enriched = [];
  const toFetch = listings.slice(0, MAX_DETAIL_PAGES);

  console.log(`\n🔎 Fetching up to ${toFetch.length} detail pages...`);

  for (let i = 0; i < toFetch.length; i++) {
    const item = toFetch[i];
    try {
      const html = await fetchText(item.detailUrl);
      const detail = parseEngelvoelkersDetailPage(html, item.title);
      enriched.push({
        ...item,
        title: detail.title || item.title,
        description: detail.description || '',
        datePosted: detail.datePosted,
      });
      if ((i + 1) % 5 === 0) {
        console.log(`  ✅ ${i + 1}/${toFetch.length} detail pages fetched`);
      }
    } catch (err) {
      console.log(`  ⚠️ Detail fetch failed for ${item.uuid}: ${err.message}`);
      enriched.push({
        ...item,
        description: '',
        datePosted: new Date().toISOString().slice(0, 10),
      });
    }
    if (i < toFetch.length - 1) await sleep(DETAIL_DELAY_MS);
  }

  // Filter to TI/GR-relevant and assign canton
  const relevant = enriched.filter((job) =>
    isEngelvoelkersTicinoRelevant(job.location, job.company),
  );
  for (const job of relevant) {
    job.canton = inferEngelvoelkersCanton(job.location, job.company);
  }
  const tiCount = relevant.filter((j) => j.canton === 'TI').length;
  const grCount = relevant.filter((j) => j.canton === 'GR').length;
  console.log(`\n📍 TI/GR-relevant jobs: ${relevant.length} / ${enriched.length} (TI: ${tiCount}, GR: ${grCount})`);
  for (const job of relevant) {
    console.log(`  ✓ ${job.title} — ${job.location} — ${job.company} [${job.canton}]`);
  }
  return relevant;
}

function buildJob(row) {
  const canton = row.canton || inferEngelvoelkersCanton(row.location, row.company);
  const localized = buildEngelvoelkersLocalizedContent({ ...row, canton });
  const defaultCity = canton === 'GR' ? 'Graubünden' : 'Lugano';
  const locationClean = String(row.location || '').replace(/,?\s*Switzerland$/i, '').trim() || defaultCity;

  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: row.detailUrl,
    applyUrl: row.detailUrl,
    company: row.company || COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: locationClean,
    addressLocality: locationClean,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferCategory(row.title, row.department || ''),
    sector: 'Immobiliare',
    source: 'engelvoelkers-dedicated-crawler',
    sourceLang: detectLang(`${row.title} ${row.description}`, 'it'),
    postedDate: row.datePosted || new Date().toISOString().slice(0, 10),
    employmentType: inferEmploymentType(row.employmentType || ''),
    contractType: inferEmploymentType(row.employmentType || ''),
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
  printCrawlChangeSummary(diff, 'Engel & Völkers');
  writeCrawlChangeSummaryToGH(diff, 'Engel & Völkers');
  writeJobsSummary(mergedTarget, 'Engel & Völkers');
  printPublishedJobUrls(mergedTarget, 'Engel & Völkers');
  return { total: mergedTarget.length, added, updated, diff };
}

function updateAdapterConfig(jobs) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = {
      location: job.location,
      canton: job.canton || DEFAULT_CANTON,
      company: job.company || COMPANY_NAME,
      postedDate: job.postedDate,
    };
  }
  writeJson(ADAPTER_PATH, {
    companyKey: COMPANY_KEY,
    companyName: COMPANY_NAME,
    companyHost: COMPANY_HOST,
    enabled: true,
    priority: 12,
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated Engel & Völkers Switzerland crawler. Parses the Next.js SSR careers page HTML. Keeps TI + GR jobs from Ticino Premium Properties SA and other regional offices.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_ENGELVOELKERS_STRICT',
    label: 'Engel & Völkers',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_engelvoelkers_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Engel & Völkers TI/GR jobs found after dedicated crawl.',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Engel & Völkers');
  console.log('═══════════════════════════════════════════════');
  console.log('  Engel & Völkers — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const listings = await fetchAllListings();
  if (listings.length === 0) {
    console.log('⚠️ No listings found on Engel & Völkers careers page — skipping.');
    return;
  }

  const enrichedListings = await enrichWithDetails(listings);

  if (enrichedListings.length === 0) {
    console.log('ℹ️ No TI/GR-relevant jobs found at Engel & Völkers — nothing to merge.');
    return;
  }

  // Deduplicate by URL (UUID-based, should be unique)
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

  const jobs = deduplicated.map(buildJob);

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Engel & Völkers jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n📊 === Engel & Völkers Job Stats ===');
  const tiJobs = jobs.filter((j) => j.canton === 'TI').length;
  const grJobs = jobs.filter((j) => j.canton === 'GR').length;
  console.log(`  🏢 Total EV TI+GR jobs: ${total} (TI: ${tiJobs}, GR: ${grJobs})`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Engel & Völkers',
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
  console.error(`❌ Engel & Völkers crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
