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
  isDamianiTicinoLocation,
  inferDamianiCanton,
  parseDamianiSearchPage,
  parseDamianiJobDetail,
  buildDamianiLocalizedContent,
  inferDamianiCategory,
} from './lib/damiani-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'damiani-group.json');

const COMPANY_KEY = 'damiani-group';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Damiani Group';
const COMPANY_HOST = 'careers.damianigroup.com';
const COMPANY_DOMAIN = 'damianigroup.com';
const CAREERS_URL = 'https://careers.damianigroup.com/search/?locale=it_IT';
const SEARCH_BASE = 'https://careers.damianigroup.com/search/?locale=it_IT';
const DETAIL_BASE = 'https://careers.damianigroup.com';
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

function toIsoDate(value = '') {
  const parsed = new Date(String(value || '').trim());
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

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return key === COMPANY_KEY || company.includes('damiani') || url.includes('careers.damianigroup.com/job/');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'careers.damianigroup.com' || host.endsWith('.damianigroup.com');
  } catch {
    return false;
  }
}

async function fetchDamianiListings() {
  console.log('🔍 Fetching Damiani jobs from SuccessFactors search...');
  const discovered = [];
  const seen = new Set();
  for (const startrow of [0, 25, 50]) {
    const url = startrow ? `${SEARCH_BASE}&startrow=${startrow}` : SEARCH_BASE;
    const html = await fetchText(url);
    const rows = parseDamianiSearchPage(html);
    if (rows.length === 0) break;
    for (const row of rows) {
      const key = row.href;
      if (seen.has(key)) continue;
      seen.add(key);
      discovered.push(row);
    }
    if (rows.length < 25) break;
  }
  const relevant = discovered.filter((row) => isDamianiTicinoLocation(row.location));
  console.log(`📋 Total search rows: ${discovered.length}`);
  console.log(`📋 TI/GR-relevant rows: ${relevant.length}`);
  for (const row of relevant) {
    console.log(`  📄 ${row.title} (${row.location})`);
  }
  if (relevant.length < 1) {
    throw new Error(`Expected at least 1 TI/GR Damiani job, found ${relevant.length}`);
  }
  return relevant;
}

function absoluteUrl(raw = '') {
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return new URL(raw, DETAIL_BASE).toString();
}

async function buildDamianiJob(listing) {
  const detailUrl = absoluteUrl(`${listing.href}${listing.href.includes('?') ? '' : '?locale=it_IT'}`);
  const html = await fetchText(detailUrl);
  const detail = parseDamianiJobDetail(html);
  const localized = buildDamianiLocalizedContent(detail);
  const canton = inferDamianiCanton(detail.location || listing.location);
  return {
    title: localized.titleByLocale.it || detail.title,
    slug: localized.slugByLocale.it,
    url: absoluteUrl(listing.href),
    applyUrl: absoluteUrl(detail.applyHref),
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: detail.location || listing.location,
    addressLocality: detail.location || listing.location,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferDamianiCategory(detail.title, detail.description),
    sector: 'Lusso & Gioielleria',
    source: 'damiani-dedicated-crawler',
    sourceLang: detectLang(detail.description || '', 'it'),
    postedDate: toIsoDate(detail.postedDate || listing.postedDate),
    employmentType: 'full-time',
    contractType: 'full-time',
    validThrough: toIsoDate(detail.validThrough || ''),
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
  printCrawlChangeSummary(diff, 'Damiani Group');
  writeCrawlChangeSummaryToGH(diff, 'Damiani Group');
  writeJobsSummary(mergedTarget, 'Damiani Group');
  printPublishedJobUrls(mergedTarget, 'Damiani Group');
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
    priority: 16,
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated Damiani Group crawler parses SuccessFactors search pages and keeps TI + GR jobs from the Damiani careers portal.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_DAMIANI_STRICT',
    label: 'Damiani Group',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_damiani_domain',
    failWhenNoJobs: true,
    noJobsMessage: 'No Damiani jobs found after dedicated crawl.',
    detectSourceLang: (text) => detectLang(text, 'it'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Damiani Group');
  console.log('═══════════════════════════════════════════════');
  console.log('  Damiani Group — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const listings = await fetchDamianiListings();
  const jobs = [];
  for (const listing of listings) {
    console.log(`  📄 Processing: ${listing.title} (${listing.location})`);
    jobs.push(await buildDamianiJob(listing));
  }
  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Damiani jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();
  const tiCount = jobs.filter((j) => j.canton === 'TI').length;
  const grCount = jobs.filter((j) => j.canton === 'GR').length;
  console.log(`\n✅ Damiani crawler complete (${total} jobs TI:${tiCount} GR:${grCount}, added=${added}, updated=${updated}).`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Damiani Group',
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
  console.error(`❌ Damiani crawler failed: ${err?.message || err}`);
  process.exit(1);
});
