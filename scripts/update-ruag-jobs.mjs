#!/usr/bin/env node
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
  validateDedicatedLocaleCoverage,
  translateMissingJobLocales,
  detectLang,
  mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';
import {
  parseRuagListingLinks,
  parseRuagJobDetail,
  isRuagTargetLocation,
  inferRuagCanton,
  buildRuagLocalizedContent,
} from './lib/ruag-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'ruag-ag.json');

const COMPANY_KEY = 'ruag-ag';
const COMPANY_NAME = 'RUAG AG';
const COMPANY_HOST = 'jobs.ruag.ch';
const COMPANY_DOMAIN = 'ruag.ch';
const LISTING_URLS = [
  'https://www.ruag.ch/en/working-us/job-portal?f%5B0%5D=job_facet_workplace%3A310',
  'https://www.ruag.ch/de/arbeiten-bei-uns/job-portal?f%5B0%5D=job_facet_workplace%3A310',
  'https://www.ruag.ch/it/lavorare-con-noi/portale-lavoro?f%5B0%5D=job_facet_workplace%3A310',
];
const SEED_DETAIL_URLS = [
  'https://jobs.ruag.ch/posizioni-aperte/apprendista-polimeccanico-a-afc-2026/8719425f-0598-427b-94ec-9d6a1189fe64',
  'https://jobs.ruag.ch/offene-stellen/data-architect-space-c5i/e2fb49c3-9399-4dc9-8db3-172c6255a543',
  'https://jobs.ruag.ch/offene-stellen/facility-office-manager/49bf3704-581a-43a6-a61b-e6995907530a',
  'https://jobs.ruag.ch/offene-stellen/disposition-item-manager/9c1ebff5-de02-4068-a479-b64b91086a5f',
  'https://jobs.ruag.ch/offene-stellen/technician-electrical/c684b90b-83f4-40b9-99b4-8f9afd171572',
  'https://jobs.ruag.ch/offene-stellen/technician-maintenance/5b277eeb-bafc-4076-bb5e-21a1bcf71bbb',
];
const LOCALES = ['it', 'en', 'de', 'fr'];

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

function toIsoDate(value = '') {
  const parsed = new Date(String(value || '').trim());
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

async function fetchText(url, timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000) {
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

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  const applyUrl = String(job.applyUrl || '').toLowerCase();
  return key === COMPANY_KEY
    || company.includes('ruag')
    || url.includes('jobs.ruag.ch/')
    || applyUrl.includes('jobs.ruag.ch/apply/ats/');
}

function inferCategory(detail = {}) {
  const haystack = normalize([detail.title, detail.description, detail.location].filter(Boolean).join(' '));
  if (haystack.includes('apprend') || haystack.includes('learn')) return 'apprenticeship';
  if (haystack.includes('architect')) return 'engineering';
  if (haystack.includes('facility') || haystack.includes('office')) return 'admin';
  return 'other';
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'jobs.ruag.ch' || host.endsWith('.ruag.ch') || host.endsWith('.prospective.ch');
  } catch {
    return false;
  }
}

async function discoverListingSeeds() {
  const discovered = new Set();
  for (const url of LISTING_URLS) {
    try {
      const html = await fetchText(url, 12000);
      for (const link of parseRuagListingLinks(html)) discovered.add(link);
    } catch {
      // RUAG listing page currently returns 400 frequently; fallback graph discovery remains primary.
    }
  }
  return [...discovered];
}

async function discoverRuagGraph() {
  console.log('🔍 Discovering RUAG job detail pages...');
  const discoveredSeeds = await discoverListingSeeds();
  const queue = [...new Set([...SEED_DETAIL_URLS, ...discoveredSeeds])];
  const seen = new Set();
  const details = [];

  while (queue.length && seen.size < 80) {
    const url = queue.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    try {
      const html = await fetchText(url);
      const detail = parseRuagJobDetail(html, url);
      details.push(detail);
      for (const link of detail.similarLinks || []) {
        if (link.startsWith('https://jobs.ruag.ch/') && !seen.has(link)) queue.push(link);
      }
    } catch (error) {
      console.warn(`  ⚠️ RUAG detail skipped: ${url} (${String(error.message || error)})`);
    }
  }

  const byUrl = new Map();
  for (const detail of details) {
    const key = String(detail.canonicalUrl || '').toLowerCase();
    if (!key) continue;
    byUrl.set(key, detail);
  }
  const all = [...byUrl.values()];
  const target = all.filter((detail) => isRuagTargetLocation(`${detail.location || ''} ${detail.description || ''}`));

  console.log(`📋 RUAG detail pages discovered: ${all.length}`);
  console.log(`📋 RUAG Ticino/Grigioni jobs: ${target.length}`);
  for (const detail of target) {
    console.log(`  📄 ${detail.title} (${detail.location || 'n/a'})`);
  }
  // Only fail hard if discovery itself is broken (0 detail pages fetched).
  // If we fetched jobs but none are in TI/GR, that is a legitimate empty state —
  // RUAG currently has no openings in our target cantons. Return [] so main()
  // can exit cleanly without wiping the existing dataset.
  if (all.length === 0) {
    throw new Error('RUAG discovery failed: 0 detail pages fetched (likely listing block or all seeds 410).');
  }
  return target;
}

function ensureAdapter(discoveredJobs) {
  writeJson(ADAPTER_PATH, {
    companyKey: COMPANY_KEY,
    companyName: COMPANY_NAME,
    companyHost: COMPANY_HOST,
    enabled: true,
    priority: 16,
    crawlerModes: ['jsonld', 'html', 'generic_ats'],
    seedUrls: discoveredJobs.map((job) => job.canonicalUrl),
    notes: 'Dedicated RUAG crawler uses official jobs.ruag.ch detail pages and recursive discovery from internal similar-job links because the public listing often returns 400.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl: Object.fromEntries(
      discoveredJobs.map((job) => [
        job.canonicalUrl,
        {
          location: job.location || 'Lodrino',
          canton: inferRuagCanton(job.location || ''),
          company: COMPANY_NAME,
          postedDate: toIsoDate(job.postedDate),
        },
      ])
    ),
  });
}

