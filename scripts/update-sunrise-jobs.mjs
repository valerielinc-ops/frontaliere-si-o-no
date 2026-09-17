#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { evaluateAuthoritativeSnapshot, exitCrawlerOnError, fetchHtml } from './lib/crawler-template.mjs';
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
  writeJobsCrawlerSliceVerified,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import {
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
  isLocationExplicitlyForeign,
  mergeLocaleTextMap,
  captureLostSlugs,
} from './lib/dedicated-crawler-common.mjs';
import {
  parseSunriseSearchPage,
  parseSunriseJobDetail,
  isSunriseTargetLocation,
  inferSunriseCanton,
  buildSunriseDetailUrl,
  buildSunriseLocalizedContent,
  inferSunriseCategory,
} from './lib/sunrise-job-parser.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { readCurrentRunJobs } from './lib/crawler-run-jobs.mjs';
import { createListingPaginationIntegrity } from './lib/listing-pagination-integrity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'sunrise-sede-ticino.json');

const COMPANY_KEY = 'sunrise-sede-ticino';
// Per-crawler-scoped scratch path — isolates this script's own merge writes
// from the shared, gitignored, CI-absent data/jobs.json that ~25 sibling
// dedicated crawlers also target as `background: true` steps in one CI job;
// writing directly to the shared path races and silently clobbers sibling
// output (confirmed bug class of #3769/#3770, crash-class #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const COMPANY_NAME = 'Sunrise Communications AG';
const COMPANY_HOST = 'careers.sunrise.ch';
const COMPANY_DOMAIN = 'sunrise.ch';
const CAREERS_URL = 'https://careers.sunrise.ch/it/it/search-results';
const LOCALES = ['it', 'en', 'de', 'fr'];
const PAGE_SIZE = 10;
const MAX_PAGES = 1000;

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

