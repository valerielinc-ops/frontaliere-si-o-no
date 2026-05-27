#!/usr/bin/env node
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
  parseAvaloqListingLinks,
  parseAvaloqJobDetail,
  isAvaloqTargetLocation,
  inferAvaloqCanton,
  buildAvaloqLocalizedContent,
  fetchAvaloqJobsFromApi,
} from './lib/avaloq-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'avaloq.json');

const COMPANY_KEY = 'avaloq';
const COMPANY_NAME = 'Avaloq';
const COMPANY_HOST = 'www.avaloq.com';
const COMPANY_DOMAIN = 'avaloq.com';
const CAREERS_URL = 'https://www.avaloq.com/careers/job-openings';
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

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return key === COMPANY_KEY || company.includes('avaloq') || url.includes('www.avaloq.com/careers/job-openings/');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'www.avaloq.com' || host.endsWith('.avaloq.com') || host === 'jobs.smartrecruiters.com';
  } catch {
    return false;
  }
}

function inferCategory(detail = {}) {
  const haystack = normalize([detail.title, detail.description].filter(Boolean).join(' '));
  if (/(developer|engineer|platform|data|it|technical|identity)/.test(haystack)) return 'tech';
  if (/(banking|reporting|business analyst|operations analyst|trade processing)/.test(haystack)) return 'finance';
  if (/(apprendista|internship|intern)/.test(haystack)) return 'internship';
  return 'other';
}

async function fetchListings() {
  console.log('🔍 Fetching Avaloq jobs from SmartRecruiters API...');
  const details = await fetchAvaloqJobsFromApi(
    Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000,
    (city) => isAvaloqTargetLocation(city)
  );
  console.log(`📋 Avaloq Ticino/Grigioni jobs from API: ${details.length}`);
  return details;
}

async function mapConcurrent(items, limit, mapper) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = items[index++];
      results.push(await mapper(current));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function buildAvaloqJobs() {
  const details = await fetchListings();
  const target = details.filter((detail) => isAvaloqTargetLocation(detail.location || ''));
  console.log(`📋 Avaloq Ticino/Grigioni jobs: ${target.length}`);
  for (const detail of target) {
    console.log(`  📄 ${detail.title} (${detail.location || 'n/a'})`);
  }
  if (target.length < 7) {
    throw new Error(`Expected at least 7 Avaloq Ticino/Grigioni jobs, found ${target.length}`);
  }
  return target.map((detail) => {
    const localized = buildAvaloqLocalizedContent(detail, COMPANY_NAME);
    const canton = inferAvaloqCanton(detail.location || '');
    const contractType = /part/i.test(detail.workArrangement || '') ? 'part-time' : 'full-time';
    return {
      title: localized.titleByLocale.it || detail.title,
      slug: localized.slugByLocale.it,
      url: detail.canonicalUrl,
      applyUrl: detail.applyUrl,
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      companyDomain: COMPANY_DOMAIN,
      location: detail.location,
      addressLocality: detail.location,
      addressRegion: canton,
      addressCountry: 'CH',
      postalCode: detail.postalCode || '6934',
      canton,
      country: 'CH',
      category: inferCategory(detail),
      sector: 'Tecnologia & IT',
      source: 'avaloq-dedicated-crawler',
      sourceLang: detectLang(`${detail.title} ${detail.description}`, 'en'),
      postedDate: (detail.releasedDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
      employmentType: contractType,
      contractType,
      validThrough: '',
      description: localized.descriptionByLocale.it,
      titleByLocale: localized.titleByLocale,
      descriptionByLocale: localized.descriptionByLocale,
      slugByLocale: localized.slugByLocale,
    };
  });
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
  printCrawlChangeSummary(diff, 'Avaloq');
  writeCrawlChangeSummaryToGH(diff, 'Avaloq');
  writeJobsSummary(mergedTarget, 'Avaloq');
  printPublishedJobUrls(mergedTarget, 'Avaloq');
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
    notes: 'Dedicated Avaloq crawler parses the public careers listing and job detail pages, filtering vacancies in Ticino and Grigioni.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_AVALOQ_STRICT',
    label: 'Avaloq',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_avaloq_domain',
    failWhenNoJobs: true,
    noJobsMessage: 'No Avaloq jobs found after dedicated crawl.',
    detectSourceLang: (text) => detectLang(text, 'en'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Avaloq');
  console.log('═══════════════════════════════════════════════');
  console.log('  Avaloq — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const jobs = await buildAvaloqJobs();
  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Avaloq jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n📊 === Avaloq Job Stats ===');
  console.log(`  🏢 Total Avaloq jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Avaloq',
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
  console.error(`❌ Avaloq crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
