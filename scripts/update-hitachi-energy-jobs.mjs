#!/usr/bin/env node
/**
 * Hitachi Energy — Dedicated Crawler
 *
 * Crawls https://www.hitachienergy.com/careers/open-jobs (AEM + Workday ATS)
 * 1. Fetches Switzerland jobs via AEM JSON listing API (paginated)
 * 2. Optionally fetches detail pages for rich descriptions
 * 3. Filters Ticino/Grigioni-relevant jobs via shared geo-filtering
 * 4. Merges into data/jobs.json
 * 5. Updates adapter config
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
  isLocationExplicitlyForeign,
} from './lib/dedicated-crawler-common.mjs';
import {
  parseHitachiEnergyListingJson,
  parseHitachiEnergyDetailPage,
  buildHitachiEnergyLocalizedContent,
  isHitachiEnergyTicinoRelevant,
  inferHitachiEnergyCanton,
  hasMorePages,
  PAGE_SIZE,
} from './lib/hitachi-energy-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'hitachi-energy.json');

const COMPANY_KEY = 'hitachi-energy';
const COMPANY_NAME = 'Hitachi Energy';
const COMPANY_HOST = 'www.hitachienergy.com';
const COMPANY_DOMAIN = 'hitachienergy.com';
const CAREERS_URL = 'https://www.hitachienergy.com/careers/open-jobs';
const LISTING_API = 'https://www.hitachienergy.com/careers/open-jobs/_jcr_content/root/container/content_1/content/grid_0/joblist.listsearchresults.json';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
const MAX_PAGES = Number(process.env.HITACHI_MAX_PAGES) || 10;
const MAX_DETAIL_PAGES = Number(process.env.HITACHI_MAX_DETAIL_PAGES) || 80;
const DETAIL_DELAY_MS = 1200;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    company.includes('hitachi energy') ||
    url.includes('hitachienergy.com/careers/open-jobs/details')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'www.hitachienergy.com' || host === 'hitachienergy.com';
  } catch {
    return false;
  }
}

function inferCategory(title = '', jobFunction = '') {
  const haystack = normalize(`${title} ${jobFunction}`);
  if (/engineer|ingegnere|entwickl|r&d|research/i.test(haystack)) return 'engineering';
  if (/project.*manag|project.*lead|programme/i.test(haystack)) return 'project-management';
  if (/sales|vendita|marketing|product.*manage/i.test(haystack)) return 'sales';
  if (/finance|finanz|controller|accounting/i.test(haystack)) return 'finance';
  if (/it |software|developer|architect|cyber/i.test(haystack)) return 'it';
  if (/supply.*chain|logistics|warehouse|procurement/i.test(haystack)) return 'logistics';
  if (/hse|health|safety|environment/i.test(haystack)) return 'safety';
  if (/quality|qualit/i.test(haystack)) return 'quality';
  if (/production|manufacturing|operator|assembl|monteur|tester/i.test(haystack)) return 'production';
  if (/intern|stage|werkstudent|trainee/i.test(haystack)) return 'internship';
  if (/hr |human.*resource|people/i.test(haystack)) return 'hr';
  if (/commissioning|service|field/i.test(haystack)) return 'service';
  return 'engineering';
}

function inferSector(jobFunction = '') {
  const fn = normalize(jobFunction);
  if (fn.includes('engineering') || fn.includes('science')) return 'Ingegneria Energetica';
  if (fn.includes('it') || fn.includes('telecom')) return 'IT & Telecomunicazioni';
  if (fn.includes('finance')) return 'Finanza';
  if (fn.includes('sales') || fn.includes('marketing')) return 'Vendita & Marketing';
  if (fn.includes('supply')) return 'Logistica';
  if (fn.includes('production') || fn.includes('skilled')) return 'Produzione';
  if (fn.includes('project') || fn.includes('program')) return 'Project Management';
  if (fn.includes('intern')) return 'Stage & Formazione';
  if (fn.includes('quality')) return 'Qualità';
  if (fn.includes('legal') || fn.includes('compliance')) return 'Legale & Compliance';
  if (fn.includes('general')) return 'Management';
  return 'Energia & Tecnologia';
}

function mapEmploymentType(jobType = '', contractType = '') {
  const jt = normalize(jobType);
  const ct = normalize(contractType);
  if (ct.includes('intern') || ct.includes('trainee')) return 'internship';
  if (jt.includes('part time') || jt.includes('part-time')) return 'part-time';
  return 'full-time';
}

async function fetchAllListings() {
  console.log('🔍 Fetching Hitachi Energy Switzerland jobs via API...');

  const allItems = [];
  const seenIds = new Set();

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const url = `${LISTING_API}?location=Switzerland${offset > 0 ? `&offset=${offset}` : ''}`;
    console.log(`  📄 Page ${page + 1} (offset=${offset}): ${url}`);

    let json;
    try {
      json = await fetchJson(url);
    } catch (err) {
      console.log(`  ⚠️ API page ${page + 1} fetch failed: ${err.message}`);
      break;
    }

    const items = parseHitachiEnergyListingJson(json);
    const newItems = items.filter((item) => !seenIds.has(item.jobId));
    if (newItems.length === 0) break;

    for (const item of newItems) {
      seenIds.add(item.jobId);
      allItems.push(item);
    }
    console.log(`     Found ${newItems.length} new jobs (total: ${allItems.length})`);

    if (!hasMorePages(json)) break;
    await sleep(800);
  }

  console.log(`📋 Total Switzerland listings: ${allItems.length}`);
  return allItems;
}

async function enrichWithDetails(listings) {
  // Only enrich Ticino-relevant jobs with descriptions
  const ticinoJobs = listings.filter((job) =>
    isHitachiEnergyTicinoRelevant(job.location) ||
    isHitachiEnergyTicinoRelevant(job.primaryLocation),
  );

  console.log(`\n📍 Ticino/GR-relevant jobs: ${ticinoJobs.length} / ${listings.length}`);

  if (ticinoJobs.length === 0) return [];

  const toFetch = ticinoJobs.slice(0, MAX_DETAIL_PAGES);
  console.log(`🔎 Fetching up to ${toFetch.length} detail pages...`);

  const enriched = [];
  for (let i = 0; i < toFetch.length; i++) {
    const item = toFetch[i];
    try {
      const html = await fetchText(item.url);
      const description = parseHitachiEnergyDetailPage(html);
      enriched.push({ ...item, description });
      if ((i + 1) % 5 === 0) {
        console.log(`  ✅ ${i + 1}/${toFetch.length} detail pages fetched`);
      }
    } catch (err) {
      console.log(`  ⚠️ Detail fetch failed for JID3-${item.jobId}: ${err.message}`);
      enriched.push({ ...item, description: '' });
    }
    if (i < toFetch.length - 1) await sleep(DETAIL_DELAY_MS);
  }

  return enriched;
}

function buildHitachiJob(row) {
  const localized = buildHitachiEnergyLocalizedContent(row);
  const canton = inferHitachiEnergyCanton(row.primaryLocation || row.location);
  const primaryLoc = String(row.primaryLocation || row.location || '').split(',')[0].trim();

  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: row.url,
    applyUrl: row.applyUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: row.primaryLocation || row.location || 'Switzerland',
    addressLocality: primaryLoc || 'Switzerland',
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferCategory(row.title, row.jobFunction),
    sector: inferSector(row.jobFunction),
    source: 'hitachi-energy-dedicated-crawler',
    sourceLang: detectLang(`${row.title} ${row.description}`, 'en'),
    postedDate: row.publicationDate || new Date().toISOString().slice(0, 10),
    employmentType: mapEmploymentType(row.jobType, row.contractType),
    contractType: normalize(row.contractType) || 'full-time',
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
  printCrawlChangeSummary(diff, 'Hitachi Energy');
  writeCrawlChangeSummaryToGH(diff, 'Hitachi Energy');
  writeJobsSummary(mergedTarget, 'Hitachi Energy');
  printPublishedJobUrls(mergedTarget, 'Hitachi Energy');
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
    seedUrls: [`${CAREERS_URL}?filterable587622750-location=Switzerland`],
    notes: 'Dedicated Hitachi Energy crawler uses the AEM JSON listing API filtered to Switzerland, then filters for Ticino/GR locations. Descriptions enriched from detail pages.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_HITACHI_STRICT',
    label: 'Hitachi Energy',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_hitachi_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Hitachi Energy Ticino/GR jobs found after dedicated crawl.',
    detectSourceLang: () => 'en',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Hitachi Energy');
  console.log('═══════════════════════════════════════════════');
  console.log('  Hitachi Energy — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}`);
  console.log(`  API: ${LISTING_API}\n`);

  const listings = await fetchAllListings();
  if (listings.length === 0) {
    console.log('⚠️ No Switzerland listings found on Hitachi Energy — skipping.');
    updateAdapterConfig([]);
    return;
  }

  const enrichedListings = await enrichWithDetails(listings);

  if (enrichedListings.length === 0) {
    console.log('⚠️ No Ticino/GR-relevant jobs found in Switzerland listings — updating adapter with 0 jobs.');
    mergeJobs([]);
    updateAdapterConfig([]);
    validateLocales();
    return;
  }

  // Deduplicate by job ID
  const seenIds = new Map();
  const deduplicated = [];
  for (const listing of enrichedListings) {
    if (!seenIds.has(listing.jobId)) {
      seenIds.set(listing.jobId, listing);
      deduplicated.push(listing);
    }
  }
  if (deduplicated.length < enrichedListings.length) {
    console.log(`🔄 Deduplicated: ${enrichedListings.length} → ${deduplicated.length} unique jobs`);
  }

  const allBuilt = deduplicated.map(buildHitachiJob);
  const jobs = allBuilt.filter((job) => {
    const loc = String(job.addressLocality || job.location || '');
    if (isLocationExplicitlyForeign(loc)) {
      console.log(`  ⏭️  Skipped foreign location: ${loc} — ${job.title}`);
      return false;
    }
    return true;
  });
  if (jobs.length < allBuilt.length) {
    console.log(`🌍 Foreign location filter: ${allBuilt.length} → ${jobs.length} Swiss jobs`);
  }

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Hitachi Energy jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n📊 === Hitachi Energy Job Stats ===');
  console.log(`  🏢 Total Hitachi Energy jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Hitachi Energy',
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
  console.error(`❌ Hitachi Energy crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