function toIsoDate(value = '') {
  const parsed = new Date(String(value || '').trim());
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

function deriveLocationLabel(detail, listing) {
  const title = String(detail?.title || listing?.title || '').trim();
  const titleMatch = title.match(/-\s*([^-/]+)$/);
  const titleCity = String(titleMatch?.[1] || '').trim();
  const cityState = String(detail?.cityState || '').trim();
  const listingCity = String(listing?.city || '').trim();
  const location = String(detail?.location || '').trim();
  // Strip parentheticals (e.g. "Zurich (Headquarter)") and trailing ", CH".
  const clean = (value = '') => value
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/,\s*CH$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (
    titleCity &&
    !/%/.test(titleCity) &&
    /[a-zA-Z]/.test(titleCity)
  ) return clean(titleCity);
  // Sunrise's per-job `city` is the most reliable location label (cityState
  // leaks the Zürich HQ for jobs in other cantons). Prefer it over cityState.
  if (listingCity) return clean(listingCity);
  if (cityState) return clean(cityState);
  return clean(location);
}

async function fetchText(url, timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000) {
  return fetchHtml(url, {
    timeoutMs,
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return key === COMPANY_KEY || company.includes('sunrise') || url.includes('careers.sunrise.ch/');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'careers.sunrise.ch' || host.endsWith('.sunrise.ch');
  } catch {
    return false;
  }
}

async function fetchSunriseListings() {
  console.log('🔍 Fetching Sunrise jobs from Phenom search...');
  const discovered = [];
  const seen = new Set();
  let malformedRecordCount = 0;
  let payloadPresent = false;
  let terminationProven = false;
  const paginationIntegrity = createListingPaginationIntegrity({
    getRowKey: (row) => row?.reqId || row?.jobId,
  });
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * PAGE_SIZE;
    const url = offset ? `${CAREERS_URL}?from=${offset}&s=1` : CAREERS_URL;
    const html = await fetchText(url);
    const rows = parseSunriseSearchPage(html);
    if (rows.sunriseSearchPayloadPresent !== true) {
      throw new Error(`Sunrise search payload missing at offset ${offset}`);
    }
    payloadPresent = true;
    malformedRecordCount += Number(rows.sunriseSearchSkippedMalformedRecords || 0);
    const rawRecordCount = Number(rows.sunriseSearchRawRecordCount || 0);
    if (!paginationIntegrity.observe(rows).accepted) {
      console.warn(`⚠️ Sunrise pagination integrity failed at offset ${offset}; source snapshot is unproven.`);
      break;
    }
    if (rawRecordCount === 0) {
      terminationProven = true;
      break;
    }
    for (const row of rows) {
      const key = row.reqId || row.jobId;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      discovered.push(row);
    }
    if (rawRecordCount < PAGE_SIZE) {
      terminationProven = true;
      break;
    }
  }
  const target = discovered.filter(isSunriseTargetLocation);
  const unrecognizedLocations = discovered.filter((row) => !isRecognizedSunriseSourceLocation(row));
  const sourceReadComplete = Boolean(
    payloadPresent
    && terminationProven
    && paginationIntegrity.proven
    && malformedRecordCount === 0,
  );
  console.log(`📋 Total search rows: ${discovered.length}`);
  console.log(`📋 Swiss (CH-wide) rows: ${target.length}`);
  for (const row of target) {
    console.log(`  📄 ${row.title} (${row.city || row.cityState || row.state})`);
  }
  if (target.length === 0) {
    console.log('ℹ️  Nessun annuncio trovato per Sunrise in Svizzera — non è un errore, il crawler prosegue.');
  }
  Object.defineProperties(target, {
    sunriseSourceRows: { value: discovered, enumerable: false },
    sunriseSourceReadComplete: { value: sourceReadComplete, enumerable: false },
    sunriseSourceTerminationProven: { value: terminationProven, enumerable: false },
    sunriseSourcePaginationIntegrityProven: { value: paginationIntegrity.proven, enumerable: false },
    sunriseSourceTargetCount: { value: target.length, enumerable: false },
    sunriseSourceUnrecognizedLocationCount: { value: unrecognizedLocations.length, enumerable: false },
  });
  return target;
}

function isRecognizedSunriseSourceLocation(job = {}) {
  const value = [job.city, job.cityState, job.cityStateCountry, job.state].filter(Boolean).join(' ');
  return Boolean(value && (inferSunriseCanton(job) || isLocationExplicitlyForeign(value)));
}

function copySunriseSourceEvidence(jobs, source) {
  Object.defineProperties(jobs, {
    sunriseSourceRows: { value: source.sunriseSourceRows, enumerable: false },
    sunriseSourceReadComplete: { value: source.sunriseSourceReadComplete === true, enumerable: false },
    sunriseSourceTerminationProven: { value: source.sunriseSourceTerminationProven === true, enumerable: false },
    sunriseSourcePaginationIntegrityProven: { value: source.sunriseSourcePaginationIntegrityProven === true, enumerable: false },
    sunriseSourceTargetCount: { value: source.sunriseSourceTargetCount, enumerable: false },
    sunriseSourceUnrecognizedLocationCount: { value: source.sunriseSourceUnrecognizedLocationCount, enumerable: false },
  });
  return jobs;
}

function assertCompleteSunriseSnapshot(jobs = []) {
  if (
    !Array.isArray(jobs)
    || jobs.sunriseSourceReadComplete !== true
    || jobs.sunriseSourceTerminationProven !== true
    || jobs.sunriseSourcePaginationIntegrityProven !== true
  ) {
    throw new Error('Sunrise: source search snapshot was not read to a proven terminal page');
  }
  const rows = jobs.sunriseSourceRows;
  if (!Array.isArray(rows) || rows.filter(isSunriseTargetLocation).length !== jobs.sunriseSourceTargetCount) {
    throw new Error('Sunrise: source search snapshot evidence is inconsistent');
  }
  const unrecognized = rows.filter((row) => !isRecognizedSunriseSourceLocation(row));
  if (unrecognized.length > 0) {
    throw new Error(`Sunrise: ${unrecognized.length} source listing location(s) were not classifiable`);
  }
  if (jobs.sunriseSourceTargetCount !== 0 || jobs.length !== 0) {
    throw new Error('Sunrise: empty authority requested for a non-empty filtered result');
  }
  return true;
}

async function buildSunriseJob(listing) {
  const detailUrl = buildSunriseDetailUrl(listing);
  const html = await fetchText(detailUrl);
  const detail = parseSunriseJobDetail(html);
  const canton = inferSunriseCanton({ ...listing, ...detail });
  const locationLabel = deriveLocationLabel(detail, listing);
  const localized = buildSunriseLocalizedContent(detail);
  localized.slugByLocale = {
    it: normalizeKey(`${detail.title} Sunrise ${locationLabel}`),
    en: normalizeKey(`${detail.title} Sunrise ${locationLabel}`),
    de: normalizeKey(`${detail.title} Sunrise ${locationLabel}`),
    fr: normalizeKey(`${detail.title} Sunrise ${locationLabel}`),
  };
  const itDescription = localized.descriptionByLocale.it || '';
  const enDescription = localized.descriptionByLocale.en || '';
  return {
    title: localized.titleByLocale.it || detail.title || listing.title,
    slug: localized.slugByLocale.it,
    url: detailUrl,
    applyUrl: detail.applyUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: locationLabel,
    addressLocality: locationLabel,
    addressRegion: canton,
    addressCountry: 'CH',
    postalCode: detail.postalCode || '',
    canton,
    country: 'CH',
    category: inferSunriseCategory(detail),
    sector: 'Tecnologia & IT',
    source: 'sunrise-dedicated-crawler',
    sourceLang: detectLang(enDescription || itDescription || detail.description || '', 'en'),
    postedDate: toIsoDate(detail.postedDate || listing.postedDate),
    employmentType: normalize(detail.employmentType).includes('part') ? 'part-time' : 'full-time',
    contractType: normalize(detail.employmentType).includes('part') ? 'part-time' : 'full-time',
    validThrough: detail.validThrough ? toIsoDate(detail.validThrough) : '',
    description: detail.description || '',
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
  printCrawlChangeSummary(diff, 'Sunrise Communications AG');
  writeCrawlChangeSummaryToGH(diff, 'Sunrise Communications AG');
  writeJobsSummary(mergedTarget, 'Sunrise Communications AG');
  printPublishedJobUrls(mergedTarget, 'Sunrise Communications AG');
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
    priority: 14,
    crawlerModes: ['html', 'jsonld'],
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated Sunrise crawler parses the Phenom search pages and keeps CH-wide jobs (all 26 cantons) from the Sunrise careers portal; per-job canton inferred from the clean city signal, foreign/unresolved postings dropped.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function alignItalianDescriptions() {
  // The run's own working set, not the previous run's published slice:
  // reading through `readExistingCrawlerJobs()` here handed back the jobs this
  // run had just merged away and wrote them back over `DATA_JOBS` (#7706).
  const jobs = readCurrentRunJobs(DATA_JOBS);
  let changed = false;
  for (const job of jobs) {
    if (!isTargetJob(job)) continue;
    const nextDescription = String(job?.descriptionByLocale?.it || job.description || '').trim();
    if (nextDescription && nextDescription !== String(job.description || '').trim()) {
      job.description = nextDescription;
      changed = true;
    }
    const cleanSlug = String(job.slug || '').trim().toLowerCase();
    if (cleanSlug && cleanSlug !== job.slug) {
      job.slug = cleanSlug;
      changed = true;
    }
    if (job.slugByLocale && typeof job.slugByLocale === 'object') {
      for (const [locale, slug] of Object.entries(job.slugByLocale)) {
        const nextSlug = String(slug || '').trim().toLowerCase();
        if (nextSlug && nextSlug !== slug) {
          job.slugByLocale[locale] = nextSlug;
          changed = true;
        }
      }
    }
  }
  if (changed) {
    writeJson(DATA_JOBS, jobs);
    writeJson(PUBLIC_JOBS, jobs);
  }
}

function validateLocales(authoritativeEmptySnapshot = false) {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_SUNRISE_STRICT',
    label: 'Sunrise Communications AG',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_sunrise_domain',
    failWhenNoJobs: !authoritativeEmptySnapshot,
    noJobsMessage: 'No Sunrise jobs found after dedicated crawl.',
    detectSourceLang: (text) => detectLang(text, 'en'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Sunrise Communications AG');
  console.log('═══════════════════════════════════════════════');
  console.log('  Sunrise Communications AG — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const listings = await fetchSunriseListings();
  const jobs = [];
  for (const listing of listings) {
    jobs.push(await buildSunriseJob(listing));
  }

  copySunriseSourceEvidence(jobs, listings);
  const {
    authoritativeEmptySnapshot,
    authoritativeSnapshotVerified,
  } = evaluateAuthoritativeSnapshot(jobs, {
    validateAuthoritativeSnapshot: assertCompleteSunriseSnapshot,
    allowAuthoritativeEmptySnapshot: true,
    authoritativeSnapshotScope: 'empty-only',
    companyLabel: COMPANY_NAME,
  });

  const result = mergeJobs(jobs);
  const diff = result.diff;
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Sunrise jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });
  alignItalianDescriptions();

  validateLocales(authoritativeEmptySnapshot);
  console.log(`\n✅ Sunrise crawler complete (${result.total} jobs).`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  await writeJobsCrawlerSliceVerified(COMPANY_KEY, _sliceJobs, {
    isTargetJob,
    skipShrinkGuard: authoritativeEmptySnapshot && authoritativeSnapshotVerified,
  });
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Sunrise Communications AG',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    authoritativeEmptySnapshot,
    authoritativeSnapshotVerified,
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

main().catch((err) => exitCrawlerOnError(err, 'Sunrise'));
