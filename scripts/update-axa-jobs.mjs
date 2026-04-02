#!/usr/bin/env node
/**
 * AXA Svizzera — Dedicated Crawler
 *
 * Crawls https://jobs.axa.ch/ (Prospective.ch Career Center)
 * 1. Fetches listing page filtered by Region Tessin (68794) + Ostschweiz/GR (68792)
 * 2. Fetches each detail page → extracts description, workload, location, apply URL
 * 3. Filters Ticino/GR-relevant jobs
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
  parseAxaListingPage,
  parseAxaDetailPage,
  buildAxaLocalizedContent,
  isAxaTicinoRelevant,
  inferAxaCanton,
  inferAxaCategory,
  extractUuidFromUrl,
  buildDetailUrl,
  buildListingUrl,
  REGION_FILTERS,
  BASE_URL,
} from './lib/axa-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'axa-svizzera.json');

const COMPANY_KEY = 'axa-svizzera';
const COMPANY_NAME = 'AXA Svizzera';
const COMPANY_HOST = 'jobs.axa.ch';
const COMPANY_DOMAIN = 'axa.ch';
const CAREERS_URL = 'https://jobs.axa.ch/?lang=it';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
const MAX_DETAIL_PAGES = Number(process.env.AXA_MAX_DETAIL_PAGES) || 40;
const DETAIL_DELAY_MS = 300;
const DETAIL_CONCURRENCY = 4;

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

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTargetJob(job = {}) {
  return (
    normalize(job.companyKey) === COMPANY_KEY ||
    normalize(job.company) === normalize(COMPANY_NAME) ||
    isTrustedDomain(job.url)
  );
}

function isTrustedDomain(url = '') {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === COMPANY_HOST || host.endsWith(`.${COMPANY_DOMAIN}`);
  } catch {
    return false;
  }
}

async function fetchText(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8,de;q=0.7,fr;q=0.6',
        },
      });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return await res.text();
    } catch (err) {
      if (attempt < retries) {
        console.log(`  ⚠️ Retry ${attempt + 1}/${retries} for ${url}: ${err.message}`);
        await sleep(2000 * (attempt + 1));
      } else {
        throw err;
      }
    }
  }
}

/**
 * Fetch listing pages for target regions and collect all job summaries.
 */
async function fetchAllListings() {
  const allJobs = new Map();

  for (const [regionName, regionCode] of Object.entries(REGION_FILTERS)) {
    const url = buildListingUrl('it', regionCode, 500);
    console.log(`\n📋 Fetching ${regionName} listing: ${url}`);

    try {
      const html = await fetchText(url);
      const jobs = parseAxaListingPage(html);
      console.log(`  ✅ Found ${jobs.length} jobs in ${regionName}`);

      for (const job of jobs) {
        const uuid = extractUuidFromUrl(job.url);
        if (uuid && !allJobs.has(uuid)) {
          allJobs.set(uuid, { ...job, uuid, region: regionName });
        }
      }
    } catch (err) {
      console.log(`  ⚠️ Failed to fetch ${regionName} listing: ${err.message}`);
    }
  }

  console.log(`\n📊 Total unique jobs from all regions: ${allJobs.size}`);
  return [...allJobs.values()];
}

/**
 * Fetch detail pages and enrich job data.
 */
async function enrichWithDetails(listings) {
  const toFetch = listings.slice(0, MAX_DETAIL_PAGES);
  const enriched = new Array(toFetch.length);

  console.log(`\n🔎 Fetching up to ${toFetch.length} detail pages (concurrency: ${DETAIL_CONCURRENCY})...`);

  // Process in batches of DETAIL_CONCURRENCY
  for (let start = 0; start < toFetch.length; start += DETAIL_CONCURRENCY) {
    const batch = toFetch.slice(start, start + DETAIL_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (item, batchIdx) => {
        const idx = start + batchIdx;
        try {
          // Use the full URL from the listing page (includes slug + uuid)
          const itUrl = item.url || buildDetailUrl(item.uuid, 'it');
          const html = await fetchText(itUrl);
          const detail = parseAxaDetailPage(html, itUrl);

          if (detail) {
            return {
              ...item,
              detailUrl: itUrl,
              title: detail.title || item.title,
              location: detail.location || '',
              address: detail.address || '',
              workload: detail.workload || '',
              description: detail.description || '',
              metaDescription: detail.metaDescription || item.excerpt || '',
              applyUrl: detail.applyUrl || item.applyUrl || '',
              lang: detail.lang || 'it',
            };
          }
          return {
            ...item,
            detailUrl: itUrl,
            description: item.excerpt || '',
            metaDescription: item.excerpt || '',
            location: '',
            address: '',
            workload: '',
            lang: 'it',
          };
        } catch (err) {
          console.log(`  ⚠️ Detail fetch failed for ${item.title}: ${err.message}`);
          return {
            ...item,
            detailUrl: item.url,
            description: item.excerpt || '',
            metaDescription: item.excerpt || '',
            location: '',
            address: '',
            workload: '',
            lang: 'it',
          };
        }
      }),
    );

    results.forEach((r, batchIdx) => { enriched[start + batchIdx] = r; });
    const done = Math.min(start + DETAIL_CONCURRENCY, toFetch.length);
    if (done % 5 === 0 || done === toFetch.length) {
      console.log(`  ✅ ${done}/${toFetch.length} detail pages fetched`);
    }
    if (start + DETAIL_CONCURRENCY < toFetch.length) await sleep(DETAIL_DELAY_MS);
  }

  // Filter to Ticino/GR-relevant only
  const relevant = enriched.filter((job) => {
    // Jobs from Tessin region filter are already Ticino-relevant
    if (job.region === 'tessin') return true;
    // Jobs from Ostschweiz need location check for GR
    return isAxaTicinoRelevant(job.location, job.address, job.title);
  });

  console.log(`\n📍 Target-region jobs: ${relevant.length} / ${enriched.length}`);
  return relevant;
}

