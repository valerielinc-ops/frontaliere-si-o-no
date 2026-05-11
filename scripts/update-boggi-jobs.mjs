#!/usr/bin/env node
/**
 * Boggi Milano — Dedicated Crawler
 *
 * Crawls https://boggimilano1.recruitee.com/api/offers (Recruitee JSON API)
 * 1. Fetches all offers via public API (no HTML parsing needed)
 * 2. Filters Swiss/Ticino-relevant jobs by country_code + location
 * 3. Transforms to standard job format with localized content
 * 4. Merges into data/jobs.json
 * 5. Updates adapter config
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  parseBoggiApiResponse,
  buildBoggiJobFromApi,
  buildBoggiLocalizedContent,
  inferBoggiCategory,
  parseBoggiDetailPage,
  MIN_BOGGI_DESC_LENGTH,
} from './lib/boggi-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'boggi-milano.json');

const COMPANY_KEY = 'boggi-milano';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Boggi Milano';
const COMPANY_HOST = 'boggimilano1.recruitee.com';
const COMPANY_DOMAIN = 'recruitee.com';
const CAREERS_URL = 'https://boggimilano1.recruitee.com/l/it';
const API_URL = 'https://boggimilano1.recruitee.com/api/offers';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

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

async function fetchJson(url, timeoutMs = TIMEOUT_MS) {
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
  return (
    key === COMPANY_KEY ||
    company.includes('boggi') ||
    url.includes('boggimilano1.recruitee.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'boggimilano1.recruitee.com' || host.endsWith('.recruitee.com');
  } catch {
    return false;
  }
}

async function fetchAllOffers() {
  console.log('🔍 Fetching Boggi Milano offers via Recruitee API...');
  console.log(`  📡 ${API_URL}`);

  const apiResponse = await fetchJson(API_URL);
  const allOffers = apiResponse?.offers || [];
  console.log(`  📋 Total offers from API: ${allOffers.length}`);

  const ticinoOffers = parseBoggiApiResponse(apiResponse);
  console.log(`  📍 Ticino/Swiss-relevant: ${ticinoOffers.length}`);

  return ticinoOffers;
}

function buildBoggiJob(offer) {
  const parsed = buildBoggiJobFromApi(offer);
  if (!parsed) return null;
  const localized = buildBoggiLocalizedContent(parsed);

  return {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: parsed.detailUrl,
    applyUrl: parsed.applyUrl,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: parsed.location,
    addressLocality: parsed.city,
    addressRegion: inferAnyCanton(parsed.city || parsed.location) || DEFAULT_CANTON,
    addressCountry: 'CH',
    canton: inferAnyCanton(parsed.city || parsed.location) || DEFAULT_CANTON,
    country: 'CH',
    category: inferBoggiCategory(parsed.title, parsed.department),
    sector: 'Moda & Retail',
    source: 'boggi-dedicated-crawler',
    sourceLang: detectLang(`${parsed.title} ${parsed.description}`, 'it'),
    postedDate: parsed.datePosted,
    employmentType: parsed.employmentType,
    contractType: parsed.employmentType,
    validThrough: parsed.validThrough,
    description: localized.descriptionByLocale.it,
    titleByLocale: localized.titleByLocale,
    descriptionByLocale: localized.descriptionByLocale,
    slugByLocale: localized.slugByLocale,
  };
}

function jobMatchKey(job = {}) {
  return String(job.url || '').trim().toLowerCase() || String(job.slug || '').trim().toLowerCase();
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
  printCrawlChangeSummary(diff, 'Boggi Milano');
  writeCrawlChangeSummaryToGH(diff, 'Boggi Milano');
  writeJobsSummary(mergedTarget, 'Boggi Milano');
  printPublishedJobUrls(mergedTarget, 'Boggi Milano');
  return { total: mergedTarget.length, added, updated, diff };
}

function updateAdapterConfig(jobs) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = {
      location: job.location,
      canton: inferAnyCanton(job.location) || DEFAULT_CANTON,
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
    crawlerModes: ['api'],
    seedUrls: [API_URL],
    notes: 'Dedicated Boggi Milano crawler uses the public Recruitee JSON API. Filters Swiss/Ticino jobs by country_code and location fields. No HTML parsing needed.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_BOGGI_STRICT',
    label: 'Boggi Milano',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_boggi_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Boggi Milano jobs found after dedicated crawl.',
    detectSourceLang: (text, job) => {
      if (job?.sourceLang) return job.sourceLang;
      const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
      const sample = tokens.slice(-400).join(' ');
      if (/\b(the|and|with|will|requirements|responsibilities|degree|experience|manage|support|candidate|knowledge|ability)\b/i.test(sample)) {
        return 'en';
      }
      return detectLang(sample, 'it');
    },
  });
}

async function fetchBoggiHtml(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'it-CH,it;q=0.9,en;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) { console.warn(`  ⚠️ HTTP ${res.status} for ${url}`); return null; }
    return await res.text();
  } catch (err) {
    console.warn(`  ⚠️ Fetch failed for ${url}: ${err?.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function syncBoggiDetailDescription(job = {}, body = '') {
  const nextBody = String(body || '').trim();
  if (!nextBody) {
    return { changed: false, sourceLang: 'it' };
  }

  const sourceLang = detectLang(nextBody, 'it');
  const currentDesc = String(job.description || '').trim();
  const currentItalian = String(job.descriptionByLocale?.it || '').trim();
  const italianLooksThin = !currentItalian || currentItalian.length < Math.max(MIN_BOGGI_DESC_LENGTH, nextBody.length * 0.5);

  if (!job.descriptionByLocale || typeof job.descriptionByLocale !== 'object') {
    job.descriptionByLocale = {};
  }

  let changed = false;

  if (nextBody !== currentDesc) {
    job.description = nextBody;
    changed = true;
  }

  if (String(job.descriptionByLocale[sourceLang] || '').trim() !== nextBody) {
    job.descriptionByLocale[sourceLang] = nextBody;
    changed = true;
  }

  if (sourceLang === 'it' || italianLooksThin) {
    if (String(job.descriptionByLocale.it || '').trim() !== nextBody) {
      job.descriptionByLocale.it = nextBody;
      changed = true;
    }
  }

  return { changed, sourceLang };
}

/**
 * For each Boggi job whose description is shorter than MIN_BOGGI_DESC_LENGTH or
 * shorter than 25% of the HTML detail-page body, fetch the detail page and
 * replace the description with the full parsed body.
 *
 * The 25% guard: `currentDescLength < 0.25 * sourceBodyLength`
 */
