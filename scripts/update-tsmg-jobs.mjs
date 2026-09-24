#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
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
import { validateJobUrls } from './lib/validate-job-url.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import {
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
  mergeLocaleTextMap,
  captureLostSlugs,
  appendSlugDisambiguator,
  isLocationExplicitlyForeign,
} from './lib/dedicated-crawler-common.mjs';
import {
  isTsmgTargetLocation,
  inferTsmgRegion,
  inferTsmgCategory,
  buildTsmgLocalizedContent,
} from './lib/tsmg-job-parser.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { classifyCountryValue } from './lib/prospector/country-inventory.mjs';
import { isSystemicRejection, systemicRatio } from './lib/source-record-quarantine.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'tsmg.json');

const COMPANY_KEY = 'tsmg';
// Per-crawler-scoped scratch path. This script does its own Lever API
// discovery + merge (no runDedicatedBaseCrawler pass) but still wrote
// straight to the literal data/jobs.json path — shared across ~25 sibling
// `background: true` crawler-group steps on one filesystem, gitignored and
// absent in CI (CRAWLER_SLICE_ONLY=1). Scoping the path per company avoids
// racing/clobbering siblings writing the same file (bug class of
// #3775/#3768, confirmed cause of #3769/#3770).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const COMPANY_NAME = 'TSMG';
const COMPANY_HOST = 'jobs.lever.co';
const COMPANY_DOMAIN = 'tsmg.co';
const CAREERS_URL = 'https://jobs.lever.co/tsmg';
const API_URL = 'https://api.lever.co/v0/postings/tsmg?mode=json';
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

async function fetchJson(url, timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 90000) {
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

/**
 * Structural fields a Lever posting is missing, by name. The bare «degraded
 * snapshot at posting N» message (issue 9320, postings 625/649/852) could not
 * tell a truncated payload from one foreign posting without `country`.
 */
function missingTsmgPostingFields(job) {
  if (!job || typeof job !== 'object') return ['posting'];
  const location = job?.categories?.location;
  return [
    !String(job.id || '').trim() ? 'id' : null,
    !String(job.hostedUrl || '').trim() ? 'hostedUrl' : null,
    typeof job.country === 'string' && job.country.trim() ? null : 'country',
    !job.categories || typeof job.categories !== 'object' ? 'categories' : null,
    typeof location !== 'string' || !location.trim() ? 'categories.location' : null,
  ].filter(Boolean);
}

/**
 * A posting this run cannot classify may be quarantined ONLY when it cannot
 * touch the published slice: its location is not a target location (so it
 * would not be published even with `country: CH`) and its URL is not already
 * published. Otherwise it is a missed observation of a possibly live target
 * vacancy and the whole snapshot stays fail-closed.
 */
function canQuarantineTsmgPosting(job, location, publishedKeys) {
  if (isTsmgTargetLocation(location)) return false;
  return !publishedKeys.has(jobMatchKey({ url: String(job?.hostedUrl || '').trim() }));
}

function assertCompleteTsmgSourceSnapshot(payload, { publishedKeys = new Set() } = {}) {
  if (!Array.isArray(payload)) {
    throw new Error('TSMG Lever returned an invalid snapshot: expected an array of postings');
  }
  const quarantined = [];
  for (const [index, job] of payload.entries()) {
    const where = `posting ${index + 1} of ${payload.length}`;
    const missing = missingTsmgPostingFields(job);
    const id = String(job?.id || '').trim() || '?';
    // Identity and location stay mandatory: without them the posting cannot
    // be judged, and that is exactly what a truncated payload looks like.
    const structural = missing.filter((field) => field !== 'country');
    if (structural.length) {
      throw new Error(
        `TSMG Lever returned a degraded snapshot at ${where}: `
        + `missing ${missing.join(', ')} (id=${id})`,
      );
    }
    const normalizedLocation = job.categories.location.trim();
    // Lever sometimes serves a posting without `country` (2026-09-23/24: 3 of
    // 4334, «Jefferson City, MO» and «Windeck»). That is missing data on THAT
    // record, not a degraded payload: quarantine it only when it cannot be a
    // target or an already published vacancy (issue 9320).
    if (missing.includes('country')) {
      if (!canQuarantineTsmgPosting(job, normalizedLocation, publishedKeys)) {
        throw new Error(
          `TSMG Lever returned a degraded snapshot at ${where}: missing country `
          + `on a posting that may be a published or target Swiss vacancy `
          + `(id=${id}, location "${normalizedLocation}")`,
        );
      }
      quarantined.push({ job, reason: `missing country, location "${normalizedLocation}" is not a target Swiss location` });
      continue;
    }
    const country = job.country.trim();
    const normalizedCountry = normalizeTsmgCountry(country);
    if (!normalizedCountry) {
      throw new Error(
        `TSMG Lever returned a degraded snapshot at ${where}: `
        + `country "${country}" is not a recognised country value (id=${id})`,
      );
    }
    // A provider can mark a posting as CH while the location field explicitly
    // names another country. That is a source classification error, not a
    // reason to discard the whole authoritative snapshot: the caller filters
    // this row as non-CH below. Unknown Swiss-looking locations remain
    // fail-closed when they could be a target or an already published posting
    // because they do not provide enough geography evidence.
    if (normalizedCountry === 'CH' && isLocationExplicitlyForeign(normalizedLocation)) {
      continue;
    }
    if (normalizedCountry === 'CH' && !inferAnyCanton(normalizedLocation)) {
      if (!canQuarantineTsmgPosting(job, normalizedLocation, publishedKeys)) {
        throw new Error(
          `TSMG Lever returned a degraded snapshot at ${where}: `
          + `categories.location "${normalizedLocation}" is not a recognised Swiss location (id=${id})`,
        );
      }
      // E.g. «Les Diabterets» (typo), «Mont Tendre»: never publishable without
      // a canton and never published before, so they cannot retire a page.
      quarantined.push({ job, reason: `CH posting with unrecognised Swiss location "${normalizedLocation}"` });
    }
  }
  if (!quarantined.length) return payload;
  // Shared systemic valve (#3789/#7702): once unclassifiable postings stop
  // looking like isolated records, Lever itself is degraded and the whole
  // snapshot stays out.
  if (isSystemicRejection(quarantined.length, payload.length)) {
    throw new Error(
      `TSMG Lever returned a degraded snapshot: ${quarantined.length}/${payload.length} postings `
      + `could not be classified (systemic threshold ${Math.round(systemicRatio() * 100)}%)`,
    );
  }
  console.log(`⚠️  TSMG: ${quarantined.length}/${payload.length} unclassifiable non-target posting(s) quarantined:`);
  for (const { job, reason } of quarantined.slice(0, 10)) {
    console.log(`   - ${String(job.id).trim()}: ${reason}`);
  }
  const skipped = new Set(quarantined.map(({ job }) => job));
  return payload.filter((job) => !skipped.has(job));
}

function normalizeTsmgCountry(value = '') {
  const country = String(value || '').trim().toUpperCase();
  const classification = classifyCountryValue(country);
  if (classification === 'CH') return 'CH';
  if (classification === 'foreign') return 'FOREIGN';
  return '';
}

function isTsmgSwissPosting(job = {}) {
  const country = normalizeTsmgCountry(job?.country);
  const location = String(job?.categories?.location || '').trim();
  return country === 'CH' && !isLocationExplicitlyForeign(location);
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return key === COMPANY_KEY || company === 'tsmg' || url.includes('jobs.lever.co/tsmg/');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'jobs.lever.co' || host === 'api.lever.co';
  } catch {
    return false;
  }
}

