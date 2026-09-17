#!/usr/bin/env node
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
  isDamianiTicinoLocation,
  inferDamianiCanton,
  parseDamianiSearchPage,
  parseDamianiJobDetail,
  buildDamianiLocalizedContent,
  inferDamianiCategory,
} from './lib/damiani-job-parser.mjs';
import { classifyMalformedRowDrift } from './lib/malformed-row-observability.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { evaluateAuthoritativeSnapshot, exitCrawlerOnError, fetchHtml } from './lib/crawler-template.mjs';
import { hasAuthoritativeListingPageEvidence } from './lib/job-listing-evidence.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'damiani-group.json');

const COMPANY_KEY = 'damiani-group';
// Per-crawler-scoped scratch path — this crawler does its own fetch+merge
// (no runDedicatedBaseCrawler call), but still runs as one of ~25 sibling
// background steps sharing a filesystem checkout in CI, so writing straight
// to the shared, gitignored, CI-absent data/jobs.json is the same
// cross-process-racy write pattern behind #3769/#3770. Scope it per-company.
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Damiani Group';
const COMPANY_HOST = 'careers.damianigroup.com';
const COMPANY_DOMAIN = 'damianigroup.com';
const CAREERS_URL = 'https://careers.damianigroup.com/search/?locale=it_IT';
const SEARCH_BASE = 'https://careers.damianigroup.com/search/?locale=it_IT';
const DETAIL_BASE = 'https://careers.damianigroup.com';
const LOCALES = ['it', 'en', 'de', 'fr'];

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

async function fetchText(url, timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000) {
  return fetchHtml(url, { timeoutMs, headers: { Accept: 'text/html,application/xhtml+xml' } });
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return key === COMPANY_KEY || company.includes('damiani') || url.includes('careers.damianigroup.com/job/');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'careers.damianigroup.com' || host.endsWith('.damianigroup.com');
  } catch {
    return false;
  }
}

async function fetchDamianiListings() {
  console.log('🔍 Fetching Damiani jobs from SuccessFactors search...');
  const discovered = [];
  const seen = new Set();
  let skippedMalformedRowsTotal = 0;
  let terminalPageEvidenceProven = false;
  let terminationProven = false;
  const PAGE_SIZE = 25;
  const MAX_PAGES = 1000;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const startrow = page * PAGE_SIZE;
    const url = startrow ? `${SEARCH_BASE}&startrow=${startrow}` : SEARCH_BASE;
    const html = await fetchText(url);
    const {
      rows,
      skippedMalformedRows,
      ignoredNonJobRows,
      searchTableRendered,
      emptyStateObserved: pageEmptyStateObserved,
    } = parseDamianiSearchPage(html);
    skippedMalformedRowsTotal += skippedMalformedRows;
    const diagnostic = classifyMalformedRowDrift(rows.length, skippedMalformedRows);
    if (skippedMalformedRows > 0) {
      console.warn(
        ` Damiani search page ${startrow}: skipped ${skippedMalformedRows}/${diagnostic.total} malformed row(s)` +
          (ignoredNonJobRows > 0 ? ` (${ignoredNonJobRows} non-job chrome row(s) ignored separately)` : ''),
      );
    }
    if (diagnostic.severity === 'error') {
      throw new Error(
        `Damiani search structure drift at startrow=${startrow}: ` +
          `${skippedMalformedRows}/${diagnostic.total} rows malformed`,
      );
    }
    if (rows.length === 0) {
      terminationProven = true;
      terminalPageEvidenceProven = hasAuthoritativeListingPageEvidence({
        isTerminalPage: true,
        listingMarkupSeen: searchTableRendered,
        listingRowsSeen: rows.length > 0,
        emptyStateObserved: pageEmptyStateObserved,
      });
      break;
    }
    for (const row of rows) {
      const key = row.href;
      if (seen.has(key)) continue;
      seen.add(key);
      discovered.push(row);
    }
    if (rows.length < PAGE_SIZE) {
      terminationProven = true;
      terminalPageEvidenceProven = hasAuthoritativeListingPageEvidence({
        isTerminalPage: true,
        listingMarkupSeen: searchTableRendered,
        listingRowsSeen: rows.length > 0,
        emptyStateObserved: pageEmptyStateObserved,
      });
      break;
    }
  }
  const relevant = discovered.filter((row) => isDamianiTicinoLocation(row.location));
  const unrecognizedLocations = discovered.filter((row) => !isRecognizedDamianiSourceLocation(row.location));
  const sourceReadComplete = Boolean(
    terminationProven
    && skippedMalformedRowsTotal === 0
    && terminalPageEvidenceProven,
  );
  console.log(`📋 Total search rows: ${discovered.length}`);
  console.log(`📋 TI/GR-relevant rows: ${relevant.length}`);
  for (const row of relevant) {
    console.log(`  📄 ${row.title} (${row.location})`);
  }
  if (relevant.length === 0) {
    console.log('ℹ️  Nessun annuncio trovato per Damiani Group — non è un errore, il crawler prosegue.');
  }
  Object.defineProperties(relevant, {
    damianiSourceRows: { value: discovered, enumerable: false },
    damianiSourceReadComplete: { value: sourceReadComplete, enumerable: false },
    damianiSourceTerminationProven: { value: terminationProven, enumerable: false },
    damianiSourceTargetCount: { value: relevant.length, enumerable: false },
    damianiSourceUnrecognizedLocationCount: { value: unrecognizedLocations.length, enumerable: false },
  });
  return relevant;
}

