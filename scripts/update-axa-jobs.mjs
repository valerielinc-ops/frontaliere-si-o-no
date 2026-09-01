#!/usr/bin/env node
/**
 * AXA Svizzera — Dedicated Crawler
 *
 * AXA Svizzera is a national insurer (HQ Winterthur), so this crawler collects
 * jobs CH-wide across all 26 cantons — NOT filtered to any region.
 *
 * Crawls https://jobs.axa.ch/ (Prospective.ch Career Center)
 * 1. Fetches the national listing (no region facet), paginated via offset/limit
 * 2. Fetches each detail page → extracts description, workload, location, apply URL
 * 3. Resolves each job's Swiss canton from the clean city signal; drops jobs
 *    whose canton does not resolve to one of the 26 Swiss cantons
 * 4. Merges into data/jobs.json
 * 5. Updates adapter config
 */

import fs from 'node:fs';
import os from 'node:os';
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
  stableSlugHash,
  captureLostSlugs,
} from './lib/dedicated-crawler-common.mjs';
import {
  parseAxaListingPage,
  parseAxaDetailPage,
  buildAxaLocalizedContent,
  inferAxaCanton,
  inferAxaCategory,
  extractUuidFromUrl,
  buildDetailUrl,
  buildListingUrl,
  BASE_URL,
} from './lib/axa-job-parser.mjs';
import { exitCrawlerOnError, fetchHtml } from './lib/crawler-template.mjs';
import { inferAnyCanton, rescueSwissCityFromText } from './lib/target-swiss-locations.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// Per-crawler-scoped scratch path (never shared with sibling crawlers in the
// same crawler-group CI job -- no cross-process race possible by construction).
const SCRATCH_KEY = path.basename(fileURLToPath(import.meta.url), '.mjs');
const DATA_JOBS = path.join(os.tmpdir(), `frontaliere-jobs-scratch-${SCRATCH_KEY}.json`);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'axa-svizzera.json');

const COMPANY_KEY = 'axa-svizzera';
const COMPANY_NAME = 'AXA Svizzera';
const COMPANY_HOST = 'jobs.axa.ch';
const COMPANY_DOMAIN = 'axa.ch';
const CAREERS_URL = 'https://jobs.axa.ch/?lang=it';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
const MAX_DETAIL_PAGES = Number(process.env.AXA_MAX_DETAIL_PAGES) || 100000;
const DETAIL_DELAY_MS = 300;
const DETAIL_CONCURRENCY = 4;

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

function slugify(value = '') {
  const slug = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return truncateSlugAtWordBoundary(slug, 180);
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
  // Delegates to the shared resilient fetchHtml (retry/backoff + clean-IP proxy
  // fallback + 200-challenge rescue). The `retries` param is retained for the
  // call-site signature; backoff is now handled inside fetchHtml.
  void retries;
  return fetchHtml(url, {
    timeoutMs: TIMEOUT_MS,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8,de;q=0.7,fr;q=0.6',
    },
  });
}

const LISTING_PAGE_LIMIT = 500;
const LISTING_MAX_OFFSET = 5000; // safety cap; AXA national set is ~160 jobs

/**
 * Fetch the national listing (no region facet), paginating offset/limit until a
 * page yields no new jobs. Collects all job summaries CH-wide.
 */
async function fetchAllListings() {
  const allJobs = new Map();

  for (let offset = 0; offset <= LISTING_MAX_OFFSET; offset += LISTING_PAGE_LIMIT) {
    const url = buildListingUrl('it', offset, LISTING_PAGE_LIMIT);
    console.log(`\n📋 Fetching national listing (offset ${offset}): ${url}`);

    let jobs;
    try {
      const html = await fetchText(url);
      jobs = parseAxaListingPage(html);
      console.log(`  ✅ Found ${jobs.length} jobs on this page`);
    } catch (err) {
      console.log(`  ⚠️ Failed to fetch listing at offset ${offset}: ${err.message}`);
      break;
    }

    let added = 0;
    for (const job of jobs) {
      const uuid = extractUuidFromUrl(job.url);
      if (uuid && !allJobs.has(uuid)) {
        allJobs.set(uuid, { ...job, uuid });
        added += 1;
      }
    }

    // Stop when a page adds no new vacancies (end of the national set).
    if (added === 0) break;
    await sleep(DETAIL_DELAY_MS);
  }

  console.log(`\n📊 Total unique national jobs: ${allJobs.size}`);
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

  // Keep only jobs whose canton resolves to one of the 26 Swiss cantons.
  // Canton is inferred from the cleanest single city signal (listing
  // .place-of-work first, then detail location/address) — never defaulted to
  // TI. Unresolved / foreign locations are dropped.
  const relevant = [];
  for (const job of enriched) {
    let canton = inferAxaCanton(job.listingCity, job.location, job.address);
    if (!canton) {
      // jobs.axa.ch is AXA Switzerland's own dedicated national portal — a
      // job scraped from it is Swiss by construction, so an unresolved
      // canton here means the city text didn't parse, not that the job is
      // foreign. Try a real Swiss city named in the description before
      // dropping — still never defaulted to TI, only a positively-found
      // city counts.
      const rescueCity = rescueSwissCityFromText(job.description || '');
      canton = rescueCity ? inferAnyCanton(rescueCity) : '';
    }
    if (canton) {
      relevant.push({ ...job, canton });
    }
  }

  console.log(`\n📍 Swiss-canton jobs: ${relevant.length} / ${enriched.length}`);
  return relevant;
}

