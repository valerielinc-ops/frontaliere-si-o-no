#!/usr/bin/env node
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
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
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
  mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';
import {
  parseArtisaCareerPage,
  parseSmartsheetFormPage,
  buildArtisaLocalizedContent,
} from './lib/artisa-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'artisa-group.json');

const COMPANY_KEY = 'artisa-group';
const HQ = getCompanyDefaults(COMPANY_KEY);
const COMPANY_NAME = 'Artisa Group';
const COMPANY_HOST = 'artisagroup.com';
const COMPANY_DOMAIN = 'artisagroup.com';
const CAREERS_URL = 'https://artisagroup.com/carriera';
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
  return key === COMPANY_KEY || company.includes('artisa') || url.includes('artisagroup.com/carriera#');
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'artisagroup.com' || host.endsWith('.artisagroup.com');
  } catch {
    return false;
  }
}

function inferCategory(title = '') {
  const haystack = normalize(title);
  if (haystack.includes('marketing') || haystack.includes('sales') || haystack.includes('transaction')) return 'sales';
  if (haystack.includes('architetto') || haystack.includes('architecte')) return 'engineering';
  if (haystack.includes('assistente') || haystack.includes('segretaria')) return 'admin';
  return 'other';
}

async function fetchSmartsheetDetail(applyUrl) {
  if (!applyUrl || !applyUrl.includes('app.smartsheet.com/b/form/')) return null;
  try {
    const html = await fetchText(applyUrl);
    return parseSmartsheetFormPage(html);
  } catch (err) {
    console.warn(`  ⚠️  Failed to fetch detail from ${applyUrl}: ${err.message}`);
    return null;
  }
}

async function fetchListings() {
  console.log('🔍 Fetching Artisa Group jobs from careers page...');
  const html = await fetchText(CAREERS_URL);
  const rows = parseArtisaCareerPage(html);
  console.log(`📋 Ticino rows: ${rows.length}`);

  // Fetch detail pages from Smartsheet forms (sequential to be polite)
  for (const row of rows) {
    console.log(`  📄 ${row.title} (${row.location})`);
    const detail = await fetchSmartsheetDetail(row.applyUrl);
    if (detail) {
      // Use the more specific title from the form if available
      if (detail.title && detail.title.length > row.title.length) {
        row.detailTitle = detail.title;
      }
      if (detail.description) {
        row.detailDescription = detail.description;
        console.log(`     ✅ Rich description from Smartsheet (${detail.description.length} chars)`);
      }
    } else if (row.applyUrl?.includes('smartsheet.com')) {
      console.log(`     ⚠️  No detail extracted from form`);
    }
  }

  if (rows.length < 3) {
    throw new Error(`Expected at least 3 Artisa jobs, found ${rows.length}`);
  }
  return rows;
}

async function buildArtisaJob(row) {
  const localized = buildArtisaLocalizedContent(row);
  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: row.sourceUrl,
    applyUrl: row.applyUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: row.location,
    addressLocality: row.location,
    addressRegion: HQ.addressRegion,
    addressCountry: 'CH',
    canton: HQ.canton,
    country: 'CH',
    category: inferCategory(row.title),
    sector: 'Immobiliare & Architettura',
    source: 'artisa-dedicated-crawler',
    sourceLang: detectLang(`${row.title} ${localized.descriptionByLocale.it}`, 'it'),
    postedDate: new Date().toISOString().slice(0, 10),
    employmentType: 'full-time',
    contractType: 'full-time',
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
  printCrawlChangeSummary(diff, 'Artisa Group');
  writeCrawlChangeSummaryToGH(diff, 'Artisa Group');
  writeJobsSummary(mergedTarget, 'Artisa Group');
  printPublishedJobUrls(mergedTarget, 'Artisa Group');
  return { total: mergedTarget.length, added, updated, diff };
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
    priority: 17,
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated Artisa Group crawler parses the careers page SSR markup and keeps Ticino vacancies with SmartSheet application links.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function repairLocalizedDescriptions() {
  const jobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  let repaired = 0;
  const nextJobs = jobs.map((job) => {
    if (!isTargetJob(job)) return job;
    const localized = buildArtisaLocalizedContent({
      title: job.title,
      location: job.location,
    });
    const descriptionByLocale = {
      ...localized.descriptionByLocale,
      ...(job.descriptionByLocale || {}),
    };
    for (const locale of LOCALES) {
      if (!String(descriptionByLocale[locale] || '').trim()) {
        descriptionByLocale[locale] = localized.descriptionByLocale[locale] || localized.descriptionByLocale.it;
        repaired += 1;
      }
    }
    return {
      ...job,
      description: descriptionByLocale.it || job.description,
      descriptionByLocale,
    };
  });
  writeJson(DATA_JOBS, nextJobs);
  writeJson(PUBLIC_JOBS, nextJobs);
  if (repaired > 0) {
    console.log(`🩹 Artisa locale repair: restored ${repaired} missing localized descriptions.`);
  }
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_ARTISA_STRICT',
    label: 'Artisa Group',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_artisa_domain',
    failWhenNoJobs: true,
    noJobsMessage: 'No Artisa jobs found after dedicated crawl.',
    detectSourceLang: () => 'it',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Artisa Group');
  console.log('═══════════════════════════════════════════════');
  console.log('  Artisa Group — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const listings = await fetchListings();
  const jobs = [];
  for (const listing of listings) {
    jobs.push(await buildArtisaJob(listing));
  }

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Artisa jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });
  repairLocalizedDescriptions();

  validateLocales();

  console.log('\n📊 === Artisa Group Job Stats ===');
  console.log(`  🏢 Total Artisa jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Artisa Group',
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
  console.error(`❌ Artisa Group crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
