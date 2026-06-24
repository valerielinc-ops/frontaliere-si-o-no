#!/usr/bin/env node
/**
 * Allianz Suisse — Dedicated Crawler
 *
 * Crawls https://recruitingapp-2872.umantis.com/Jobs/All (Abacus-Umantis ATS)
 * 1. POSTs the Umantis listing UNFILTERED (national, no region facet) → extracts vacancy IDs
 * 2. Fetches each detail page (Italian) → extracts title, location, description
 * 3. Keeps CH jobs (per-job canton via inferAllianzCanton → inferAnyCanton, all 26 cantons)
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
  parseAllianzListingPage,
  parseAllianzDetailPage,
  buildAllianzLocalizedContent,
  inferAllianzCanton,
} from './lib/allianz-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'allianz-suisse.json');

const COMPANY_KEY = 'allianz-suisse';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Allianz Suisse';
const COMPANY_HOST = 'recruitingapp-2872.umantis.com';
const COMPANY_DOMAIN = 'umantis.com';
const CAREERS_URL = 'https://recruitingapp-2872.umantis.com/Jobs/All';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
const MAX_DETAIL_PAGES = Number(process.env.ALLIANZ_MAX_DETAIL_PAGES) || 100000;
const DETAIL_DELAY_MS = 1000;

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
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

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || TIMEOUT_MS);
  try {
    const fetchOptions = {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereBot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'it-CH,it;q=0.9,de;q=0.5',
        ...(options.headers || {}),
      },
    };
    if (options.method) fetchOptions.method = options.method;
    if (options.body) {
      fetchOptions.body = options.body;
      fetchOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const resp = await fetch(url, fetchOptions);
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
    key === 'allianz' ||
    company.includes('allianz suisse') ||
    url.includes('recruitingapp-2872.umantis.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'recruitingapp-2872.umantis.com';
  } catch {
    return false;
  }
}

function inferCategory(title = '') {
  const haystack = normalize(title);
  if (/previd|pension|vorsorge|prévoyance/i.test(haystack)) return 'insurance';
  if (/vendite|responsabile.*vend|sales|verkauf/i.test(haystack)) return 'sales';
  if (/consulen|berater|consult|conseill/i.test(haystack)) return 'sales';
  if (/innendienst|servizio interno|admin|back.?office/i.test(haystack)) return 'admin';
  if (/broker|makler/i.test(haystack)) return 'insurance';
  return 'insurance';
}

function inferLocation(listing, detail) {
  const loc = detail?.location || listing.location || '';
  if (loc) return loc;
  const agency = (detail?.agency || listing.agency || '').toLowerCase();
  if (agency.includes('bellinzona')) return 'Bellinzona';
  if (agency.includes('lugano')) return 'Lugano';
  if (agency.includes('chur') || agency.includes('graubünden')) return 'Chur';
  return '';
}

async function fetchAllListings() {
  console.log('🔍 Fetching Allianz Suisse listing pages (CH-wide, unfiltered)...');

  const allItems = [];
  const seenIds = new Set();

  // CH-wide: no searchSkill1004 region filter → the Umantis /Jobs/All listing
  // returns the full national set. Per-job canton is resolved downstream by
  // inferAllianzCanton (inferAnyCanton over agency+location, all 26 cantons),
  // which also drops non-CH/unresolved postings.
  const filterBody = 'Search=Suchen';
  let page = 1;
  const maxPages = 30;

  while (page <= maxPages) {
    const url = page === 1 ? CAREERS_URL : `${CAREERS_URL}?tc1152481=p${page}&_search_token1152481=*`;

    console.log(`  📄 Page ${page}: POST ${url}`);
    let html;
    try {
      html = await fetchText(url, { method: 'POST', body: filterBody });
    } catch (err) {
      console.log(`  ⚠️ Page ${page} fetch failed: ${err.message}`);
      break;
    }

    const items = parseAllianzListingPage(html);
    const newItems = items.filter((item) => !seenIds.has(item.vacancyId));
    if (newItems.length === 0) break;

    for (const item of newItems) {
      seenIds.add(item.vacancyId);
      allItems.push(item);
    }
    console.log(`     Found ${newItems.length} new jobs (total: ${allItems.length})`);

    if (items.length < 10) break;

    page += 1;
    await sleep(DETAIL_DELAY_MS);
  }

  console.log(`\n📋 Total unique national listings: ${allItems.length}`);
  return allItems;
}

// Umantis publishes each vacancy only in its own language; the `/Description/4`
// (Italian) URL returns a content-less shell for German/French jobs, so the old
// hardcoded-`/4` fetch grabbed the page chrome → most jobs shared the same
// body+title (the duplicate-listings audit critical). Probe every language code
// and keep the variant whose parsed body carries the most real text.
const DESCRIPTION_LANG_CODES = [4, 1, 3, 2]; // IT first (target locale), then DE/EN/FR

async function fetchBestDetail(item) {
  let best = null;
  let bestLen = 0;
  for (const code of DESCRIPTION_LANG_CODES) {
    const url = `https://${COMPANY_HOST}/Vacancies/${item.vacancyId}/Description/${code}`;
    let html;
    try {
      html = await fetchText(url);
    } catch {
      continue;
    }
    const detail = parseAllianzDetailPage(html, item.title, item.location);
    const len = (detail.description || '').replace(/\s+/g, ' ').trim().length;
    if (len > bestLen) {
      bestLen = len;
      best = detail;
    }
    // First sufficiently-rich variant wins — avoids probing all 4 codes per job.
    if (bestLen >= 300) break;
  }
  return best || parseAllianzDetailPage('', item.title, item.location);
}

async function enrichWithDetails(listings) {
  const enriched = [];
  const toFetch = listings.slice(0, MAX_DETAIL_PAGES);

  console.log(`\n🔎 Fetching up to ${toFetch.length} detail pages...`);

  for (let i = 0; i < toFetch.length; i++) {
    const item = toFetch[i];
    try {
      const detail = await fetchBestDetail(item);
      enriched.push({
        ...item,
        title: detail.title || item.title,
        agency: detail.agency || item.agency,
        location: inferLocation(item, detail),
        description: detail.description || '',
        contractType: detail.contractType || '',
      });
      console.log(`  ✅ [${i + 1}/${toFetch.length}] ${item.vacancyId}: ${detail.title || item.title} — ${inferLocation(item, detail)} (${(detail.description || '').length} chars)`);
    } catch (err) {
      console.log(`  ⚠️ Detail fetch failed for ${item.vacancyId}: ${err.message}`);
      enriched.push({
        ...item,
        description: '',
        contractType: '',
      });
    }
    if (i < toFetch.length - 1) await sleep(DETAIL_DELAY_MS);
  }

  // CH-wide relevance after detail enrichment: keep jobs whose canton resolves
  // to a Swiss canton (inferAllianzCanton → inferAnyCanton over all 26); drop
  // non-CH/unresolved.
  const relevant = [];
  for (const job of enriched) {
    const canton = inferAllianzCanton(job.agency || '', job.location || '');
    if (canton) {
      job._canton = canton;
      relevant.push(job);
    }
  }
  const cantonCounts = {};
  for (const j of relevant) cantonCounts[j._canton] = (cantonCounts[j._canton] || 0) + 1;
  const spread = Object.entries(cantonCounts).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join(', ');
  console.log(`\n📍 CH jobs after enrichment: ${relevant.length} / ${enriched.length} — ${spread}`);
  return relevant;
}

function buildAllianzJob(row) {
  const localized = buildAllianzLocalizedContent(row);
  const location = row.location || '';
  const canton = row._canton || DEFAULT_CANTON;
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
    category: inferCategory(row.title),
    sector: 'Assicurazioni',
    source: 'allianz-dedicated-crawler',
    sourceLang: detectLang(`${row.title} ${row.description}`, 'it'),
    postedDate: new Date().toISOString().slice(0, 10),
    employmentType: 'full-time',
    contractType: row.contractType || 'full-time',
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
      title: job.title || prev.title,
      description: job.description || prev.description,
      location: job.location || prev.location,
      addressLocality: job.addressLocality || prev.addressLocality,
      applyUrl: job.applyUrl || prev.applyUrl,
      postedDate: job.postedDate || prev.postedDate,
      contractType: job.contractType || prev.contractType,
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
  printCrawlChangeSummary(diff, 'Allianz Suisse');
  writeCrawlChangeSummaryToGH(diff, 'Allianz Suisse');
  writeJobsSummary(mergedTarget, 'Allianz Suisse');
  printPublishedJobUrls(mergedTarget, 'Allianz Suisse');
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
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated Allianz Suisse crawler POSTs the Umantis listing unfiltered (national), fetches Italian detail pages. Keeps CH vacancies (canton via inferAllianzCanton).',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_ALLIANZ_STRICT',
    label: 'Allianz Suisse',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_allianz_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Allianz Suisse jobs found after dedicated crawl.',
    // Allianz Suisse posts in DE/FR/IT. The job's real source language is
    // detected per-row at crawl time (see `sourceLang: detectLang(...)` above),
    // so the locale validator MUST use that same per-job source — not a
    // hard-coded 'it'. With the old `() => 'it'`, a German-source job's `de`
    // field (legitimately equal to its German source) was flagged
    // `untranslated_description [de]`, hard-failing the crawler on a false
    // positive (#1878/#2003). Prefer the value already stamped on the job,
    // falling back to a fresh detection.
    detectSourceLang: (text, job) => job?.sourceLang || detectLang(text, 'it'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Allianz Suisse');
  console.log('═══════════════════════════════════════════════');
  console.log('  Allianz Suisse — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const listings = await fetchAllListings();
  if (listings.length === 0) {
    console.log('⚠️ No listings found on Allianz Suisse — skipping.');
    return;
  }

  const enrichedListings = await enrichWithDetails(listings);

  // Deduplicate by title (Allianz may list same role for different agencies)
  const seenTitles = new Map();
  const deduplicated = [];
  for (const listing of enrichedListings) {
    const key = normalize(listing.title) + '|' + normalize(listing.location);
    if (!seenTitles.has(key)) {
      seenTitles.set(key, listing);
      deduplicated.push(listing);
    }
  }
  if (deduplicated.length < enrichedListings.length) {
    console.log(`🔄 Deduplicated: ${enrichedListings.length} → ${deduplicated.length} unique title+location combinations`);
  }

  const jobs = deduplicated.map(buildAllianzJob);

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Allianz Suisse jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n📊 === Allianz Suisse Job Stats ===');
  console.log(`  🏢 Total Allianz Suisse jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Allianz Suisse',
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

main().catch((error) => exitCrawlerOnError(error, 'Allianz Suisse'));