/**
 * Build a regenerated AXA slug with a stable per-vacancy disambiguator suffix.
 *
 * AXA publishes multiple legitimate openings for the same role at different
 * (or even the same) Ticino cities — e.g. several "Consulente Assicurativo"
 * positions across Lugano, Manno, Biasca. The previous formula `slugify(title)`
 * collapsed those distinct postings to a single slug, and the housekeeping
 * dedup pass silently removed the duplicates: the audit at
 * /tmp/housekeeping-audit-2026-04-07.md identified 16 silent losses over 30
 * days in axa-svizzera.
 *
 * Each AXA vacancy URL contains a unique UUID under
 * `/posizioni-aperte/{slug}/{uuid}`. `stableSlugHash(job)` derives a 6-char
 * hash from `fingerprintJob(job)`, which falls back to the canonical URL when
 * no path-id pattern matches — so each vacancy gets a unique deterministic
 * suffix that survives across crawl runs.
 *
 * Pure function: no I/O, no module-level state. Exported for tests.
 *
 * @param {object} job - Job-like object with at least { title, url } populated
 * @param {string} location - Resolved AXA city (e.g. "Lugano")
 * @returns {string} Regenerated slug, length-capped at 90 chars
 */
export function buildAxaRegeneratedSlug(job, location) {
  const suffix = stableSlugHash(job) || '';
  const baseInput = `${job?.title || ''}-axa-${location || ''}`;
  const baseSlug = baseInput
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!baseSlug) return '';
  if (!suffix) return truncateSlugAtWordBoundary(baseSlug, 200);
  const baseMaxLen = Math.max(0, 90 - (suffix.length + 1));
  const trimmedBase = truncateSlugAtWordBoundary(baseSlug, baseMaxLen).replace(/-+$/, '');
  return trimmedBase ? `${trimmedBase}-${suffix}` : suffix;
}

export function buildAxaJob(row) {
  const localized = buildAxaLocalizedContent(row, row.excerpt || '');
  // Reuse the canton resolved during filtering when present; otherwise resolve
  // from the clean city signals (listing city → detail location → address).
  const canton = row.canton || inferAxaCanton(row.listingCity, row.location, row.address);
  const category = inferAxaCategory(row.title, row.description);
  const detailUrl = row.detailUrl || row.url;

  // Resolve the per-job city BEFORE building the slug so we never collapse
  // multiple openings of the same role to the same slug. Falling back to
  // `addressLocality = COMPANY_DEFAULTS['axa-svizzera']` (Lugano) is the Lidl
  // trap that triggers `hardenJobLocaleFields` to re-derive the slug from
  // `[title, company, defaultAddressLocality]` and silently dedup losers.
  // Swiss address format is "Street N, PostalCode City" — prefer the listing
  // location field, then fall back to the post-postal-code segment of the
  // street address. The first segment of split(',') is the street, never the
  // city.
  const isUsableCity = (value) => {
    const v = String(value || '').trim();
    if (!v) return false;
    if (v.length < 2) return false;
    // Reject parser junk like "()", "[]", "-", and pure-punctuation strings.
    if (!/[a-zA-Z]/.test(v)) return false;
    return true;
  };
  const addressLocality = (() => {
    // Prefer the clean listing city, then the detail location, then the
    // post-postal-code city segment of the Swiss address.
    const fromListing = String(row.listingCity || '').trim();
    if (isUsableCity(fromListing)) return fromListing;
    const fromLocation = String(row.location || '').trim();
    if (isUsableCity(fromLocation)) return fromLocation;
    const segments = String(row.address || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length === 0) return '';
    const last = segments[segments.length - 1] || '';
    const cityFromLast = last.replace(/^\d{4}\s*/, '').trim();
    if (isUsableCity(cityFromLast)) return cityFromLast;
    return last;
  })();
  // CH-wide crawler: no TI default. Fall back to the canton display name when
  // no city is parseable, never to 'Ticino'.
  const resolvedLocation = addressLocality || canton || '';
  const slug = buildAxaRegeneratedSlug(
    { title: row.title, url: detailUrl },
    resolvedLocation,
  );

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
    location: resolvedLocation,
    addressLocality,
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
    const merged = {
      ...prev,
      ...job,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, job.descriptionByLocale, 30, job.sourceLang),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3),
    };
    captureLostSlugs(merged, prev.slugByLocale, prev.slug, 20);
    return merged;
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
    notes: 'Dedicated AXA Svizzera crawler. Prospective.ch Career Center (CC 2193). National (CH-wide) listing, no region facet — per-job canton inferred from the clean city signal across all 26 cantons. Detail pages at /posizioni-aperte/{slug}/{uuid}. ATS: Umantis (recruitingapp-2735.umantis.com).',
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
    detectSourceLang: (text, job) => job?.sourceLang || detectLang(text, 'it'),
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

// Only run main() when invoked as a script, not when imported by tests.
const isInvokedDirectly = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isInvokedDirectly) {
  main().catch((error) => exitCrawlerOnError(error, 'AXA'));
}
