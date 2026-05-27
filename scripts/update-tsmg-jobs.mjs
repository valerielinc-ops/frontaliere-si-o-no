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
import { validateJobUrls } from './lib/validate-job-url.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import {
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
  mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';
import {
  isTsmgTargetLocation,
  inferTsmgRegion,
  inferTsmgCategory,
  buildTsmgLocalizedContent,
} from './lib/tsmg-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'tsmg.json');

const COMPANY_KEY = 'tsmg';
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
  const appendDisambiguator = (base) => {
    if (!disambiguator || !base) return base || '';
    const maxBase = Math.max(0, 120 - disambiguator.length - 1);
    const trimmed = base.slice(0, maxBase).replace(/-+$/, '');
    return trimmed ? `${trimmed}-${disambiguator}` : disambiguator;
  };
  const slug = appendDisambiguator(localized.it.slug);
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
      it: appendDisambiguator(localized.it.slug),
      en: appendDisambiguator(localized.en.slug),
      de: appendDisambiguator(localized.de.slug),
      fr: appendDisambiguator(localized.fr.slug),
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

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_TSMG_STRICT',
    label: 'TSMG',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_tsmg_lever',
    failWhenNoJobs: true,
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

  const rawJobs = await fetchJson(API_URL);
  const swiss = rawJobs.filter((job) => String(job.country || '').trim().toUpperCase() === 'CH');
  const target = swiss.filter((job) => isTsmgTargetLocation(job?.categories?.location || ''));
  console.log(`📋 Total Lever jobs: ${rawJobs.length}`);
  console.log(`📋 Switzerland jobs: ${swiss.length}`);
  console.log(`📋 Ticino/Grigioni jobs: ${target.length}`);
  if (target.length < 2) {
    throw new Error(`Expected at least 2 Ticino/Grigioni jobs, found ${target.length}`);
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

  validateLocales();
  console.log(`\n✅ TSMG crawler complete (${total} jobs, added=${added}, updated=${updated}).`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'TSMG',
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

main().catch((err) => {
  console.error(`❌ TSMG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
