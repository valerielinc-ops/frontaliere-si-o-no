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
  captureLostSlugs,
} from './lib/dedicated-crawler-common.mjs';
import {
  parseRittmeyerListingsPage,
  parseRittmeyerJobDetail,
  isRittmeyerTicinoListing,
  buildRittmeyerLocalizedContent,
} from './lib/rittmeyer-job-parser.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { exitCrawlerOnError, fetchHtml } from './lib/crawler-template.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'rittmeyer-ag.json');

const COMPANY_KEY = 'rittmeyer-ag';
const COMPANY_NAME = 'Rittmeyer AG';
const COMPANY_HOST = 'karriere.rittmeyer.com';
const COMPANY_DOMAIN = 'rittmeyer.com';
// No `location` filter → all Swiss Rittmeyer sites (country=1 keeps it Swiss-only).
const CAREERS_URL = 'https://karriere.rittmeyer.com/offene-stellen/?suche=&country=1';
const DETAIL_BASE = 'https://karriere.rittmeyer.com';
const LOCALES = ['it', 'en', 'de', 'fr'];

// Rittmeyer publishes jobs across multiple Swiss sites; address attribution
// must follow the `Schweiz` field extracted from the detail page, not the HQ
// default that applyCompanyDefaults would otherwise inject (Baar ZG 6340).
// `aliases` matches the strings the source actually emits (e.g. "Tessin" DE).
export const RITTMEYER_SITES = [
  {
    key: 'camorino',
    aliases: ['camorino', 'tessin', 'ticino'],
    location: 'Camorino', addressLocality: 'Camorino',
    canton: 'TI', addressRegion: 'TI', addressCountry: 'CH',
    postalCode: '6528', streetAddress: 'Via Sottomontagna 9',
  },
  {
    key: 'romanshorn',
    aliases: ['romanshorn'],
    location: 'Romanshorn', addressLocality: 'Romanshorn',
    canton: 'TG', addressRegion: 'TG', addressCountry: 'CH',
    postalCode: '8590', streetAddress: 'Romanshorn',
  },
  {
    key: 'baar',
    aliases: ['baar', 'zug', 'zugo'],
    location: 'Baar', addressLocality: 'Baar',
    canton: 'ZG', addressRegion: 'ZG', addressCountry: 'CH',
    postalCode: '6340', streetAddress: 'Inwilerriedstrasse 57',
  },
];

/**
 * Resolve a Rittmeyer office address from the `Schweiz` value the parser
 * extracts from the detail page. A known site (Camorino/Romanshorn/Baar)
 * returns its verified street + postal. For any other Swiss site the
 * nationwide crawl surfaces, infer the canton from the source location text
 * and keep that text as the locality — never forge the Baar HQ
 * street/postal/canton onto a posting that isn't in Baar (drop > forge for
 * structured-data correctness). Street/postal stay empty so the downstream
 * safe-default applies instead of an attributed-but-wrong address. Falls back
 * to the HQ only when the location is empty or its canton can't be inferred.
 */
export function resolveRittmeyerSiteAddress(rawLocation = '') {
  const text = String(rawLocation || '').toLowerCase();
  for (const site of RITTMEYER_SITES) {
    if (site.aliases.some((a) => text.includes(a))) return site;
  }
  const locality = String(rawLocation || '').trim();
  const inferred = inferAnyCanton(locality);
  if (locality && inferred) {
    return {
      key: 'inferred',
      aliases: [],
      location: locality, addressLocality: locality,
      canton: inferred, addressRegion: inferred, addressCountry: 'CH',
      postalCode: '', streetAddress: '',
    };
  }
  return RITTMEYER_SITES[RITTMEYER_SITES.length - 1];
}

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

async function fetchText(url, timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000) {
  return fetchHtml(url, {
    timeoutMs,
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'de-CH,de;q=0.9,it;q=0.8,en;q=0.7',
    },
  });
}

