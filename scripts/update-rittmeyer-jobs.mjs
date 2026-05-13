#!/usr/bin/env node
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
  parseRittmeyerListingsPage,
  parseRittmeyerJobDetail,
  isRittmeyerTicinoListing,
  buildRittmeyerLocalizedContent,
} from './lib/rittmeyer-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'rittmeyer-ag.json');

const COMPANY_KEY = 'rittmeyer-ag';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Rittmeyer AG';
const COMPANY_HOST = 'karriere.rittmeyer.com';
const COMPANY_DOMAIN = 'rittmeyer.com';
const CAREERS_URL = 'https://karriere.rittmeyer.com/offene-stellen/?suche=&location=23&country=1';
const DETAIL_BASE = 'https://karriere.rittmeyer.com';
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

function absoluteUrl(raw = '') {
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return new URL(raw, DETAIL_BASE).toString();
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return key === COMPANY_KEY || company.includes('rittmeyer') || url.includes('karriere.rittmeyer.com/offene-stellen/');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'karriere.rittmeyer.com' || host.endsWith('.rittmeyer.com') || host === 'rittmeyer.com';
  } catch {
    return false;
  }
}

async function fetchListings() {
  console.log('🔍 Fetching Rittmeyer jobs from careers page...');
  const html = await fetchText(CAREERS_URL);
  const rows = parseRittmeyerListingsPage(html).filter(isRittmeyerTicinoListing);
  console.log(`📋 Matching Ticino listing rows: ${rows.length}`);
  for (const row of rows) {
    console.log(`  📄 ${row.title}`);
  }
  if (rows.length < 1) {
    throw new Error(`Expected at least 1 Rittmeyer Ticino job, found ${rows.length}`);
  }
  return rows;
}

function inferCategory(detail = {}) {
  const haystack = normalize([detail.title, detail.area, detail.summary].filter(Boolean).join(' '));
  if (haystack.includes('sales')) return 'sales';
  if (haystack.includes('engineer')) return 'engineering';
  return 'other';
}

async function buildRittmeyerJob(listing) {
  const detailUrl = absoluteUrl(listing.href);
  const html = await fetchText(detailUrl);
  const detail = parseRittmeyerJobDetail(html);
  const localized = buildRittmeyerLocalizedContent(detail);
  return {
    title: localized.titleByLocale.it || detail.title,
    slug: localized.slugByLocale.it,
    url: detailUrl,
    applyUrl: detail.applyUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: 'Camorino',
    addressLocality: 'Camorino',
    addressRegion: 'TI',
    addressCountry: 'CH',
    canton: DEFAULT_CANTON,
    country: 'CH',
    category: inferCategory(detail),
    sector: 'Energia',
    source: 'rittmeyer-dedicated-crawler',
    sourceLang: detectLang(detail.summary || localized.descriptionByLocale.it || '', 'it'),
    postedDate: new Date().toISOString().slice(0, 10),
    employmentType: detail.workload && detail.workload.includes('80') ? 'full-time' : 'other',
    contractType: detail.workload && detail.workload.includes('80') ? 'full-time' : 'other',
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
  printCrawlChangeSummary(diff, 'Rittmeyer AG');
  writeCrawlChangeSummaryToGH(diff, 'Rittmeyer AG');
  writeJobsSummary(mergedTarget, 'Rittmeyer AG');
  printPublishedJobUrls(mergedTarget, 'Rittmeyer AG');
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
    priority: 14,
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated Rittmeyer crawler parses the Rittmeyer careers page and keeps the Ticino vacancy exposed on the filtered public listing.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_RITTMEYER_STRICT',
    label: 'Rittmeyer AG',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_rittmeyer_domain',
    failWhenNoJobs: true,
    noJobsMessage: 'No Rittmeyer jobs found after dedicated crawl.',
    detectSourceLang: (text) => detectLang(text, 'it'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Rittmeyer AG');
  console.log('═══════════════════════════════════════════════');
  console.log('  Rittmeyer AG — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const listings = await fetchListings();
  const jobs = [];
  for (const listing of listings) {
    jobs.push(await buildRittmeyerJob(listing));
  }
  const { total, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Rittmeyer jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();
  console.log(`\n✅ Rittmeyer crawler complete (${total} jobs).`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Rittmeyer AG',
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
  console.error(`❌ Rittmeyer crawler failed: ${err?.message || err}`);
  process.exit(1);
});
