#!/usr/bin/env node
/**
 * Artificialy — Dedicated Crawler
 *
 * Crawls https://www.artificialy.com/it/career
 * 1. Fetches career page HTML (site behind Cloudflare — may fail with 403)
 * 2. Parses job listings via JSON-LD, HTML cards, or link extraction
 * 3. Filters Ticino/Grigioni relevant jobs (Lugano office)
 * 4. Merges into data/jobs.json
 *
 * Artificialy: Swiss AI company, offices in Lugano (TI) and Zurich.
 * Specializes in finance, healthcare, manufacturing AI solutions.
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
  parseArtificialyCareerPage,
  isArtificialyTicinoRelevant,
  inferArtificialyCanton,
  inferArtificialyCategory,
  buildArtificialyLocalizedContent,
} from './lib/artificialy-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'artificialy.json');

const COMPANY_KEY = 'artificialy';
const COMPANY_NAME = 'Artificialy';
const COMPANY_HOST = 'artificialy.com';
const COMPANY_DOMAIN = 'artificialy.com';
const CAREER_URLS = [
  'https://www.artificialy.com/it/career',
  'https://www.artificialy.com/career',
];
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 25000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;

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
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
      },
      redirect: 'follow',
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
    company === 'artificialy' ||
    url.includes('artificialy.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.endsWith('artificialy.com') || host.endsWith('linkedin.com');
  } catch {
    return false;
  }
}

async function fetchCareerPage() {
  for (const url of CAREER_URLS) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`  Fetching ${url} (attempt ${attempt + 1})...`);
        const html = await fetchText(url);
        const { items, blocked } = parseArtificialyCareerPage(html);

        if (blocked) {
          console.log(`  Cloudflare challenge detected on ${url}`);
          if (attempt < MAX_RETRIES) {
            console.log(`  Retrying in ${RETRY_DELAY_MS / 1000}s...`);
            await sleep(RETRY_DELAY_MS);
            continue;
          }
          break;
        }

        if (items.length > 0) {
          console.log(`  Found ${items.length} jobs from ${url}`);
          return items;
        }

        console.log(`  No jobs extracted from ${url} (HTML length: ${html.length})`);
        break;
      } catch (err) {
        console.log(`  Fetch failed for ${url}: ${err.message}`);
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
      }
    }
  }
  return [];
}

async function fetchAllListings() {
  console.log('Fetching Artificialy career page...');

  const items = await fetchCareerPage();
  console.log(`Total jobs found: ${items.length}`);

  // Filter for Ticino/Grigioni relevance
  const ticinoJobs = items.filter(isArtificialyTicinoRelevant);
  console.log(`Ticino/Grigioni relevant: ${ticinoJobs.length}`);

  return ticinoJobs;
}

function buildArtificialyJob(row) {
  const localized = buildArtificialyLocalizedContent(row);
  const canton = inferArtificialyCanton(row);
  const detailUrl = row.applyUrl || `${CAREER_URLS[0]}`;
  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: detailUrl,
    applyUrl: row.applyUrl || detailUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: row.location || 'Lugano',
    addressLocality: row.location || 'Lugano',
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferArtificialyCategory(row.title),
    sector: 'Intelligenza Artificiale',
    source: 'artificialy-dedicated-crawler',
    sourceLang: detectLang(`${row.title} ${row.description}`, 'it'),
    postedDate: row.datePosted || new Date().toISOString().slice(0, 10),
    validThrough: row.validThrough || '',
    employmentType: 'full-time',
    contractType: 'full-time',
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
  printCrawlChangeSummary(diff, 'Artificialy');
  writeCrawlChangeSummaryToGH(diff, 'Artificialy');
  writeJobsSummary(mergedTarget, 'Artificialy');
  printPublishedJobUrls(mergedTarget, 'Artificialy');
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
    seedUrls: CAREER_URLS,
    notes: 'Dedicated Artificialy crawler. Swiss AI company with offices in Lugano (TI) and Zurich. Specializes in AI solutions for finance, healthcare, manufacturing. Site behind Cloudflare managed challenge — may intermittently block automated requests.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_ARTIFICIALY_STRICT',
    label: 'Artificialy',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_artificialy_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Artificialy Ticino/GR jobs found after dedicated crawl (site may be Cloudflare-blocked).',
    detectSourceLang: (job) => job.sourceLang || 'it',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Artificialy');
  console.log('===============================================');
  console.log('  Artificialy — Dedicated Crawler');
  console.log('===============================================');
  console.log(`  URLs: ${CAREER_URLS.join(', ')}\n`);

  const listings = await fetchAllListings();
  if (listings.length === 0) {
    console.log('No Ticino/GR Artificialy jobs found — skipping merge.');
    console.log('(Site may be blocked by Cloudflare managed challenge)');
    printCrawlChangeSummary({ newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0 }, 'Artificialy');
    return;
  }

  const jobs = listings.map(buildArtificialyJob);

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\nRunning locale fill for Artificialy jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n=== Artificialy Job Stats ===');
  console.log(`  Total Artificialy Ticino/GR jobs: ${total}`);
  console.log(`  Added: ${added}`);
  console.log(`  Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Artificialy',
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
  console.error(`Artificialy crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
