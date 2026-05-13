#!/usr/bin/env node
/**
 * MKS PAMP — Dedicated Crawler
 *
 * Crawls https://careers.mkspamp.com (Teamtailor ATS)
 * 1. Fetches RSS feed for all jobs with titles, links, dates, descriptions
 * 2. Fetches each detail page for location data (JSON-LD / embedded address)
 * 3. Filters Ticino-relevant jobs (Castel San Pietro, TI)
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
  fetchMksPampRss,
  fetchMksPampDetailLocation,
  isMksPampTicinoRelevant,
  buildMksPampLocalizedContent,
} from './lib/mkspamp-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'mks-pamp.json');

const COMPANY_KEY = 'mks-pamp';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'MKS PAMP';
const COMPANY_HOST = 'careers.mkspamp.com';
const COMPANY_DOMAIN = 'mkspamp.com';
const CAREERS_URL = 'https://careers.mkspamp.com/jobs';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
const DETAIL_DELAY_MS = 600;

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
    key === 'mks-pamp-sa' ||
    company.includes('mks pamp') ||
    company.includes('mkspamp') ||
    url.includes('mkspamp.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'careers.mkspamp.com' || host === 'mkspamp.com' || host.endsWith('.mkspamp.com');
  } catch {
    return false;
  }
}

function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferCategory(title = '') {
  const h = normalize(title);
  if (/sales|relationship|commercial|account/i.test(h)) return 'sales';
  if (/develop|java|devops|engineer|architect|qa/i.test(h)) return 'technology';
  if (/operator|raffineria|chimico|manutentore|idraulico|quality/i.test(h)) return 'production';
  if (/legal|compliance|risk/i.test(h)) return 'legal';
  if (/hr\b|human|operations officer/i.test(h)) return 'hr';
  if (/finance|treasury|controller|accounts/i.test(h)) return 'finance';
  if (/health|safety|h&s/i.test(h)) return 'safety';
  return 'general';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseDate(pubDate = '') {
  try {
    const d = new Date(pubDate);
    if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
    return d.toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function buildMksPampJob(rssItem, location) {
  const city = location?.city || 'Castel San Pietro';
  const localized = buildMksPampLocalizedContent({
    title: rssItem.title,
    city,
    descriptionHtml: rssItem.descriptionHtml,
    detailDescription: location?.description || '',
  });

  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: rssItem.link,
    applyUrl: rssItem.link,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: city,
    addressLocality: city,
    addressRegion: 'TI',
    addressCountry: 'CH',
    canton: DEFAULT_CANTON,
    country: 'CH',
    category: inferCategory(rssItem.title),
    sector: 'Metalli preziosi',
    source: 'mkspamp-dedicated-crawler',
    sourceLang: detectLang(rssItem.title, 'it'),
    postedDate: parseDate(rssItem.pubDate),
    employmentType: 'full-time',
    contractType: 'permanent',
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
  printCrawlChangeSummary(diff, 'MKS PAMP');
  writeCrawlChangeSummaryToGH(diff, 'MKS PAMP');
  writeJobsSummary(mergedTarget, 'MKS PAMP');
  printPublishedJobUrls(mergedTarget, 'MKS PAMP');
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
    crawlerModes: ['rss', 'html'],
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated MKS PAMP crawler. RSS feed for job list, detail pages for location filtering (JSON-LD). Filters Castel San Pietro (TI) positions.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_MKSPAMP_STRICT',
    label: 'MKS PAMP',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_mkspamp_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No MKS PAMP jobs found after dedicated crawl.',
    detectSourceLang: () => 'it',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'MKS PAMP');
  console.log('═══════════════════════════════════════════════');
  console.log('  MKS PAMP — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  console.log('🔍 Fetching MKS PAMP job listings via RSS...');
  const rssItems = await fetchMksPampRss(TIMEOUT_MS);
  console.log(`📋 RSS returned ${rssItems.length} job openings`);

  // Fetch location for each job from detail pages
  console.log('\n📄 Fetching detail pages for location data...');
  const enriched = [];
  for (const item of rssItems) {
    const location = await fetchMksPampDetailLocation(item.link, TIMEOUT_MS);
    const city = location?.city || '?';
    const country = location?.country || '?';
    const isTI = isMksPampTicinoRelevant(location || {});
    console.log(`  ${isTI ? '✅' : '⏭️ '} ${item.title} → ${city} (${country})${isTI ? '' : ' [skipped]'}`);
    if (isTI) {
      enriched.push({ rssItem: item, location });
    }
    if (enriched.length < rssItems.length) await sleep(DETAIL_DELAY_MS);
  }

  console.log(`\n📍 Ticino-relevant: ${enriched.length} / ${rssItems.length}`);

  if (enriched.length === 0) {
    console.log('⚠️ No Ticino-relevant jobs found — skipping.');
    return;
  }

  const jobs = enriched.map(({ rssItem, location }) => buildMksPampJob(rssItem, location));

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

  console.log('\n🌐 Running locale fill for MKS PAMP jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n📊 === MKS PAMP Job Stats ===');
  console.log(`  🏢 Total MKS PAMP jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'MKS PAMP',
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
  console.error(`❌ MKS PAMP crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
