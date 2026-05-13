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
  parseZucchettiListings,
  isZucchettiTargetLocation,
  inferZucchettiCanton,
  parseZucchettiJobDetail,
  buildZucchettiLocalizedContent,
} from './lib/zucchetti-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'zucchetti-switzerland.json');

const COMPANY_KEY = 'zucchetti-switzerland';
const COMPANY_NAME = 'Zucchetti Switzerland SA';
const COMPANY_HOST = 'www.zucchetti.com';
const COMPANY_DOMAIN = 'zucchetti.com';
const CAREERS_URL = 'https://www.zucchetti.com/de/careers.html';
const LISTING_URL = 'https://zinrec.intervieweb.it/app.php?module=iframeAnnunci&lang=de&k=ef979e8b8a190b4c35ef4ea311478c7b&d=www.zucchetti.com&LAC=zucchettidach&utype=&act1=23&defgroup=name&gnavenable=on&desc=on&annType=published&typeView=small';
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
  const applyUrl = String(job.applyUrl || '').toLowerCase();
  return key === COMPANY_KEY
    || company.includes('zucchetti')
    || url.includes('zinrec.intervieweb.it/zucchettidach/')
    || applyUrl.includes('zinrec.intervieweb.it/zucchettidach/');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'zinrec.intervieweb.it' || host === 'www.zucchetti.com' || host.endsWith('.zucchetti.com');
  } catch {
    return false;
  }
}

function inferCategory(detail = {}) {
  const haystack = normalize(`${detail.category || ''} ${detail.title || ''} ${detail.description || ''}`);
  if (haystack.includes('developer') || haystack.includes('software') || haystack.includes('.net') || haystack.includes('api')) return 'tech';
  if (haystack.includes('support')) return 'other';
  return 'tech';
}

async function fetchZucchettiListings() {
  console.log('🔍 Fetching Zucchetti jobs from InRecruiting listing...');
  const html = await fetchText(LISTING_URL);
  const discovered = parseZucchettiListings(html);
  const target = discovered.filter((row) => isZucchettiTargetLocation(row.location));
  console.log(`📋 Total listing rows: ${discovered.length}`);
  console.log(`📋 Ticino/Grigioni rows: ${target.length}`);
  for (const row of target) {
    console.log(`  📄 ${row.title} (${row.location})`);
  }
  if (target.length === 0) {
    console.log('ℹ️ No Zucchetti jobs in Ticino/Grigioni right now — writing empty slice.');
  }
  return target;
}

async function buildZucchettiJob(listing) {
  const html = await fetchText(listing.href);
  const detail = parseZucchettiJobDetail(html);
  const canton = inferZucchettiCanton(`${detail.location} ${listing.location}`);
  const localized = buildZucchettiLocalizedContent(detail, COMPANY_NAME);
  const sourceUrl = detail.shareUrl || listing.href;
  const canonicalTitle = detail.title || listing.title;
  const canonicalSlug =
    localized.slugByLocale.en ||
    normalizeKey(`${canonicalTitle} ${COMPANY_NAME} ${detail.location || listing.location}`);
  return {
    title: canonicalTitle,
    slug: canonicalSlug,
    url: sourceUrl,
    applyUrl: sourceUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: detail.location || listing.location,
    addressLocality: detail.location || listing.location,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferCategory(detail),
    sector: 'Tecnologia & IT',
    source: 'zucchetti-dedicated-crawler',
    sourceLang: detectLang(detail.description || listing.teaser || '', 'en'),
    postedDate: new Date().toISOString().slice(0, 10),
    employmentType: 'full-time',
    contractType: 'full-time',
    validThrough: '',
    description: detail.description || listing.teaser || '',
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
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  writeJobsSummary(mergedTarget, COMPANY_NAME);
  printPublishedJobUrls(mergedTarget, COMPANY_NAME);
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
    seedUrls: [CAREERS_URL, LISTING_URL],
    notes: 'Dedicated Zucchetti crawler parses the InRecruiting/Intervieweb listing and detail pages, keeping only Ticino or Grigioni vacancies.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_ZUCCHETTI_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_zucchetti_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Zucchetti jobs found after dedicated crawl.',
    detectSourceLang: (text) => detectLang(text, 'en'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'zucchetti');
  console.log('═══════════════════════════════════════════════');
  console.log('  Zucchetti Switzerland SA — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const listings = await fetchZucchettiListings();
  const jobs = [];
  for (const listing of listings) {
    jobs.push(await buildZucchettiJob(listing));
  }

  const result = mergeJobs(jobs);
  const diff = result.diff;
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Zucchetti jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();
  console.log(`\n✅ Zucchetti crawler complete (${result.total} jobs).`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'zucchetti',
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
  console.error(`❌ Zucchetti crawler failed: ${err?.message || err}`);
  process.exit(1);
});
