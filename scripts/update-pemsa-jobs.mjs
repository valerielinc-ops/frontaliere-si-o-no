#!/usr/bin/env node
/**
 * PEMSA — Dedicated Crawler
 *
 * Crawls https://www.pemsa.ch/it/le-nostre-offerte-di-lavoro/?_canton=125
 * 1. Fetches listing page (pre-filtered for Ticino) → extracts job URLs
 * 2. Fetches each detail page → extracts JSON-LD JobPosting
 * 3. Merges into data/jobs.json
 * 4. Updates adapter config
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
  parsePemsaListingPage,
  parsePemsaDetailPage,
  isPemsaTicinoRelevant,
  buildPemsaLocalizedContent,
} from './lib/pemsa-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'pemsa.json');

const COMPANY_KEY = 'pemsa';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'PEMSA';
const COMPANY_HOST = 'www.pemsa.ch';
const COMPANY_DOMAIN = 'pemsa.ch';
const CAREERS_URL = 'https://www.pemsa.ch/it/le-nostre-offerte-di-lavoro/?_canton=125';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
const DETAIL_DELAY_MS = 500;

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

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    company.includes('pemsa') ||
    url.includes('pemsa.ch')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'www.pemsa.ch' || host === 'pemsa.ch';
  } catch {
    return false;
  }
}

function inferCategory(title = '') {
  const h = normalize(title);
  if (/muratore|carpentiere|manovale|edil/i.test(h)) return 'edilizia';
  if (/idraulic|sanitari|riscaldamento|rvcs/i.test(h)) return 'impiantistica';
  if (/elettric/i.test(h)) return 'elettricità';
  if (/ferraiolo|metalcostruttore|saldatore/i.test(h)) return 'metallo';
  if (/meccanico|manutentore|montatore/i.test(h)) return 'meccanica';
  if (/giardiniere|gessatore|pittore|piastrellista|impermeabilizzat|copritetto|paviment/i.test(h)) return 'edilizia';
  if (/autista|rullista|macchinista|ponteggi/i.test(h)) return 'cantiere';
  if (/disegnatore|progettista/i.test(h)) return 'progettazione';
  if (/fresator/i.test(h)) return 'cantiere';
  return 'edilizia';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseDate(dateStr = '') {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
    return d.toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function buildPemsaJob(detail, url) {
  const city = detail.city || 'Ticino';
  const localized = buildPemsaLocalizedContent(detail);

  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url,
    applyUrl: url,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: city,
    addressLocality: city,
    addressRegion: detail.region || 'TI',
    addressCountry: detail.country || 'CH',
    canton: DEFAULT_CANTON,
    country: 'CH',
    category: inferCategory(detail.title),
    sector: 'Edilizia e tecnica',
    source: 'pemsa-dedicated-crawler',
    sourceLang: detectLang(detail.title, 'it'),
    postedDate: parseDate(detail.datePosted),
    employmentType: detail.employmentType?.toLowerCase().includes('part') ? 'part-time' : 'full-time',
    contractType: 'temporary',
    validThrough: detail.validThrough || '',
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
  printCrawlChangeSummary(diff, 'PEMSA');
  writeCrawlChangeSummaryToGH(diff, 'PEMSA');
  writeJobsSummary(mergedTarget, 'PEMSA');
  printPublishedJobUrls(mergedTarget, 'PEMSA');
  return { total: mergedTarget.length, added, updated, diff };
}

function updateAdapterConfig(jobs) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = {
      location: job.location,
      canton: DEFAULT_CANTON,
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
    notes: 'Dedicated PEMSA crawler. Listing page pre-filtered for Ticino (canton=125). Detail pages have JSON-LD JobPosting with full location data. Construction/trades staffing agency.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_PEMSA_STRICT',
    label: 'PEMSA',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_pemsa_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No PEMSA jobs found after dedicated crawl.',
    detectSourceLang: () => 'it',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'PEMSA');
  console.log('═══════════════════════════════════════════════');
  console.log('  PEMSA — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  console.log('🔍 Fetching PEMSA Ticino job listings...');
  const jobUrls = await parsePemsaListingPage(TIMEOUT_MS);
  console.log(`📋 Found ${jobUrls.length} job URLs on listing page`);

  if (jobUrls.length === 0) {
    console.log('⚠️ No job URLs found — skipping.');
    return;
  }

  // Fetch detail pages for JSON-LD
  console.log('\n📄 Fetching detail pages for job data...');
  const jobs = [];
  let skipped = 0;
  for (const url of jobUrls) {
    const detail = await parsePemsaDetailPage(url, TIMEOUT_MS);
    if (detail && detail.title && isPemsaTicinoRelevant(detail)) {
      console.log(`  ✅ ${detail.title} → ${detail.city || '?'} (${detail.region || '?'})`);
      jobs.push(buildPemsaJob(detail, url));
    } else if (detail) {
      console.log(`  ⏭️  ${detail.title} → ${detail.city || '?'} (${detail.region || '?'}) [skipped]`);
      skipped++;
    } else {
      console.log(`  ⚠️ ${url} → detail page failed`);
      skipped++;
    }
    if (jobs.length + skipped < jobUrls.length) await sleep(DETAIL_DELAY_MS);
  }

  console.log(`\n📍 Ticino-relevant: ${jobs.length} / ${jobUrls.length}`);

  if (jobs.length === 0) {
    console.log('⚠️ No Ticino-relevant jobs found — skipping.');
    return;
  }

  // Deduplicate by title + city
  const seenKeys = new Set();
  const deduplicated = [];
  for (const job of jobs) {
    const key = `${normalize(job.title)}|${normalize(job.location)}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      deduplicated.push(job);
    }
  }
  if (deduplicated.length < jobs.length) {
    console.log(`🔄 Deduplicated: ${jobs.length} → ${deduplicated.length} unique`);
  }

  const { total, added, updated, diff} = mergeJobs(deduplicated);
  updateAdapterConfig(deduplicated);

  console.log('\n🌐 Running locale fill for PEMSA jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n📊 === PEMSA Job Stats ===');
  console.log(`  🏢 Total PEMSA jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'PEMSA',
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
  console.error(`❌ PEMSA crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
