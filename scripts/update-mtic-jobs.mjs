#!/usr/bin/env node
/**
 * MTIC Group / SPS InterCert S.A. — Dedicated Crawler
 *
 * Crawls https://www.mtic-group.org/it/opportunita-di-lavoro (TYPO3 CMS)
 * 1. Fetches listing page → extracts jobs grouped by subsidiary
 * 2. Filters to Swiss subsidiary (SPS InterCert S.A., Lugano Paradiso)
 * 3. Fetches detail pages for enrichment (title, description, location)
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
  parseMticListingPage,
  parseMticDetailPage,
  buildMticLocalizedContent,
  isMticTicinoRelevant,
} from './lib/mtic-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'mtic-group.json');

const COMPANY_KEY = 'mtic-group';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'MTIC Group';
const COMPANY_HOST = 'www.mtic-group.org';
const COMPANY_DOMAIN = 'mtic-group.org';
const CAREERS_URL = 'https://www.mtic-group.org/it/opportunita-di-lavoro';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
const MAX_DETAIL_PAGES = Number(process.env.MTIC_MAX_DETAIL_PAGES) || 40;
const DETAIL_DELAY_MS = 800;

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
    key === 'sps-intercert' ||
    company.includes('mtic') ||
    company.includes('sps intercert') ||
    url.includes('mtic-group.org')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'www.mtic-group.org' ||
      host === 'mtic-group.org' ||
      host.endsWith('.mtic-group.org')
    );
  } catch {
    return false;
  }
}

function inferCategory(title = '', description = '') {
  const haystack = normalize(`${title} ${description}`);
  if (/audit|auditor/i.test(haystack)) return 'quality';
  if (/labor|laboratory|test|prova|tecnico/i.test(haystack)) return 'engineering';
  if (/medical|device|dispositiv|mdr/i.test(haystack)) return 'healthcare';
  if (/sales|vendita|commercial|back.?office/i.test(haystack)) return 'sales';
  if (/quality|qualità|assurance/i.test(haystack)) return 'quality';
  if (/certific|ispezione|inspect/i.test(haystack)) return 'engineering';
  if (/manager|director|responsabile/i.test(haystack)) return 'management';
  return 'engineering';
}

async function fetchAllListings() {
  console.log('🔍 Fetching MTIC Group listing page...');

  let html;
  try {
    html = await fetchText(CAREERS_URL);
  } catch (err) {
    console.log(`  ❌ Listing page fetch failed: ${err.message}`);
    return [];
  }

  const allItems = parseMticListingPage(html);
  console.log(`📋 Total listings found: ${allItems.length}`);

  // Log by subsidiary
  const bySub = {};
  for (const item of allItems) {
    const key = item.subsidiary || 'Unknown';
    bySub[key] = (bySub[key] || 0) + 1;
  }
  for (const [sub, count] of Object.entries(bySub)) {
    console.log(`  📌 ${sub}: ${count} positions`);
  }

  // Also check the SPS InterCert subdomain for additional jobs
  try {
    console.log('\n🔍 Checking SPS InterCert subdomain...');
    const spsHtml = await fetchText('https://spsintercertsa.mtic-group.org/it/opportunita-di-lavoro');
    const spsItems = parseMticListingPage(spsHtml);
    if (spsItems.length > 0) {
      console.log(`  📌 SPS InterCert subdomain: ${spsItems.length} additional positions`);
      // Mark them as Swiss
      for (const item of spsItems) {
        item.subsidiaryCountry = 'CH';
        item.subsidiary = 'SPS InterCert S.A.';
        item.subsidiaryLocation = 'Lugano Paradiso';
        // Deduplicate against main page listings
        const existingUrl = allItems.find(
          (e) => e.detailUrl.toLowerCase().replace(/\/$/, '') === item.detailUrl.toLowerCase().replace(/\/$/, ''),
        );
        if (!existingUrl) {
          allItems.push(item);
        }
      }
    } else {
      console.log('  ℹ️ No positions on SPS InterCert subdomain');
    }
  } catch (err) {
    console.log(`  ⚠️ SPS subdomain check failed: ${err.message}`);
  }

  return allItems;
}

async function enrichWithDetails(listings) {
  const enriched = [];
  const toFetch = listings.slice(0, MAX_DETAIL_PAGES);

  console.log(`\n🔎 Fetching up to ${toFetch.length} detail pages...`);

  for (let i = 0; i < toFetch.length; i++) {
    const item = toFetch[i];
    try {
      const html = await fetchText(item.detailUrl);
      const detail = parseMticDetailPage(html, item.title);
      enriched.push({
        ...item,
        title: detail.title || item.title,
        location: detail.location || item.subsidiaryLocation || '',
        description: detail.description || '',
        datePosted: detail.datePosted,
      });
      if ((i + 1) % 5 === 0) {
        console.log(`  ✅ ${i + 1}/${toFetch.length} detail pages fetched`);
      }
    } catch (err) {
      console.log(`  ⚠️ Detail fetch failed for ${item.detailUrl}: ${err.message}`);
      enriched.push({
        ...item,
        location: item.subsidiaryLocation || '',
        description: '',
        datePosted: new Date().toISOString().slice(0, 10),
      });
    }
    if (i < toFetch.length - 1) await sleep(DETAIL_DELAY_MS);
  }

  // Filter to Ticino-relevant only
  const ticino = enriched.filter((job) => isMticTicinoRelevant(job));
  console.log(`\n📍 Ticino-relevant jobs: ${ticino.length} / ${enriched.length}`);
  if (ticino.length === 0) {
    console.log('  ℹ️ SPS InterCert S.A. (Lugano Paradiso) currently has no open positions.');
    console.log('  ℹ️ The crawler will pick up new Swiss positions when they appear.');
  }
  return ticino;
}

function buildMticJob(row) {
  const localized = buildMticLocalizedContent(row);
  const location = row.location || row.subsidiaryLocation || 'Lugano Paradiso';

  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: row.detailUrl,
    applyUrl: row.detailUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location,
    addressLocality: location,
    addressRegion: 'TI',
    addressCountry: 'CH',
    canton: DEFAULT_CANTON,
    country: 'CH',
    category: inferCategory(row.title, row.description),
    sector: 'Certificazione e Ispezioni',
    source: 'mtic-dedicated-crawler',
    sourceLang: detectLang(`${row.title} ${row.description}`, 'it'),
    postedDate: row.datePosted || new Date().toISOString().slice(0, 10),
    employmentType: 'full-time',
    contractType: 'full-time',
    validThrough: '',
    description: localized.descriptionByLocale.it,
    titleByLocale: localized.titleByLocale,
    descriptionByLocale: localized.descriptionByLocale,
    slugByLocale: localized.slugByLocale,
  };
}

function jobMatchKey(job = {}) {
  return String(job.url || '').trim().toLowerCase() || String(job.slug || '').trim().toLowerCase();
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
  printCrawlChangeSummary(diff, 'MTIC Group');
  writeCrawlChangeSummaryToGH(diff, 'MTIC Group');
  writeJobsSummary(mergedTarget, 'MTIC Group');
  printPublishedJobUrls(mergedTarget, 'MTIC Group');
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
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL, 'https://spsintercertsa.mtic-group.org/it/opportunita-di-lavoro'],
    notes: 'Dedicated MTIC Group crawler. Reads TYPO3 listing page organized by subsidiary. Filters to SPS InterCert S.A. (Lugano Paradiso, CH) and other Swiss positions. Also checks SPS subdomain.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_MTIC_STRICT',
    label: 'MTIC Group',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_mtic_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No MTIC Group Swiss jobs found — SPS InterCert may have no current openings.',
    detectSourceLang: () => 'it',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'MTIC Group');
  console.log('═══════════════════════════════════════════════');
  console.log('  MTIC Group / SPS InterCert S.A. — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const listings = await fetchAllListings();
  if (listings.length === 0) {
    console.log('⚠️ No listings found on MTIC careers page — skipping.');
    mergeJobs([]);
    updateAdapterConfig([]);
    validateLocales();
    return;
  }

  const enrichedListings = await enrichWithDetails(listings);

  // Deduplicate by URL (some links appear in multiple sections)
  const seenUrls = new Map();
  const deduplicated = [];
  for (const listing of enrichedListings) {
    const key = normalize(listing.detailUrl).replace(/\/$/, '');
    if (!seenUrls.has(key)) {
      seenUrls.set(key, listing);
      deduplicated.push(listing);
    }
  }
  if (deduplicated.length < enrichedListings.length) {
    console.log(`🔄 Deduplicated: ${enrichedListings.length} → ${deduplicated.length} unique URLs`);
  }

  const jobs = deduplicated.map(buildMticJob);

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  if (jobs.length > 0) {
    console.log('\n🌐 Running locale fill for MTIC Group jobs...');
    await translateMissingJobLocales({
      dataJobsPath: DATA_JOBS,
      isTargetJob,
    });
  }

  validateLocales();

  console.log('\n📊 === MTIC Group Job Stats ===');
  console.log(`  🏢 Total MTIC Swiss jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'MTIC Group',
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
  console.error(`❌ MTIC Group crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
