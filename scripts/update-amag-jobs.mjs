#!/usr/bin/env node
/**
 * AMAG Group — Dedicated Crawler
 *
 * Crawls https://jobs.amag-group.ch (rexx systems ATS)
 * 1. Fetches Italian listing (/it) — pre-filtered to Ticino
 * 2. Also scans German listing (/de) for TI/GR locations not in /it
 * 3. Fetches each detail page → extracts JSON-LD JobPosting
 * 4. Filters TI/GR-relevant jobs via shared inferSwissTargetCanton()
 * 5. Merges into data/jobs.json
 * 6. Updates adapter config
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
  parseAmagListingPage,
  parseAmagDetailPage,
  buildAmagLocalizedContent,
  inferAmagCanton,
} from './lib/amag-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'amag-group.json');

const COMPANY_KEY = 'amag-group';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'AMAG Group';
const COMPANY_HOST = 'jobs.amag-group.ch';
const COMPANY_DOMAIN = 'amag-group.ch';
const CAREERS_URL_IT = 'https://jobs.amag-group.ch/it';
const CAREERS_URL_DE = 'https://jobs.amag-group.ch/de';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
const MAX_DETAIL_PAGES = Number(process.env.AMAG_MAX_DETAIL_PAGES) || 60;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereBot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'it-CH,it;q=0.9,de;q=0.5',
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    return await resp.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    key === 'amag' ||
    company.includes('amag group') ||
    company.includes('amag') ||
    url.includes('jobs.amag-group.ch') ||
    url.includes('jobs.amag.ch')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'jobs.amag-group.ch' || host === 'jobs.amag.ch';
  } catch {
    return false;
  }
}

function inferCategory(title = '', description = '') {
  const haystack = normalize(`${title} ${description}`);
  if (/apprendist|lehrling|apprenti|azubi/i.test(haystack)) return 'apprenticeship';
  if (/meccanico|meccatronico|mechanik|mechatronik/i.test(haystack)) return 'automotive';
  if (/logistic|magazzin|lager/i.test(haystack)) return 'logistics';
  if (/vendita|sales|verkauf|vente/i.test(haystack)) return 'sales';
  if (/manager|direttore|leiter|responsabile/i.test(haystack)) return 'management';
  if (/admin|impiegat|büro|sachbearbeit/i.test(haystack)) return 'admin';
  return 'automotive';
}

function mapEmploymentType(rawType = '') {
  const t = normalize(rawType);
  if (t.includes('full') || t.includes('vollzeit') || t.includes('pieno')) return 'full-time';
  if (t.includes('part') || t.includes('teilzeit') || t.includes('parziale')) return 'part-time';
  if (t.includes('intern') || t.includes('praktik') || t.includes('stage')) return 'internship';
  return 'full-time';
}

async function fetchAllListings() {
  console.log('🔍 Fetching AMAG Group listing pages...');

  const allItems = new Map(); // keyed by jobId

  // 1. Fetch Italian listing (pre-filtered to Ticino)
  console.log(`  📄 Italian listing: ${CAREERS_URL_IT}`);
  try {
    const htmlIt = await fetchText(CAREERS_URL_IT);
    const itemsIt = parseAmagListingPage(htmlIt);
    for (const item of itemsIt) {
      allItems.set(item.jobId, item);
    }
    console.log(`     Found ${itemsIt.length} jobs from Italian listing`);
  } catch (err) {
    console.log(`  ⚠️ Italian listing fetch failed: ${err.message}`);
  }

  await sleep(DETAIL_DELAY_MS);

  // 2. Fetch German listing (full list) and filter for TI/GR locations
  console.log(`  📄 German listing: ${CAREERS_URL_DE}`);
  try {
    const htmlDe = await fetchText(CAREERS_URL_DE);
    const itemsDe = parseAmagListingPage(htmlDe);
    let extraCount = 0;
    for (const item of itemsDe) {
      if (allItems.has(item.jobId)) continue;
      if (inferAmagCanton(item.location, '')) {
        allItems.set(item.jobId, item);
        extraCount++;
      }
    }
    console.log(`     Found ${itemsDe.length} total jobs, ${extraCount} extra TI/GR jobs not in Italian listing`);
  } catch (err) {
    console.log(`  ⚠️ German listing fetch failed: ${err.message}`);
  }

  const listings = [...allItems.values()];
  console.log(`📋 Total unique TI/GR listings: ${listings.length}`);
  return listings;
}

async function enrichWithDetails(listings) {
  const enriched = [];
  const toFetch = listings.slice(0, MAX_DETAIL_PAGES);

  console.log(`\n🔎 Fetching up to ${toFetch.length} detail pages...`);

  for (let i = 0; i < toFetch.length; i++) {
    const item = toFetch[i];
    try {
      const html = await fetchText(item.detailUrl);
      const detail = parseAmagDetailPage(html, item.title);

      // If Italian page has no description, fall back to German detail URL
      if (!detail.description) {
        const deUrl = item.detailUrl.replace(/-it-j(\d+)\.html$/, '-de-j$1.html');
        if (deUrl !== item.detailUrl) {
          try {
            await sleep(DETAIL_DELAY_MS);
            const htmlDe = await fetchText(deUrl);
            const detailDe = parseAmagDetailPage(htmlDe, item.title);
            if (detailDe.description) {
              console.log(`  🔄 [${i + 1}/${toFetch.length}] ${item.jobId}: Using German description fallback`);
              detail.description = detailDe.description;
            }
          } catch (err) {
            console.log(`  ⚠️ German fallback failed for ${item.jobId}: ${err.message}`);
          }
        }
      }

      const location = detail.location || item.location || '';
      const region = detail.region || '';

      // Verify TI/GR relevance after detail enrichment
      const canton = inferAmagCanton(location, region) || inferAmagCanton(item.location, '');
      if (!canton) {
        console.log(`  ⏭️ [${i + 1}/${toFetch.length}] ${item.jobId}: Skipped (not TI/GR: ${location})`);
        continue;
      }

      enriched.push({
        ...item,
        title: detail.title || item.title,
        location: location || (canton === 'GR' ? 'Graubünden' : 'Ticino'),
        region: region || canton,
        _canton: canton,
        postalCode: detail.postalCode || '',
        streetAddress: detail.streetAddress || '',
        description: detail.description || '',
        datePosted: detail.datePosted || '',
        validThrough: detail.validThrough || '',
        employmentType: detail.employmentType || '',
      });
      console.log(`  ✅ [${i + 1}/${toFetch.length}] ${item.jobId}: ${detail.title || item.title} — ${location}`);
    } catch (err) {
      const msg = String(err?.message || err);
      // 404/410 mean the job was delisted upstream while still in the listing cache.
      // Skip it entirely so the thin-source validator does not fail the whole run.
      if (/HTTP (404|410)\b/.test(msg)) {
        console.log(`  ⏭️ [${i + 1}/${toFetch.length}] ${item.jobId}: Skipped (upstream removed: ${msg})`);
      } else {
        console.log(`  ⚠️ Detail fetch failed for ${item.jobId}: ${msg}`);
        enriched.push({
          ...item,
          description: '',
          datePosted: new Date().toISOString().slice(0, 10),
          validThrough: '',
          employmentType: 'FULL_TIME',
        });
      }
    }
    if (i < toFetch.length - 1) await sleep(DETAIL_DELAY_MS);
  }

  const tiCount = enriched.filter((j) => j._canton === 'TI').length;
  const grCount = enriched.filter((j) => j._canton === 'GR').length;
  console.log(`\n📍 Target jobs after enrichment: ${enriched.length} (TI: ${tiCount}, GR: ${grCount})`);
  return enriched;
}

function buildAmagJob(row) {
  const localized = buildAmagLocalizedContent(row);
  const canton = row._canton || inferAmagCanton(row.location, row.region) || DEFAULT_CANTON;
  const location = row.location || (canton === 'GR' ? 'Graubünden' : 'Ticino');
  const empType = mapEmploymentType(row.employmentType);

  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: row.detailUrl,
    applyUrl: row.applyUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location,
    addressLocality: location,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferCategory(row.title, row.description),
    sector: 'Automotive & Mobilità',
    source: 'amag-dedicated-crawler',
    sourceLang: detectLang(`${row.title} ${row.description}`, 'it'),
    postedDate: row.datePosted || new Date().toISOString().slice(0, 10),
    employmentType: empType,
    contractType: empType,
    validThrough: row.validThrough || '',
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
      title: job.title || prev.title,
      description: job.description || prev.description,
      location: job.location || prev.location,
      addressLocality: job.addressLocality || prev.addressLocality,
      applyUrl: job.applyUrl || prev.applyUrl,
      postedDate: job.postedDate || prev.postedDate,
      validThrough: job.validThrough || prev.validThrough,
      contractType: job.contractType || prev.contractType,
      employmentType: job.employmentType || prev.employmentType,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, job.descriptionByLocale, 30),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3),
      source: job.source,
    };
  });

  const merged = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, merged);
  if (fs.existsSync(path.dirname(PUBLIC_JOBS))) {
    writeJson(PUBLIC_JOBS, merged);
  }

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'AMAG Group');
  writeCrawlChangeSummaryToGH(diff, 'AMAG Group');
  writeJobsSummary(mergedTarget, 'AMAG Group');
  printPublishedJobUrls(mergedTarget, 'AMAG Group');
  return { total: mergedTarget.length, added, updated, diff };
}

function updateAdapterConfig(jobs) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = {
      location: job.location,
      canton: job.canton || DEFAULT_CANTON,
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
    crawlerModes: ['html', 'jsonld'],
    seedUrls: [CAREERS_URL_IT],
    notes: 'Dedicated AMAG Group crawler fetches Italian listing (pre-filtered to Ticino) + German full listing for TI/GR jobs, enriches with JSON-LD JobPosting from detail pages.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_AMAG_STRICT',
    label: 'AMAG Group',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_amag_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No AMAG Group jobs found after dedicated crawl.',
    detectSourceLang: () => 'it',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'AMAG Group');
  console.log('═══════════════════════════════════════════════');
  console.log('  AMAG Group — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL_IT}\n`);

  const listings = await fetchAllListings();
  if (listings.length === 0) {
    console.log('⚠️ No TI/GR listings found on AMAG — skipping.');
    return;
  }

  const enrichedListings = await enrichWithDetails(listings);

  // Deduplicate by title+location
  const seenKeys = new Map();
  const deduplicated = [];
  for (const listing of enrichedListings) {
    const key = normalize(listing.title) + '|' + normalize(listing.location);
    if (!seenKeys.has(key)) {
      seenKeys.set(key, listing);
      deduplicated.push(listing);
    }
  }
  if (deduplicated.length < enrichedListings.length) {
    console.log(`🔄 Deduplicated: ${enrichedListings.length} → ${deduplicated.length} unique title+location combinations`);
  }

  const jobs = deduplicated.map(buildAmagJob);

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for AMAG Group jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n📊 === AMAG Group Job Stats ===');
  console.log(`  🏢 Total AMAG Group jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'AMAG Group',
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
  console.error(`❌ AMAG Group crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