async function enrichBoggiDescriptions() {
  if (!fs.existsSync(DATA_JOBS)) return 0;
  const raw = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const jobs = Array.isArray(raw) ? raw : [];
  let enriched = 0;

  for (const job of jobs) {
    if (!isTargetJob(job)) continue;
    const currentDesc = String(job.description || '').trim();
    const currentItalian = String(job.descriptionByLocale?.it || '').trim();
    const detailUrl = String(job.url || '').trim();
    if (!detailUrl || !isTrustedDomain(detailUrl)) continue;

    const html = await fetchBoggiHtml(detailUrl);
    if (!html) continue;

    const { body, sourceBodyLength } = parseBoggiDetailPage(html);
    if (!body || sourceBodyLength === 0) continue;

    // Guard: reject if extracted body doesn't meet the minimum
    if (sourceBodyLength < MIN_BOGGI_DESC_LENGTH) {
      console.warn(`  ⚠️ Boggi detail body too short (${sourceBodyLength} chars) for "${job.slug}" — skipping.`);
      continue;
    }

    // Only update if current description is below minimum OR less than 25% of the source body
    const isTooShort = currentDesc.length < MIN_BOGGI_DESC_LENGTH;
    const isLessThanQuarter = currentDesc.length < 0.25 * sourceBodyLength;
    const isItalianThin = currentItalian.length < Math.max(MIN_BOGGI_DESC_LENGTH, sourceBodyLength * 0.5);
    if (!isTooShort && !isLessThanQuarter && !isItalianThin) continue;

    const { changed } = syncBoggiDetailDescription(job, body);
    if (changed) {
      console.log(`  ✨ Enriched "${job.slug}" (${currentDesc.length} → ${sourceBodyLength} chars)`);
      enriched++;
    }
  }

  if (enriched > 0) {
    writeJson(DATA_JOBS, jobs);
    writeJson(PUBLIC_JOBS, jobs);
    console.log(`✨ Enriched ${enriched} Boggi Milano jobs with full detail-page body.`);
  }
  return enriched;
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Boggi Milano');
  console.log('═══════════════════════════════════════════════');
  console.log('  Boggi Milano — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  API endpoint: ${API_URL}`);
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  const ticinoOffers = await fetchAllOffers();
  if (ticinoOffers.length === 0) {
    console.log('⚠️ No Ticino offers found from Boggi Milano API — skipping.');
    return;
  }

  // Deduplicate by slug (shouldn't happen with API but safe)
  const seenSlugs = new Map();
  const deduplicated = [];
  for (const offer of ticinoOffers) {
    const key = normalize(offer.slug || offer.title || '');
    if (!seenSlugs.has(key)) {
      seenSlugs.set(key, offer);
      deduplicated.push(offer);
    }
  }
  if (deduplicated.length < ticinoOffers.length) {
    console.log(`🔄 Deduplicated: ${ticinoOffers.length} → ${deduplicated.length} unique offers`);
  }

  const jobs = deduplicated.map(buildBoggiJob).filter(Boolean);

  const { total, added, updated, diff} = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  // Enrich jobs with short/truncated descriptions by fetching the HTML detail page.
  console.log('\n🔍 Checking Boggi jobs for truncated descriptions...');
  await enrichBoggiDescriptions();

  console.log('\n🌐 Running locale fill for Boggi Milano jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n📊 === Boggi Milano Job Stats ===');
  console.log(`  🏢 Total Boggi jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Boggi Milano',
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`❌ Boggi Milano crawler failed: ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
