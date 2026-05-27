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
  parseFinconsListingsPage,
  parseFinconsJobDetail,
  buildFinconsLocalizedContent,
} from './lib/fincons-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'fincons-group.json');

const COMPANY_KEY = 'fincons-group';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Fincons Group';
const COMPANY_HOST = 'fincons.applytojob.com';
const COMPANY_DOMAIN = 'finconsgroup.com';
const CAREERS_URL = 'https://ita.finconsgroup.com/culture-and-careers/job-offers/sedi/lugano.kl';
const LISTING_URL = 'https://fincons.applytojob.com/apply/jobs/?city=lugano';
const DETAIL_BASE = 'https://fincons.applytojob.com';
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

function absoluteUrl(raw = '') {
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return new URL(raw, DETAIL_BASE).toString();
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
  return (
    key === COMPANY_KEY
    || company.includes('fincons')
    || url.includes('fincons.applytojob.com/apply/')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'fincons.applytojob.com' || host === 'ita.finconsgroup.com' || host.endsWith('.finconsgroup.com');
  } catch {
    return false;
  }
}

async function fetchListings() {
  console.log('🔍 Fetching Fincons jobs from Lugano listing...');
  const html = await fetchText(LISTING_URL);
  const rows = parseFinconsListingsPage(html);
  console.log(`📋 Lugano job rows found: ${rows.length}`);
  if (rows.length < 4) {
    throw new Error(`Expected at least 4 Fincons Lugano jobs, found ${rows.length}`);
  }
  rows.forEach((row) => console.log(`  📄 ${row.title} (${row.location})`));
  return rows;
}

function inferCategory(detail = {}) {
  const haystack = normalize([detail.title, detail.description].filter(Boolean).join(' '));
  if (/(data|developer|software|appway|angular|java|mobile|automation|qa|test|engineer|analyst)/.test(haystack)) {
    return 'tech';
  }
  return 'other';
}

function normalizeEmploymentType(raw = '') {
  const text = normalize(raw);
  if (text.includes('part')) return 'part-time';
  if (text.includes('intern')) return 'internship';
  return 'full-time';
}

async function buildFinconsJob(listing) {
  const detailUrl = absoluteUrl(listing.href);
  const html = await fetchText(detailUrl);
  const detail = parseFinconsJobDetail(html);
  const localized = buildFinconsLocalizedContent(detail);
  const description = localized.descriptionByLocale.en || detail.description || '';
  const sourceTitle = localized.titleByLocale.en || detail.title || listing.title;
  return {
    title: sourceTitle,
    slug: localized.slugByLocale.en,
    url: detail.canonicalUrl || detailUrl,
    applyUrl: detail.applyUrl || detail.canonicalUrl || detailUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: 'Lugano',
    addressLocality: 'Lugano',
    addressRegion: 'TI',
    addressCountry: 'CH',
    postalCode: detail.postalCode || '6900',
    canton: DEFAULT_CANTON,
    country: 'CH',
    category: inferCategory(detail),
    sector: 'Tecnologia & IT',
    source: 'fincons-dedicated-crawler',
    sourceLang: detectLang(description, 'en'),
    postedDate: detail.datePosted ? detail.datePosted.slice(0, 10) : new Date().toISOString().slice(0, 10),
    validThrough: detail.validThrough ? detail.validThrough.slice(0, 10) : '',
    employmentType: normalizeEmploymentType(detail.employmentType),
    contractType: normalizeEmploymentType(detail.employmentType),
    description,
    titleByLocale: localized.titleByLocale,
    descriptionByLocale: localized.descriptionByLocale,
    slugByLocale: localized.slugByLocale,
    metadata: {
      experienceRequirements: detail.experienceRequirements,
      uniqueJobCode: detail.uniqueJobCode,
      listingLocation: listing.location,
      listingDepartment: listing.department,
    },
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

  const mergedTarget = discoveredJobs.map((job) => {
    const prev = existingByKey.get(jobMatchKey(job));
    if (!prev) return job;
    return {
      ...prev,
      ...job,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, job.descriptionByLocale, 30),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3),
      metadata: { ...(prev.metadata || {}), ...(job.metadata || {}) },
    };
  });

  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  writeJson(PUBLIC_JOBS, allJobs);

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'Fincons Group');
  writeCrawlChangeSummaryToGH(diff, 'Fincons Group');
  writeJobsSummary(mergedTarget, 'Fincons Group');
  printPublishedJobUrls(mergedTarget, 'Fincons Group');
  return { mergedTarget, diff };
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
    priority: 15,
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL, LISTING_URL],
    notes: 'Dedicated Fincons crawler parses the Lugano landing page iframe source hosted on JazzHR and keeps the public Lugano positions in sync.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_FINCONS_STRICT',
    label: 'Fincons Group',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_fincons_domain',
    failWhenNoJobs: true,
    noJobsMessage: 'No Fincons jobs found after dedicated crawl.',
    detectSourceLang: (text) => detectLang(text, 'en'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Fincons Group');
  console.log('═══════════════════════════════════════════════');
  console.log('  Fincons Group — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const listings = await fetchListings();
  const jobs = [];
  for (const listing of listings) {
    jobs.push(await buildFinconsJob(listing));
  }

  const { mergedTarget: merged, diff } = mergeJobs(jobs);
  updateAdapterConfig(merged);

  console.log('\n🌐 Running locale fill for Fincons jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();
  console.log(`\n✅ Fincons crawler complete (${merged.length} jobs).`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Fincons Group',
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
  console.error(`❌ Fincons crawler failed: ${err?.message || err}`);
  process.exit(1);
});