function buildJob(job) {
  const localized = buildTsmgLocalizedContent(job);
  const location = String(job?.categories?.location || '').trim();
  const region = inferTsmgRegion(location);
  // slugDisambiguator: first 8 hex chars of Lever UUID — deterministic per job,
  // survives across all pipeline stages (hardenJobLocaleFields, regenerate-slugs).
  // Backwards-compatible with existing TSMG slugs that already have this suffix.
  const disambiguator = String(job.id || '').trim().slice(0, 8).toLowerCase() || '';
  const slug = appendSlugDisambiguator(localized.it.slug, disambiguator);
  return {
    title: localized.it.title,
    slug,
    slugDisambiguator: disambiguator || undefined,
    url: String(job.hostedUrl || '').trim(),
    applyUrl: String(job.applyUrl || job.hostedUrl || '').trim(),
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location,
    addressLocality: location,
    addressRegion: region.canton,
    addressCountry: region.country,
    canton: region.canton,
    country: region.country,
    category: inferTsmgCategory(job.text || ''),
    sector: 'Tecnologia & IT',
    source: 'tsmg-dedicated-crawler',
    sourceLang: 'en',
    postedDate: toIsoDate(job.createdAt),
    employmentType: normalize(job?.categories?.commitment || '').includes('part') ? 'part-time' : 'full-time',
    contractType: normalize(job?.categories?.commitment || '').includes('part') ? 'part-time' : 'full-time',
    validThrough: '',
    description: localized.it.description,
    titleByLocale: {
      it: localized.it.title,
      en: localized.en.title,
      de: localized.de.title,
      fr: localized.fr.title,
    },
    descriptionByLocale: {
      it: localized.it.description,
      en: localized.en.description,
      de: localized.de.description,
      fr: localized.fr.description,
    },
    slugByLocale: {
      it: appendSlugDisambiguator(localized.it.slug, disambiguator),
      en: appendSlugDisambiguator(localized.en.slug, disambiguator),
      de: appendSlugDisambiguator(localized.de.slug, disambiguator),
      fr: appendSlugDisambiguator(localized.fr.slug, disambiguator),
    },
  };
}

