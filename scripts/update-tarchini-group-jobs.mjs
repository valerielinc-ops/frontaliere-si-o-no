#!/usr/bin/env node
/**
 * Tarchini Group — Dedicated Crawler
 *
 * Crawls https://www.tarchinigroup.com/it/lavora-con-noi
 * 1. Fetches listing page → extracts /it/work/{id}/{slug} links
 * 2. Fetches each detail page → extracts description + location
 * 3. All jobs are Ticino-relevant (group operates only in TI)
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
  parseTarchiniListingPage,
  parseTarchiniDetailPage,
  buildTarchiniLocalizedContent,
  inferTarchiniCanton,
} from './lib/tarchini-group-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'tarchini-group.json');

const COMPANY_KEY = 'tarchini-group';
const COMPANY_NAME = 'Tarchini Group';
const COMPANY_HOST = 'www.tarchinigroup.com';
const COMPANY_DOMAIN = 'tarchinigroup.com';
const CAREERS_URL = 'https://www.tarchinigroup.com/it/lavora-con-noi';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
const MAX_DETAIL_PAGES = Number(process.env.TARCHINI_MAX_DETAIL_PAGES) || 20;
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
        Accept: 'text/html',
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
    key === 'tarchini-consulting' ||
    company === 'tarchini group' ||
    company === 'tarchini consulting sa' ||
    url.includes('tarchinigroup.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.endsWith('tarchinigroup.com');
  } catch {
    return false;
  }
}

function inferCategory(title = '') {
  const haystack = normalize(title);
  if (/immobiliare|immobili/i.test(haystack)) return 'sales';
  if (/facility|manutent|tecnico/i.test(haystack)) return 'technician';
  if (/manager|responsabile|dirett/i.test(haystack)) return 'management';
  if (/sales|commerciale|vendita/i.test(haystack)) return 'sales';
  if (/investiment|finanz/i.test(haystack)) return 'finance';
  if (/admin|segretari|contabil/i.test(haystack)) return 'admin';
  if (/marketing|comunicazion/i.test(haystack)) return 'marketing';
  return 'admin';
}

function inferSector() {
  return 'Immobiliare';
}

async function fetchAllListings() {
  console.log('🔍 Fetching Tarchini Group job listings...');
  console.log(`  📡 ${CAREERS_URL}`);

  const html = await fetchText(CAREERS_URL);
  const { items } = parseTarchiniListingPage(html);

  console.log(`📋 Found ${items.length} job listings`);
  return items;
}

async function enrichWithDetails(listings) {
  const toFetch = listings.slice(0, MAX_DETAIL_PAGES);
  const enriched = [];

  console.log(`\n🔎 Fetching ${toFetch.length} detail pages...`);

  for (let i = 0; i < toFetch.length; i++) {
    const item = toFetch[i];
    try {
      const html = await fetchText(item.detailUrl);
      const detail = parseTarchiniDetailPage(html);
      enriched.push({
        ...item,
        description: detail.description || '',
        applyEmail: detail.applyEmail || 'risorseumane@tarchinigroup.com',
        location: detail.location || 'Manno',
      });
      console.log(`  ✅ ${i + 1}/${toFetch.length}: ${item.title} (${detail.location || 'Manno'})`);
    } catch (err) {
      console.log(`  ⚠️ Detail fetch failed for ${item.jobId}: ${err.message}`);
      enriched.push({
        ...item,
        description: '',
        applyEmail: 'risorseumane@tarchinigroup.com',
        location: 'Manno',
      });
    }
    if (i < toFetch.length - 1) await sleep(DETAIL_DELAY_MS);
  }

  return enriched;
}

function buildTarchiniJob(row) {
  const localized = buildTarchiniLocalizedContent(row);
  const canton = inferTarchiniCanton(row.location);
  const applyUrl = `mailto:${row.applyEmail || 'risorseumane@tarchinigroup.com'}?subject=${encodeURIComponent(row.title)}`;
  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: row.detailUrl,
    applyUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: row.location || 'Manno',
    addressLocality: row.location || 'Manno',
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferCategory(row.title),
    sector: inferSector(),
    source: 'tarchini-group-dedicated-crawler',
    sourceLang: detectLang(`${row.title} ${row.description}`, 'it'),
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
  printCrawlChangeSummary(diff, 'Tarchini Group');
  writeCrawlChangeSummaryToGH(diff, 'Tarchini Group');
  writeJobsSummary(mergedTarget, 'Tarchini Group');
  printPublishedJobUrls(mergedTarget, 'Tarchini Group');
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
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated Tarchini Group crawler. Static HTML site (REDESIGN CMS). Job listings at /it/lavora-con-noi, detail pages at /it/work/{id}/{slug}. Apply via email (risorseumane@tarchinigroup.com). Real estate group based in Manno (TI), also manages FoxTown Mendrisio.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_TARCHINI_STRICT',
    label: 'Tarchini Group',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_tarchini_domain',
    failWhenNoJobs: false,
    maxToleratedMissingDescriptions: 10,
    noJobsMessage: 'No Tarchini Group jobs found after dedicated crawl.',
    detectSourceLang: () => 'it',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Tarchini Group');
  console.log('═══════════════════════════════════════════════');
  console.log('  Tarchini Group — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const listings = await fetchAllListings();
  if (listings.length === 0) {
    console.log('⚠️ No job listings found — skipping.');
    return;
  }

  const enrichedListings = await enrichWithDetails(listings);
  const jobs = enrichedListings.map(buildTarchiniJob);

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Tarchini Group jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n📊 === Tarchini Group Job Stats ===');
  console.log(`  🏢 Total Tarchini Group jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Tarchini Group',
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
  console.error(`❌ Tarchini Group crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
