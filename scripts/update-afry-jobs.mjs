#!/usr/bin/env node
/**
 * AFRY — Dedicated Crawler
 *
 * Crawls https://afry.com/en/api/afp-hr-smartrecruiteres-job-list
 * 1. Fetches global job listing JSON API (SmartRecruiters proxy)
 * 2. Filters Swiss jobs (country=ch)
 * 3. Filters Ticino/Grigioni relevant jobs by city
 * 4. Fetches detail pages for descriptions + apply URLs
 * 5. Merges into data/jobs.json
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
  parseAfryApiResponse,
  parseAfryDetailPage,
  parseSmartRecruitersPage,
  isAfryTicinoRelevant,
  inferAfryCanton,
  inferAfryCategory,
  buildAfryLocalizedContent,
} from './lib/afry-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'afry.json');

const COMPANY_KEY = 'afry';
const COMPANY_NAME = 'AFRY';
const COMPANY_HOST = 'afry.com';
const COMPANY_DOMAIN = 'afry.com';
const API_URL = 'https://afry.com/en/api/afp-hr-smartrecruiteres-job-list';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 25000;
const MAX_DETAIL_PAGES = Number(process.env.AFRY_MAX_DETAIL_PAGES) || 30;
const DETAIL_DELAY_MS = 1500;

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

async function fetchJson(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
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
    key === 'afry-ag' ||
    key === 'afry-switzerland' ||
    company === 'afry' ||
    company === 'afry ag' ||
    url.includes('afry.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.endsWith('afry.com') || host.endsWith('smartrecruiters.com');
  } catch {
    return false;
  }
}

async function fetchAllListings() {
  console.log('🔍 Fetching AFRY job listings via API...');
  console.log(`  📡 ${API_URL}`);

  const data = await fetchJson(API_URL);
  const { items, totalGlobal, totalSwiss } = parseAfryApiResponse(data);

  console.log(`📋 API returned ${totalGlobal} global jobs, ${totalSwiss} in Switzerland`);

  // Filter for Ticino/Grigioni relevance
  const ticinoJobs = items.filter(isAfryTicinoRelevant);
  console.log(`🎯 Ticino/Grigioni relevant: ${ticinoJobs.length}`);

  return ticinoJobs;
}

async function enrichWithDetails(listings) {
  const toFetch = listings.slice(0, MAX_DETAIL_PAGES);
  const enriched = [];

  console.log(`\n🔎 Fetching ${toFetch.length} detail pages...`);

  for (let i = 0; i < toFetch.length; i++) {
    const item = toFetch[i];
    if (!item.detailUrl) {
      enriched.push({ ...item, description: '', applyUrl: '' });
      continue;
    }
    let description = '';
    let applyUrl = item.detailUrl;

    try {
      // Step 1: Try afry.com detail page
      const html = await fetchText(item.detailUrl);
      const detail = parseAfryDetailPage(html);
      description = detail.description || '';
      applyUrl = detail.applyUrl || item.detailUrl;

      // Step 2: If afry.com description is thin, try SmartRecruiters page
      if ((!description || description.split(/\s+/).length < 50) && applyUrl && applyUrl.includes('smartrecruiters.com')) {
        try {
          const srHtml = await fetchText(applyUrl);
          const srDesc = parseSmartRecruitersPage(srHtml);
          if (srDesc && srDesc.split(/\s+/).length > (description ? description.split(/\s+/).length : 0)) {
            description = srDesc;
            console.log(`  ✅ ${i + 1}/${toFetch.length}: ${item.title} (${item.location}) [via SmartRecruiters]`);
          } else {
            console.log(`  ✅ ${i + 1}/${toFetch.length}: ${item.title} (${item.location})`);
          }
        } catch (srErr) {
          console.log(`  ⚠️ SmartRecruiters fetch failed for ${item.id}: ${srErr.message}`);
          console.log(`  ✅ ${i + 1}/${toFetch.length}: ${item.title} (${item.location})`);
        }
      } else {
        console.log(`  ✅ ${i + 1}/${toFetch.length}: ${item.title} (${item.location})`);
      }
    } catch (err) {
      console.log(`  ⚠️ Detail fetch failed for ${item.id}: ${err.message}`);
    }

    enriched.push({
      ...item,
      description,
      applyUrl,
    });
    if (i < toFetch.length - 1) await sleep(DETAIL_DELAY_MS);
  }

  return enriched;
}

function buildAfryJob(row) {
  const localized = buildAfryLocalizedContent(row);
  const canton = inferAfryCanton(row);
  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: row.detailUrl,
    applyUrl: row.applyUrl || row.detailUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: row.location || 'Ticino',
    addressLocality: (row.cities || [])[0] || row.location || 'Ticino',
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferAfryCategory(row.competenceArea, row.title),
    sector: 'Ingegneria & Consulenza',
    source: 'afry-dedicated-crawler',
    sourceLang: detectLang(`${row.title} ${row.description}`, row.language || 'it'),
    postedDate: new Date().toISOString().slice(0, 10),
    validThrough: row.lastApplyDate || '',
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
  printCrawlChangeSummary(diff, 'AFRY');
  writeCrawlChangeSummaryToGH(diff, 'AFRY');
  writeJobsSummary(mergedTarget, 'AFRY');
  printPublishedJobUrls(mergedTarget, 'AFRY');
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
    crawlerModes: ['api'],
    seedUrls: [API_URL],
    notes: 'Dedicated AFRY crawler. Uses Drupal proxy to SmartRecruiters API. Returns all global jobs in one JSON call; filters by country=CH then Ticino/Grigioni cities. ~18000 employees globally, major presence in Swiss engineering/infrastructure. Swiss HQ in Zurich, Ticino offices in Bellinzona/Airolo.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_AFRY_STRICT',
    label: 'AFRY',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_afry_domain',
    failWhenNoJobs: false,
    maxToleratedMissingDescriptions: 10,
    noJobsMessage: 'No AFRY Ticino/GR jobs found after dedicated crawl.',
    detectSourceLang: (job) => job.sourceLang || 'de',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'AFRY');
  console.log('═══════════════════════════════════════════════');
  console.log('  AFRY — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  API: ${API_URL}\n`);

  const listings = await fetchAllListings();
  if (listings.length === 0) {
    console.log('⚠️ No Ticino/GR AFRY jobs found — skipping.');
    return;
  }

  const enrichedListings = await enrichWithDetails(listings);
  const jobs = enrichedListings.map(buildAfryJob);

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for AFRY jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n📊 === AFRY Job Stats ===');
  console.log(`  🏢 Total AFRY Ticino/GR jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'AFRY',
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
  console.error(`❌ AFRY crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