function absoluteUrl(raw = '') {
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return new URL(raw, DETAIL_BASE).toString();
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return key === COMPANY_KEY || company.includes('rittmeyer') || url.includes('karriere.rittmeyer.com/offene-stellen/');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'karriere.rittmeyer.com' || host.endsWith('.rittmeyer.com') || host === 'rittmeyer.com';
  } catch {
    return false;
  }
}

async function fetchListings() {
  console.log('🔍 Fetching Rittmeyer jobs from careers page...');
  const html = await fetchText(CAREERS_URL);
  const rows = parseRittmeyerListingsPage(html).filter(isRittmeyerTicinoListing);
  console.log(`📋 Matching Ticino listing rows: ${rows.length}`);
  for (const row of rows) {
    console.log(`  📄 ${row.title}`);
  }
  if (rows.length < 1) {
    throw new Error(`Expected at least 1 Rittmeyer Ticino job, found ${rows.length}`);
  }
  return rows;
}

function inferCategory(detail = {}) {
  const haystack = normalize([detail.title, detail.area, detail.summary].filter(Boolean).join(' '));
  if (haystack.includes('sales')) return 'sales';
  if (haystack.includes('engineer')) return 'engineering';
  return 'other';
}

async function buildRittmeyerJob(listing) {
  const detailUrl = absoluteUrl(listing.href);
  const html = await fetchText(detailUrl);
  const detail = parseRittmeyerJobDetail(html);
  const localized = buildRittmeyerLocalizedContent(detail);
  // Trust the parsed `Schweiz` field (and fall back to the listing title
  // when missing) so off-Camorino postings get the right canton + postal.
  const site = resolveRittmeyerSiteAddress(detail.location || listing.title || '');
  return {
    title: localized.titleByLocale.it || detail.title,
    slug: localized.slugByLocale.it,
    url: detailUrl,
    applyUrl: detail.applyUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: site.location,
    addressLocality: site.addressLocality,
    addressRegion: site.addressRegion,
    addressCountry: site.addressCountry,
    postalCode: site.postalCode,
    streetAddress: site.streetAddress,
    canton: site.canton,
    country: 'CH',
    category: inferCategory(detail),
    sector: 'Energia',
    source: 'rittmeyer-dedicated-crawler',
    sourceLang: detectLang(detail.summary || localized.descriptionByLocale.it || '', 'it'),
    postedDate: new Date().toISOString().slice(0, 10),
    employmentType: detail.workload && detail.workload.includes('80') ? 'full-time' : 'other',
    contractType: detail.workload && detail.workload.includes('80') ? 'full-time' : 'other',
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
    const merged = {
      ...prev,
      ...job,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, job.descriptionByLocale, 30),
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
  printCrawlChangeSummary(diff, 'Rittmeyer AG');
  writeCrawlChangeSummaryToGH(diff, 'Rittmeyer AG');
  writeJobsSummary(mergedTarget, 'Rittmeyer AG');
  printPublishedJobUrls(mergedTarget, 'Rittmeyer AG');
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
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated Rittmeyer crawler parses the Rittmeyer careers page and keeps the Ticino vacancy exposed on the filtered public listing.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_RITTMEYER_STRICT',
    label: 'Rittmeyer AG',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_rittmeyer_domain',
    failWhenNoJobs: true,
    noJobsMessage: 'No Rittmeyer jobs found after dedicated crawl.',
    detectSourceLang: (text) => detectLang(text, 'it'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Rittmeyer AG');
  console.log('═══════════════════════════════════════════════');
  console.log('  Rittmeyer AG — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const listings = await fetchListings();
  const jobs = [];
  for (const listing of listings) {
    jobs.push(await buildRittmeyerJob(listing));
  }
  const { total, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Rittmeyer jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();
  console.log(`\n✅ Rittmeyer crawler complete (${total} jobs).`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Rittmeyer AG',
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

main().catch((err) => exitCrawlerOnError(err, 'Rittmeyer'));