function buildAxaJob(row) {
  const localized = buildAxaLocalizedContent(row, row.excerpt || '');
  const canton = inferAxaCanton(row.location, row.address);
  const category = inferAxaCategory(row.title, row.description);
  const detailUrl = row.detailUrl || row.url;
  const slug = slugify(row.title);

  // Employment type from workload
  let employmentType = 'full-time';
  if (row.workload) {
    const match = row.workload.match(/(\d+)/);
    if (match && parseInt(match[1], 10) < 80) {
      employmentType = 'part-time';
    }
  }

  const lang = detectLang(`${row.title} ${row.description}`, row.lang || 'it');

  return {
    title: row.title,
    slug,
    url: detailUrl,
    applyUrl: row.applyUrl || '',
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: row.location || row.address?.split(',')[0] || 'Ticino',
    addressLocality: row.address?.split(',')[0]?.trim() || row.location || '',
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category,
    sector: 'assicurazioni',
    source: 'axa-dedicated-crawler',
    sourceLang: lang,
    postedDate: new Date().toISOString().slice(0, 10),
    employmentType,
    contractType: employmentType,
    workload: row.workload || '',
    validThrough: '',
    description: localized[lang]?.description || row.description || '',
    titleByLocale: { [lang]: row.title },
    descriptionByLocale: { [lang]: localized[lang]?.description || row.description || '' },
    slugByLocale: { [lang]: slug },
  };
}

function jobMatchKey(job = {}) {
  // Use UUID from URL as primary key
  const uuid = extractUuidFromUrl(job.url || '');
  if (uuid) return uuid;
  return normalize(job.url) || normalize(job.slug);
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
  printCrawlChangeSummary(diff, 'AXA Svizzera');
  writeCrawlChangeSummaryToGH(diff, 'AXA Svizzera');
  writeJobsSummary(mergedTarget, 'AXA Svizzera');
  printPublishedJobUrls(mergedTarget, 'AXA Svizzera');
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
    notes: 'Dedicated AXA Svizzera crawler. Prospective.ch Career Center (CC 2193). Filters by Region Tessin (68794) + Ostschweiz/GR (68792). Detail pages at /posizioni-aperte/{slug}/{uuid}. ATS: Umantis (recruitingapp-2735.umantis.com).',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_AXA_STRICT',
    label: 'AXA Svizzera',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_axa_domain',
    failWhenNoJobs: false,
    maxToleratedMissingDescriptions: 10,
    minDescriptionChars: 80,
    noJobsMessage: 'No AXA Svizzera jobs found after dedicated crawl.',
    detectSourceLang: () => 'it',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'AXA Svizzera');
  console.log('═══════════════════════════════════════════════');
  console.log('  AXA Svizzera — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}`);
  console.log(`  Career Center ID: 2193 (Prospective.ch)\n`);

  const listings = await fetchAllListings();
  if (listings.length === 0) {
    console.log('⚠️ No listings found on AXA career center — skipping.');
    return;
  }

  const enrichedListings = await enrichWithDetails(listings);

  // Deduplicate by UUID
  const seenUuids = new Map();
  const deduplicated = [];
  for (const listing of enrichedListings) {
    const key = listing.uuid || normalize(listing.url);
    if (!seenUuids.has(key)) {
      seenUuids.set(key, listing);
      deduplicated.push(listing);
    }
  }
  if (deduplicated.length < enrichedListings.length) {
    console.log(`🔄 Deduplicated: ${enrichedListings.length} → ${deduplicated.length} unique`);
  }

  const jobs = deduplicated.map(buildAxaJob);

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for AXA jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n📊 === AXA Svizzera Job Stats ===');
  console.log(`  🏢 Total AXA jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'AXA Svizzera',
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
  console.error(`❌ AXA crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