function jobMatchKey(job = {}) {
  return extractStableJobId(job.url) || String(job.slug || '').trim().toLowerCase();
}

function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonTargetJobs = existing.filter((job) => !isTargetJob(job));
  const existingTargetJobs = existing.filter(isTargetJob);
  const beforeSnapshot = snapshotJobSlugs(existingTargetJobs);

  const existingByKey = new Map(existingTargetJobs.map((job) => [jobMatchKey(job), job]));
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
  printCrawlChangeSummary(diff, 'TSMG');
  writeCrawlChangeSummaryToGH(diff, 'TSMG');
  writeJobsSummary(mergedTarget, 'TSMG');
  printPublishedJobUrls(mergedTarget, 'TSMG');

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
    priority: 19,
    crawlerModes: ['html', 'api'],
    seedUrls: [CAREERS_URL, API_URL],
    notes: 'Dedicated TSMG crawler uses Lever API and keeps only jobs in Ticino or Grigioni.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales(authoritativeEmptySnapshot = false) {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_TSMG_STRICT',
    label: 'TSMG',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_tsmg_lever',
    failWhenNoJobs: !authoritativeEmptySnapshot,
    noJobsMessage: 'No TSMG jobs found after dedicated crawl.',
    detectSourceLang: (text) => detectLang(text, 'en'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'TSMG');
  console.log('═══════════════════════════════════════════════');
  console.log('  TSMG — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}`);
  console.log(`  API: ${API_URL}\n`);

  // Lever's no-pagination endpoint is a complete postings snapshot. Reject a
  // degraded country/location classification before merge so the prior slice
  // remains untouched without using a count floor. A complete source may also
  // contain Swiss postings outside the target cantons, so the filtered target
  // is allowed to be empty.
  // Postings unclassifiable by this run may only be quarantined when they
  // cannot touch the published slice (see `canQuarantineTsmgPosting`).
  const publishedKeys = new Set(
    readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isTargetJob).map(jobMatchKey).filter(Boolean),
  );
  const rawJobs = assertCompleteTsmgSourceSnapshot(await fetchJson(API_URL), { publishedKeys });
  const authoritativeSnapshotVerified = true;
  const swiss = rawJobs.filter(isTsmgSwissPosting);
  const foreignDiscarded = rawJobs.length - swiss.length;
  const target = swiss.filter((job) => isTsmgTargetLocation(job?.categories?.location || ''));
  const authoritativeEmptySnapshot = target.length === 0;
  if (target.length === 0) {
    console.log('ℹ️  Nessun annuncio trovato per TSMG — non è un errore, il crawler prosegue.');
  }
  console.log(`📋 Total Lever jobs: ${rawJobs.length}`);
  console.log(`📋 Switzerland jobs: ${swiss.length}`);
  console.log(`🧹 Foreign postings discarded: ${foreignDiscarded}`);
  console.log(`📋 Ticino/Grigioni jobs: ${target.length}`);
  if (authoritativeEmptySnapshot) {
    console.log('✅ Lever complete snapshot contains no target-canton postings — publishing the verified empty result.');
  }
  const discoveredJobs = target.map(buildJob);
  const { total, added, updated, diff} = mergeJobs(discoveredJobs);
  updateAdapterConfig(discoveredJobs);

  const newUrls = discoveredJobs.map((job) => job.url).filter(Boolean);
  if (newUrls.length > 0) {
    console.log(`🔗 Validating URLs for ${newUrls.length} TSMG jobs…`);
    await validateJobUrls(newUrls);
  }

  console.log('\n🌐 Running locale fill for TSMG jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales(authoritativeEmptySnapshot);
  console.log(`\n✅ TSMG crawler complete (${total} jobs, added=${added}, updated=${updated}).`);

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
    label: 'TSMG',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    authoritativeEmptySnapshot,
    authoritativeSnapshotVerified,
    sourceTotal: rawJobs.length,
    sourceSwiss: swiss.length,
    foreignDiscarded,
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

if (isInvokedDirectly(import.meta.url)) {
  main().catch((err) => exitCrawlerOnError(err, 'TSMG'));
}

export { assertCompleteTsmgSourceSnapshot, isTsmgSwissPosting, normalizeTsmgCountry };
