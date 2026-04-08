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
  mergePreserveLocaleData,
} from './lib/dedicated-crawler-common.mjs';
import {
  parseLivingCircleFeed,
  buildLivingCircleLocalizedContent,
} from './lib/living-circle-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'the-living-circle.json');

const COMPANY_KEY = 'the-living-circle';
const HQ = getCompanyDefaults('livingcircle');
const COMPANY_NAME = 'The Living Circle';
const COMPANY_HOST = 'jobs.thelivingcircle.ch';
const COMPANY_DOMAIN = 'thelivingcircle.ch';
const FEED_URL = 'https://jobs.thelivingcircle.ch/jobs.feed.json';
const CAREERS_URL = 'https://jobs.thelivingcircle.ch/#jobs:location=%5B%22Ascona%22%5D';
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

async function fetchJson(url, timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json,text/plain,*/*',
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
  return key === COMPANY_KEY || company.includes('living circle') || url.includes('jobs.thelivingcircle.ch/jobs/');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'jobs.thelivingcircle.ch' || host.endsWith('.thelivingcircle.ch');
  } catch {
    return false;
  }
}

function buildJob(role) {
  const localized = buildLivingCircleLocalizedContent(role);
  return {
    title: localized.it.title,
    slug: localized.it.slug,
    url: role.url,
    applyUrl: role.url,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: role.location || 'Ascona',
    addressLocality: role.location || 'Ascona',
    addressRegion: HQ.addressRegion,
    addressCountry: 'CH',
    canton: HQ.canton,
    country: 'CH',
    category: 'hospitality',
    sector: 'Hotellerie & Ospitalità',
    source: 'living-circle-dedicated-crawler',
    sourceLang: detectLang(`${role.title} ${role.descriptionText}`, 'de'),
    postedDate: toIsoDate(role.postedDate),
    employmentType: String(role.employmentType || '').toUpperCase().includes('FULL') ? 'full-time' : 'other',
    contractType: 'full-time',
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
      it: localized.it.slug,
      en: localized.en.slug,
      de: localized.de.slug,
      fr: localized.fr.slug,
    },
  };
}

function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonTargetJobs = existing.filter((job) => !isTargetJob(job));
  const targetExisting = existing.filter(isTargetJob);
  const beforeSnapshot = snapshotJobSlugs(targetExisting);
  const mergedTarget = mergePreserveLocaleData(targetExisting, discoveredJobs);
  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  writeJson(PUBLIC_JOBS, allJobs);
  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  writeJobsSummary(mergedTarget, COMPANY_NAME);
  printPublishedJobUrls(mergedTarget, COMPANY_NAME);
  return { total: mergedTarget.length, diff };
}

function updateAdapterConfig(jobs) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = {
      location: job.location,
      canton: HQ.canton,
      company: COMPANY_NAME,
      postedDate: job.postedDate,
    };
  }
  writeJson(ADAPTER_PATH, {
    companyKey: COMPANY_KEY,
    companyName: COMPANY_NAME,
    companyHost: COMPANY_HOST,
    enabled: true,
    priority: 10,
    crawlerModes: ['jsonld'],
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated The Living Circle crawler uses the public Softgarden jobs.feed.json feed and filters vacancies in Ascona, Ticino.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_LIVINGCIRCLE_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_livingcircle_domain',
    failWhenNoJobs: true,
    noJobsMessage: 'No The Living Circle jobs found after dedicated crawl.',
    detectSourceLang: (text) => detectLang(text, 'de'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'livingcircle');
  console.log('═══════════════════════════════════════════════');
  console.log('  The Living Circle — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Feed: ${FEED_URL}\n`);
  const feed = await fetchJson(FEED_URL);
  const allRoles = parseLivingCircleFeed(feed);
  const TICINO_LOCATIONS = ['ascona', 'losone', 'locarno', 'brissago', 'muralto', 'minusio', 'tenero', 'gordola'];
  const targetRoles = allRoles.filter((role) => {
    const loc = normalize(role.location);
    return TICINO_LOCATIONS.some((t) => loc.includes(t));
  });
  console.log(`  Found ${allRoles.length} total jobs, ${targetRoles.length} in Ticino.`);
  if (!targetRoles.length) {
    console.log('ℹ️  No Ticino jobs in current feed — preserving existing data.');
    return;
  }
  const jobs = targetRoles.map(buildJob);
  const { total, diff } = mergeJobs(jobs);
  updateAdapterConfig(jobs);
  console.log('\n🌐 Running locale fill for The Living Circle jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });
  validateLocales();
  console.log(`\n✅ The Living Circle crawler complete (${total} jobs).`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'livingcircle',
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
  console.error(`❌ The Living Circle crawler failed: ${err?.message || err}`);
  process.exit(1);
});