function buildRuagJob(detail) {
  const localized = buildRuagLocalizedContent(detail, COMPANY_NAME, 'it');
  const location = detail.location || 'Lodrino';
  const canton = inferRuagCanton(location);
  const title = localized.titleByLocale.it || detail.title;
  const description = localized.descriptionByLocale.it || detail.description || '';
  const employmentType = String(detail.employmentType || '').toUpperCase();
  const contractType = employmentType.includes('PART') ? 'part-time' : 'full-time';
  return {
    title,
    slug: localized.slugByLocale.it,
    url: detail.canonicalUrl,
    applyUrl: detail.applyUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location,
    addressLocality: location,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferCategory(detail),
    sector: 'Aerospazio e difesa',
    source: 'ruag-dedicated-crawler',
    sourceLang: detectLang(`${title} ${description}`, 'it'),
    postedDate: toIsoDate(detail.postedDate),
    employmentType: contractType,
    contractType,
    validThrough: detail.validThrough || '',
    description,
    titleByLocale: localized.titleByLocale,
    descriptionByLocale: localized.descriptionByLocale,
    slugByLocale: localized.slugByLocale,
  };
}

function jobMatchKey(job = {}) {
  return extractStableJobId(job.url) || String(job.slug || '').trim().toLowerCase();
}

function mergeJobs(discoveredJobs) {
  const jobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  if (!Array.isArray(jobs)) return { total: 0, added: 0, updated: 0 };
  const nonTargetJobs = jobs.filter((job) => !isTargetJob(job));
  const targetExisting = jobs.filter(isTargetJob);
  const beforeSnapshot = snapshotJobSlugs(targetExisting);
  const existingByKey = new Map(targetExisting.map((job) => [jobMatchKey(job), job]));

  let added = 0;
  let updated = 0;
  const mergedTarget = discoveredJobs.map((detail) => {
    const nextJob = buildRuagJob(detail);
    const prev = existingByKey.get(jobMatchKey(nextJob));
    if (!prev) {
      added += 1;
      return nextJob;
    }
    updated += 1;
    return {
      ...prev,
      ...nextJob,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, nextJob.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, nextJob.descriptionByLocale, 30),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, nextJob.slugByLocale, 3),
    };
  });

  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  writeJson(PUBLIC_JOBS, allJobs);

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'RUAG AG');
  writeCrawlChangeSummaryToGH(diff, 'RUAG AG');
  writeJobsSummary(mergedTarget, 'RUAG AG');
  printPublishedJobUrls(mergedTarget, 'RUAG AG');
  return { total: mergedTarget.length, added, updated, diff };
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'RUAG');
  console.log('═══════════════════════════════════════════════');
  console.log('  RUAG AG — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Listing source: ${LISTING_URLS[0]}\n`);

  const beforeJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const beforeTargetJobs = Array.isArray(beforeJobs) ? beforeJobs.filter((job) => isTargetJob(job)) : [];
  const beforeSlugs = snapshotJobSlugs(beforeTargetJobs);

  const discoveredJobs = await discoverRuagGraph();

  // Legit empty-region state: discovery worked but 0 jobs in TI/GR.
  // Preserve existing dataset (don't wipe) and exit cleanly with an empty slice.
  if (discoveredJobs.length === 0) {
    console.log('ℹ️  RUAG has no current openings in Ticino/Grigioni — skipping merge and validator.');
    const _durationMs = getCrawlerElapsedMs();
    writeJobsCrawlerSlice(COMPANY_KEY, []);
    writeSummaryCrawlerSlice({
      key: COMPANY_KEY,
      label: 'RUAG',
      generatedAt: new Date().toISOString(),
      total: 0,
      newCount: 0,
      updatedCount: 0,
      removedCount: 0,
      unchangedCount: 0,
      durationMs: _durationMs,
      avgDurationMs: _durationMs,
      durationHistory: [_durationMs],
      newJobs: [],
      updatedJobs: [],
      removedJobs: [],
      unchangedJobs: [],
    });
    await assembleJobsDataset();
    console.log('✅ RUAG crawler complete (empty-region state, dataset preserved).');
    return;
  }

  ensureAdapter(discoveredJobs);
  const mergeStats = mergeJobs(discoveredJobs);
  console.log(`🧩 RUAG merge: total=${mergeStats.total} added=${mergeStats.added} updated=${mergeStats.updated}`);

  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_RUAG_STRICT',
    label: 'RUAG',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    detectSourceLang: (text) => detectLang(text, 'it'),
    isTrustedDomain,
    untranslatedCheck: true,
    minDescriptionChars: 120,
    failWhenNoJobs: true,
    noJobsMessage: 'No RUAG jobs found after dedicated crawl.',
  });

  const allJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const targetJobs = Array.isArray(allJobs) ? allJobs.filter((job) => isTargetJob(job)) : [];
  writeJobsSummary(targetJobs, 'RUAG');
  printPublishedJobUrls(targetJobs.slice(0, 20), 'RUAG');

  const afterSnapshot = snapshotJobSlugs(targetJobs);
  const diff = computeCrawlDiff(beforeSlugs, afterSnapshot);
  console.log(`✅ RUAG crawler complete. Target jobs published: ${targetJobs.length}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'RUAG',
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
  console.error('❌ RUAG dedicated crawler failed.');
  console.error(error);
  process.exitCode = 1;
});
