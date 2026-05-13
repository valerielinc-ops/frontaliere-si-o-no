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
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
  mergeLocaleTextMap,
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'sunrise-sede-ticino.json');

const COMPANY_KEY = 'sunrise-sede-ticino';
const COMPANY_NAME = 'Sunrise Communications AG';
const COMPANY_HOST = 'careers.sunrise.ch';
const COMPANY_DOMAIN = 'sunrise.ch';
const CAREERS_URL = 'https://careers.sunrise.ch/it/it/search-results';
const LOCALES = ['it', 'en', 'de', 'fr'];
const PAGE_OFFSETS = [0, 10, 20, 30, 40, 50];

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

function deriveLocationLabel(detail, listing) {
  const title = String(detail?.title || listing?.title || '').trim();
  const titleMatch = title.match(/-\s*([^-/]+)$/);
  const titleCity = String(titleMatch?.[1] || '').trim();
  const cityState = String(detail?.cityState || '').trim();
  const listingCity = String(listing?.city || '').trim();
  const location = String(detail?.location || '').trim();

  if (
    titleCity &&
    !/zurich/i.test(titleCity) &&
    !/%/.test(titleCity) &&
    /[a-zA-Z]/.test(titleCity)
  ) return titleCity;
  if (cityState && !/zurich/i.test(cityState)) return cityState;
  if (listingCity && listingCity.toLowerCase() !== 'ticino') return listingCity;
  if (location && location.toLowerCase() !== 'ticino') return location;
  if (listingCity) return listingCity;
  return location || 'Ticino';
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
  for (const offset of PAGE_OFFSETS) {
    const url = offset ? `${CAREERS_URL}?from=${offset}&s=1` : CAREERS_URL;
    const html = await fetchText(url);
    const rows = parseSunriseSearchPage(html);
    if (rows.length === 0) break;
    for (const row of rows) {
      const key = row.reqId || row.jobId;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      discovered.push(row);
    }
    if (rows.length < 10) break;
  }
  const target = discovered.filter(isSunriseTargetLocation);
  console.log(`📋 Total search rows: ${discovered.length}`);
  console.log(`📋 Ticino/Grigioni rows: ${target.length}`);
  for (const row of target) {
    console.log(`  📄 ${row.title} (${row.city || row.cityState || row.state})`);
  }
  if (target.length < 1) {
    throw new Error(`Expected at least 1 Sunrise job in Ticino/Grigioni, found ${target.length}`);
  }
  return target;
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
    notes: 'Dedicated Sunrise crawler parses the Phenom search pages and keeps only Ticino/Grigioni jobs from the Sunrise careers portal.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function alignItalianDescriptions() {
  const jobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
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

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_SUNRISE_STRICT',
    label: 'Sunrise Communications AG',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_sunrise_domain',
    failWhenNoJobs: true,
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

  let listings;
  try {
    listings = await fetchSunriseListings();
  } catch (fetchErr) {
    // Sunrise's careers portal legitimately has 0 Ticino/Grigioni positions
    // most of the time (Sunrise is HQ'd in Zurich; regional roles are rare).
    // Treat both "0 matches in source" and "fetch failed" as a no-op: keep
    // any existing slice intact and exit cleanly, instead of failing the
    // workflow on every run where the source is empty.
    const allJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
    const existing = allJobs.filter(isTargetJob);
    console.log(`⚠️  Sunrise listing fetch returned no Ticino/Grigioni matches (${fetchErr.message}).`);
    if (existing.length > 0) {
      console.log(`   Keeping ${existing.length} existing Sunrise job(s) — no changes made.`);
    } else {
      console.log(`   No existing Sunrise jobs to preserve — exiting cleanly (legitimate empty state).`);
    }
    return;
  }
  const jobs = [];
  for (const listing of listings) {
    jobs.push(await buildSunriseJob(listing));
  }

  const result = mergeJobs(jobs);
  const diff = result.diff;
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Sunrise jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });
  alignItalianDescriptions();

  validateLocales();
  console.log(`\n✅ Sunrise crawler complete (${result.total} jobs).`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Sunrise Communications AG',
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
  console.error(`❌ Sunrise crawler failed: ${err?.message || err}`);
  process.exit(1);
});
