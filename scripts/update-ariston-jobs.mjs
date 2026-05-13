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
  buildAristonLocalizedContent,
  inferAristonCategory,
  inferAristonRegion,
  isAristonTargetLocation,
  parseAristonJobDetail,
  parseAristonSitemapFeed,
} from './lib/ariston-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'ariston-group.json');

const COMPANY_KEY = 'ariston-group';
const COMPANY_NAME = 'Ariston Group';
const COMPANY_HOST = 'careers.aristongroup.com';
const COMPANY_DOMAIN = 'aristongroup.com';
const CAREERS_URL = 'https://careers.aristongroup.com/search/?createNewAlert=false&q=&optionsFacetsDD_country=CH&optionsFacetsDD_department=&optionsFacetsDD_shifttype=&optionsFacetsDD_customfield2=';
const FEED_URL = 'https://careers.aristongroup.com/sitemap_index.xml';
const DETAIL_BASE = 'https://careers.aristongroup.com';
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

function absoluteUrl(raw = '') {
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return new URL(raw, DETAIL_BASE).toString();
}

// Retry policy: 4 total attempts (initial + 3 retries) with exponential backoff
// 3s → 6s → 12s → 20s between attempts (~41s total wait) to survive transient
// upstream outages of 45–60s seen in CI on 2026-04-18 (Skyguide) / 2026-04-19 (Ariston).
const FETCH_RETRY_DELAYS_MS = [3000, 6000, 12000, 20000];

async function fetchText(url, timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
        },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      if (attempt < retries) {
        const delay = FETCH_RETRY_DELAYS_MS[attempt] ?? 20000;
        console.log(`  ⚠️ Retry ${attempt + 1}/${retries} for ${url} in ${delay}ms: ${err.message}`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return key === COMPANY_KEY || company.includes('ariston') || url.includes('careers.aristongroup.com/job/');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === COMPANY_HOST || host.endsWith('.aristongroup.com');
  } catch {
    return false;
  }
}

async function fetchAristonListings() {
  console.log('🔍 Fetching Ariston jobs from sitemap feed...');
  const xml = await fetchText(FEED_URL);
  const discovered = parseAristonSitemapFeed(xml);
  const target = discovered.filter((row) => isAristonTargetLocation(`${row.location} ${row.title}`));
  console.log(`📋 Feed items: ${discovered.length}`);
  console.log(`📋 Ticino/Grigioni rows: ${target.length}`);
  for (const row of target) {
    console.log(`  📄 ${row.title} (${row.location})`);
  }
  if (target.length < 1) {
    console.log('ℹ️ No Ariston jobs in Ticino/Grigioni — company may have no active openings.');
  }
  return target;
}

async function buildAristonJob(listing) {
  const detailUrl = absoluteUrl(listing.url);
  const html = await fetchText(detailUrl);
  const detail = parseAristonJobDetail(html);
  const region = inferAristonRegion(detail.location || listing.location);
  const localized = buildAristonLocalizedContent(detail);
  return {
    title: localized.titleByLocale.it || detail.title || listing.title,
    slug: localized.slugByLocale.it,
    url: detailUrl,
    applyUrl: absoluteUrl(detail.applyHref) || detailUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: detail.location || listing.location,
    addressLocality: detail.location || listing.location,
    addressRegion: region.canton,
    addressCountry: region.country,
    canton: region.canton,
    country: region.country,
    category: inferAristonCategory(detail.title || listing.title, detail.description || ''),
    sector: 'Energia & Riscaldamento',
    source: 'ariston-dedicated-crawler',
    sourceLang: detectLang(detail.description || '', 'it'),
    postedDate: toIsoDate(detail.postedDate || listing.validThrough),
    employmentType: 'full-time',
    contractType: 'full-time',
    validThrough: toIsoDate(detail.validThrough || listing.validThrough || ''),
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
  printCrawlChangeSummary(diff, 'Ariston Group');
  writeCrawlChangeSummaryToGH(diff, 'Ariston Group');
  writeJobsSummary(mergedTarget, 'Ariston Group');
  printPublishedJobUrls(mergedTarget, 'Ariston Group');
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
    crawlerModes: ['html', 'xml'],
    seedUrls: [CAREERS_URL, FEED_URL],
    notes: 'Dedicated Ariston Group crawler parses the careers RSS feed and SuccessFactors job detail pages, then keeps only Ticino/Grigioni jobs via shared Swiss target-location matching.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_ARISTON_STRICT',
    label: 'Ariston Group',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_ariston_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Ariston Group jobs found after dedicated crawl — company may have no active TI/GR openings.',
    detectSourceLang: (text) => detectLang(text, 'it'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Ariston Group');
  console.log('═══════════════════════════════════════════════');
  console.log('  Ariston Group — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');

  const listings = await fetchAristonListings();
  const jobs = [];
  for (const listing of listings) {
    const job = await buildAristonJob(listing);
    jobs.push(job);
  }

  const merged = mergeJobs(jobs);
  const diff = merged.diff;
  updateAdapterConfig(jobs);
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    maxJobs: jobs.length,
  });
  const allJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  writeJson(PUBLIC_JOBS, allJobs);
  validateLocales();
  console.log(`\n🏭 Total Ariston Group jobs: ${merged.total}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Ariston Group',
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
  console.error(`❌ Ariston Group crawler failed: ${error?.stack || error?.message || error}`);
  process.exitCode = 1;
});
