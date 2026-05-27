#!/usr/bin/env node
/**
 * AGIE Charmilles SA — Dedicated Crawler
 *
 * Crawls https://www.find-your-future.ch/it/lavoro-nel-settore-mem/settore-azienda/ritratti-aziendali/agie-charmilles-sa/
 * 1. Fetches company profile page → extracts all joboffer listings from HTML
 * 2. Filters for Ticino-relevant positions (canton TI / Losone)
 * 3. Builds job entries with localized content
 * 4. Merges into data/jobs.json
 * 5. Updates adapter config
 *
 * AGIE Charmilles SA = GF Machining Solutions (Georg Fischer), Losone (TI)
 * Source: find-your-future.ch (Swissmem industry job portal)
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
  parseAgieCharmillesProfilePage,
  parseAgieCharmillesDetailPage,
  isAgieCharmillesTicinoRelevant,
  inferAgieCharmillesCanton,
  inferAgieCharmillesCategory,
  buildAgieCharmillesLocalizedContent,
} from './lib/agie-charmilles-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'agie-charmilles.json');

const COMPANY_KEY = 'agie-charmilles';
const COMPANY_NAME = 'AGIE Charmilles SA';
const COMPANY_HOST = 'www.find-your-future.ch';
const COMPANY_DOMAIN = 'gfms.com';
const CAREERS_URL = 'https://www.find-your-future.ch/it/lavoro-nel-settore-mem/settore-azienda/ritratti-aziendali/agie-charmilles-sa/';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

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

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    key === 'agie-charmilles-sa' ||
    key === 'gf-machining-solutions' ||
    company === 'agie charmilles sa' ||
    company === 'gf machining solutions' ||
    url.includes('find-your-future.ch/it/arbeiten-mem-branche/branche-unternehmen/jobdetails/agie-charmilles')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.endsWith('find-your-future.ch') || host.endsWith('gfms.com') || host.endsWith('jobchannel.ch');
  } catch {
    return false;
  }
}

async function fetchAllListings() {
  console.log('🔍 Fetching AGIE Charmilles job listings...');
  console.log(`  📡 ${CAREERS_URL}`);

  const html = await fetchText(CAREERS_URL);
  const { items } = parseAgieCharmillesProfilePage(html);

  console.log(`📋 Found ${items.length} total job listings`);

  // Filter for Ticino-relevant positions
  const ticinoJobs = items.filter(isAgieCharmillesTicinoRelevant);
  const skipped = items.length - ticinoJobs.length;
  if (skipped > 0) {
    console.log(`  🔍 Filtered: ${ticinoJobs.length} Ticino-relevant (skipped ${skipped} non-TI)`);
  }

  return ticinoJobs;
}

function buildAgieCharmillesJob(row) {
  const localized = buildAgieCharmillesLocalizedContent(row);
  const canton = inferAgieCharmillesCanton(row);
  const city = row.city || 'Losone';

  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: row.detailUrl || CAREERS_URL,
    applyUrl: row.applyUrl || CAREERS_URL,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: city,
    addressLocality: city,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferAgieCharmillesCategory(row.title),
    sector: 'Macchine utensili',
    source: 'agie-charmilles-dedicated-crawler',
    sourceLang: row.language || detectLang(row.title, 'en'),
    postedDate: new Date().toISOString().slice(0, 10),
    employmentType: row.isTemporary ? 'temporary' : 'full-time',
    contractType: row.isTemporary ? 'temporary' : 'full-time',
    validThrough: '',
    workload: row.workload || '100%',
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
  printCrawlChangeSummary(diff, 'AGIE Charmilles');
  writeCrawlChangeSummaryToGH(diff, 'AGIE Charmilles');
  writeJobsSummary(mergedTarget, 'AGIE Charmilles');
  printPublishedJobUrls(mergedTarget, 'AGIE Charmilles');
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
    notes: 'Dedicated AGIE Charmilles crawler. Parses find-your-future.ch company profile page (Swissmem portal). AGIE Charmilles SA = GF Machining Solutions (Georg Fischer). HQ in Losone (TI), Via dei Pioppi 2, 6616. EDM, milling, laser, AM machine tools.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_AGIE_STRICT',
    label: 'AGIE Charmilles',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_agie_domain',
    failWhenNoJobs: false,
    maxToleratedMissingDescriptions: 10,
    noJobsMessage: 'No AGIE Charmilles jobs found after dedicated crawl.',
    detectSourceLang: () => 'en',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'AGIE Charmilles');
  console.log('═══════════════════════════════════════════════');
  console.log('  AGIE Charmilles SA — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Source: ${CAREERS_URL}\n`);

  const listings = await fetchAllListings();
  if (listings.length === 0) {
    console.log('⚠️ No Ticino-relevant job listings found — skipping.');
    return;
  }

  // Fetch detail pages for rich descriptions
  console.log(`\n📄 Fetching ${listings.length} detail pages for descriptions...`);
  for (let i = 0; i < listings.length; i++) {
    const item = listings[i];
    if (!item.detailUrl) continue;
    try {
      const html = await fetchText(item.detailUrl);
      const { description } = parseAgieCharmillesDetailPage(html);
      if (description && description.split(/\s+/).length >= 50) {
        item.detailDescription = description;
        console.log(`  ✅ ${i + 1}/${listings.length}: ${item.title}`);
      } else {
        console.log(`  ⚠️ ${i + 1}/${listings.length}: ${item.title} — thin detail page, using fallback`);
      }
    } catch (err) {
      console.log(`  ⚠️ Detail fetch failed for ${item.jobId}: ${err.message}`);
    }
    if (i < listings.length - 1) await new Promise((r) => setTimeout(r, 1200));
  }

  const jobs = listings.map(buildAgieCharmillesJob);

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for AGIE Charmilles jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n📊 === AGIE Charmilles Job Stats ===');
  console.log(`  🏢 Total AGIE Charmilles jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'AGIE Charmilles',
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
  console.error(`❌ AGIE Charmilles crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