function isRecognizedDamianiSourceLocation(raw = '') {
  const value = String(raw || '').trim();
  return Boolean(value && (isLocationExplicitlyForeign(value) || inferAnyCanton(value)));
}

function copyDamianiSourceEvidence(jobs, source) {
  Object.defineProperties(jobs, {
    damianiSourceRows: { value: source.damianiSourceRows, enumerable: false },
    damianiSourceReadComplete: { value: source.damianiSourceReadComplete === true, enumerable: false },
    damianiSourceTerminationProven: { value: source.damianiSourceTerminationProven === true, enumerable: false },
    damianiSourceTargetCount: { value: source.damianiSourceTargetCount, enumerable: false },
    damianiSourceUnrecognizedLocationCount: { value: source.damianiSourceUnrecognizedLocationCount, enumerable: false },
  });
  return jobs;
}

function assertCompleteDamianiSnapshot(jobs = []) {
  if (!Array.isArray(jobs) || jobs.damianiSourceReadComplete !== true || jobs.damianiSourceTerminationProven !== true) {
    throw new Error('Damiani: source listing snapshot was not read to a proven terminal page');
  }
  const rows = jobs.damianiSourceRows;
  if (!Array.isArray(rows) || rows.filter((row) => isDamianiTicinoLocation(row.location)).length !== jobs.damianiSourceTargetCount) {
    throw new Error('Damiani: source listing snapshot evidence is inconsistent');
  }
  const unrecognized = rows.filter((row) => !isRecognizedDamianiSourceLocation(row.location));
  if (unrecognized.length > 0) {
    throw new Error(`Damiani: ${unrecognized.length} source listing location(s) were not classifiable`);
  }
  if (jobs.damianiSourceTargetCount !== 0 || jobs.length !== 0) {
    throw new Error('Damiani: empty authority requested for a non-empty filtered result');
  }
  return true;
}

function absoluteUrl(raw = '') {
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return new URL(raw, DETAIL_BASE).toString();
}

async function buildDamianiJob(listing) {
  const detailUrl = absoluteUrl(`${listing.href}${listing.href.includes('?') ? '' : '?locale=it_IT'}`);
  const html = await fetchText(detailUrl);
  const detail = parseDamianiJobDetail(html);
  // parseDamianiJobDetail blanks a title that is SuccessFactors page chrome
  // rather than the posting. The listing row is guarded upstream and is the
  // authoritative title anyway, so restore it before localising — title, slug
  // and category all derive from this one value.
  if (!detail.title) detail.title = listing.title;
  const localized = buildDamianiLocalizedContent(detail);
  const canton = inferDamianiCanton(detail.location || listing.location);
  return {
    title: localized.titleByLocale.it || detail.title,
    slug: localized.slugByLocale.it,
    url: absoluteUrl(listing.href),
    applyUrl: absoluteUrl(detail.applyHref),
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: detail.location || listing.location,
    addressLocality: detail.location || listing.location,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferDamianiCategory(detail.title, detail.description),
    sector: 'Lusso & Gioielleria',
    source: 'damiani-dedicated-crawler',
    sourceLang: detectLang(detail.description || '', 'it'),
    postedDate: toIsoDate(detail.postedDate || listing.postedDate),
    employmentType: 'full-time',
    contractType: 'full-time',
    validThrough: toIsoDate(detail.validThrough || ''),
    description: detail.description,
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
  printCrawlChangeSummary(diff, 'Damiani Group');
  writeCrawlChangeSummaryToGH(diff, 'Damiani Group');
  writeJobsSummary(mergedTarget, 'Damiani Group');
  printPublishedJobUrls(mergedTarget, 'Damiani Group');
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
    priority: 16,
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated Damiani Group crawler parses SuccessFactors search pages and keeps TI + GR jobs from the Damiani careers portal.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales(authoritativeEmptySnapshot = false) {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_DAMIANI_STRICT',
    label: 'Damiani Group',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_damiani_domain',
    failWhenNoJobs: !authoritativeEmptySnapshot,
    noJobsMessage: 'No Damiani jobs found after dedicated crawl.',
    detectSourceLang: (text) => detectLang(text, 'it'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Damiani Group');
  console.log('═══════════════════════════════════════════════');
  console.log('  Damiani Group — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const listings = await fetchDamianiListings();
  const jobs = [];
  for (const listing of listings) {
    console.log(`  📄 Processing: ${listing.title} (${listing.location})`);
    jobs.push(await buildDamianiJob(listing));
  }
  copyDamianiSourceEvidence(jobs, listings);
  const {
    authoritativeEmptySnapshot,
    authoritativeSnapshotVerified,
  } = evaluateAuthoritativeSnapshot(jobs, {
    validateAuthoritativeSnapshot: assertCompleteDamianiSnapshot,
    allowAuthoritativeEmptySnapshot: true,
    authoritativeSnapshotScope: 'empty-only',
    companyLabel: COMPANY_NAME,
  });
  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Damiani jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales(authoritativeEmptySnapshot);
  const tiCount = jobs.filter((j) => j.canton === 'TI').length;
  const grCount = jobs.filter((j) => j.canton === 'GR').length;
  console.log(`\n✅ Damiani crawler complete (${total} jobs TI:${tiCount} GR:${grCount}, added=${added}, updated=${updated}).`);

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
    label: 'Damiani Group',
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

main().catch((err) => exitCrawlerOnError(err, 'Damiani'));
