#!/usr/bin/env node
/**
 * Dedicated Giorgio Armani crawler runner.
 * Crawls the Giorgio Armani SAP SuccessFactors careers portal for
 * Switzerland-based positions.
 *
 * Architecture note: SuccessFactors (career5.successfactors.eu) is a
 * JavaScript SPA — the listing page is not server-rendered. However,
 * individual job detail pages ARE server-rendered HTML. This crawler
 * scans job requisition IDs and parses detail pages directly.
 *
 * Discovery flow:
 *   1. Scan job req IDs from a starting point downward
 *   2. For each valid page, quick-extract title + country
 *   3. Filter for Swiss jobs (country="Switzerland" or Swiss city names)
 *   4. Full-parse detail pages for matching jobs
 *   5. Merge into data/jobs.json
 *   6. Run locale fill + validation
 *
 * Giorgio Armani S.p.A. is an Italian luxury fashion house with retail
 * stores across Switzerland (Zurich, Landquart outlet, etc.), making
 * their positions relevant for Italian cross-border workers.
 */
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
  isValidJobPage,
  quickExtractJobMeta,
  parseGiorgioArmaniJobDetail,
  isGiorgioArmaniSwissJob,
  inferGiorgioArmaniCanton,
  inferGiorgioArmaniCategory,
  buildGiorgioArmaniLocalizedContent,
} from './lib/giorgio-armani-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'giorgio-armani.json');

const COMPANY_KEY = 'giorgio-armani';
const COMPANY_NAME = 'Giorgio Armani S.p.A.';
const COMPANY_HOST = 'career5.successfactors.eu';
const COMPANY_DOMAIN = 'armani.com';
const CAREERS_URL = 'https://career5.successfactors.eu/career?company=3397177P&career_ns=job_listing_summary&navBarLevel=JOB_SEARCH';
const SF_COMPANY_ID = '3397177P';
const DETAIL_URL_BASE = `https://career5.successfactors.eu/career?career_ns=job_listing&company=${SF_COMPANY_ID}&navBarLevel=JOB_SEARCH&rcm_site_locale=en_US&selected_lang=it_IT&career_job_req_id=`;
const LOCALES = ['it', 'en', 'de', 'fr'];

// Scan configuration
const SCAN_START_ID = Number(process.env.ARMANI_SCAN_START_ID) || 5100;
const SCAN_BATCH_SIZE = 10;
const MAX_CONSECUTIVE_MISSES = 30;
const MIN_SCAN_ID = 4000;

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
  return key === COMPANY_KEY || company.includes('giorgio armani') || url.includes('career5.successfactors.eu/career') && url.includes(SF_COMPANY_ID);
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'career5.successfactors.eu' || host.endsWith('.armani.com');
  } catch {
    return false;
  }
}

/**
 * Scan SuccessFactors job requisition IDs to discover all active jobs.
 * Returns an array of { reqId, title, country, area } for Swiss jobs.
 */
async function discoverSwissJobs() {
  console.log(`🔍 Scanning SuccessFactors job IDs from ${SCAN_START_ID} down to ${MIN_SCAN_ID}...`);
  const swissJobs = [];
  let consecutiveMisses = 0;
  let totalScanned = 0;
  let totalValid = 0;

  for (let startId = SCAN_START_ID; startId >= MIN_SCAN_ID; startId -= SCAN_BATCH_SIZE) {
    if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES) {
      console.log(`  ⏹️  Stopping scan: ${MAX_CONSECUTIVE_MISSES} consecutive misses`);
      break;
    }

    const batchIds = Array.from({ length: SCAN_BATCH_SIZE }, (_, i) => startId - i).filter((id) => id >= MIN_SCAN_ID);
    const results = await Promise.allSettled(
      batchIds.map(async (id) => {
        const url = `${DETAIL_URL_BASE}${id}`;
        const html = await fetchText(url);
        return { id, html, valid: isValidJobPage(html) };
      })
    );

    let batchHasValid = false;
    for (const result of results) {
      totalScanned++;
      if (result.status !== 'fulfilled' || !result.value.valid) continue;

      batchHasValid = true;
      totalValid++;
      consecutiveMisses = 0;
      const { id, html } = result.value;
      const meta = quickExtractJobMeta(html);

      if (isGiorgioArmaniSwissJob(meta.title, meta.country)) {
        swissJobs.push({ reqId: String(id), ...meta, html });
        console.log(`  🇨🇭 Swiss: ${meta.title} (${id}) — ${meta.country}`);
      }
    }

    if (!batchHasValid) {
      consecutiveMisses += SCAN_BATCH_SIZE;
    }
  }

  console.log(`📋 Scan complete: ${totalScanned} IDs checked, ${totalValid} valid, ${swissJobs.length} Swiss`);
  return swissJobs;
}

function buildJobUrl(reqId) {
  return `${DETAIL_URL_BASE}${reqId}`;
}

function buildApplyUrl(reqId) {
  return `https://career5.successfactors.eu/sfcareer/jobreqcareer?jobId=${reqId}&company=${SF_COMPANY_ID}`;
}

/**
 * Extract city/location from the job title.
 * Giorgio Armani titles often contain the city: "Client Advisor - Giorgio Armani Zurigo"
 */
function extractLocationFromTitle(title = '') {
  // Common patterns: "Role - Brand Location", "Role - Location"
  const parts = title.split(/\s+-\s+/);
  if (parts.length >= 2) {
    const lastPart = parts[parts.length - 1].trim();
    // Remove brand prefixes
    const location = lastPart
      .replace(/^(?:Giorgio Armani|Emporio Armani|Armani Outlet|Armani Exchange|A\|X)\s*/i, '')
      .trim();
    if (location && location.length > 2) return location;
  }
  return '';
}

async function buildGiorgioArmaniJob(discovery) {
  const detail = parseGiorgioArmaniJobDetail(discovery.html);
  const location = extractLocationFromTitle(detail.title);
  const canton = inferGiorgioArmaniCanton(detail.title, location);
  const localized = buildGiorgioArmaniLocalizedContent(
    { ...detail, location },
    COMPANY_NAME
  );

  return {
    title: detail.title,
    slug: localized.slugByLocale.it,
    url: buildJobUrl(discovery.reqId),
    applyUrl: detail.applyHref ? `https://career5.successfactors.eu${detail.applyHref}` : buildApplyUrl(discovery.reqId),
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: location || detail.country,
    addressLocality: location || '',
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    category: inferGiorgioArmaniCategory(detail.area, detail.title),
    sector: 'Moda & Lusso',
    source: 'giorgio-armani-dedicated-crawler',
    sourceLang: detectLang(detail.description || '', 'en'),
    postedDate: toIsoDate(),
    employmentType: 'full-time',
    contractType: 'full-time',
    validThrough: '',
    description: detail.description,
    titleByLocale: localized.titleByLocale,
    descriptionByLocale: localized.descriptionByLocale,
    slugByLocale: localized.slugByLocale,
  };
}

function jobMatchKey(job = {}) {
  // Match by URL (which contains the unique reqId)
  const url = String(job.url || '').trim().toLowerCase();
  const reqIdMatch = url.match(/career_job_req_id=(\d+)/);
  if (reqIdMatch) return `armani-${reqIdMatch[1]}`;
  return String(job.slug || '').trim().toLowerCase();
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
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  writeJobsSummary(mergedTarget, COMPANY_NAME);
  printPublishedJobUrls(mergedTarget, COMPANY_NAME);
  return { total: mergedTarget.length, added, updated };
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
    priority: 16,
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL],
    notes: `Dedicated Giorgio Armani crawler scans SuccessFactors (company=${SF_COMPANY_ID}) detail pages for Switzerland-based positions.`,
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_GIORGIO_ARMANI_STRICT',
    label: COMPANY_NAME,
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_armani_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Giorgio Armani Swiss jobs found (this may be normal — positions fluctuate).',
    detectSourceLang: (text) => detectLang(text, 'en'),
  });
}

async function main() {
  setCrawlerStartTime();
  console.log('═══════════════════════════════════════════════');
  console.log('  Giorgio Armani — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}`);
  console.log(`  SuccessFactors company: ${SF_COMPANY_ID}`);
  console.log(`  Scan range: ${SCAN_START_ID} → ${MIN_SCAN_ID}\n`);

  const discoveries = await discoverSwissJobs();

  if (discoveries.length === 0) {
    console.log('\n⚠️  No Swiss jobs found. Preserving existing data.');
    // Still run merge to handle stale job cleanup
    mergeJobs([]);
    updateAdapterConfig([]);
    validateLocales();
    console.log('\n✅ Giorgio Armani crawler complete (0 Swiss jobs found).');
    return;
  }

  const jobs = [];
  for (const disc of discoveries) {
    console.log(`  📄 Processing: ${disc.title} (${disc.reqId})`);
    jobs.push(await buildGiorgioArmaniJob(disc));
  }

  const { total, added, updated } = mergeJobs(jobs);
  updateAdapterConfig(jobs);

  console.log('\n🌐 Running locale fill for Giorgio Armani jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();
  console.log(`\n✅ Giorgio Armani crawler complete (${total} jobs, added=${added}, updated=${updated}).`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'giorgio-armani',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: 0,
    updatedCount: 0,
    removedCount: 0,
    unchangedCount: _sliceJobs.length,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: [],
    updatedJobs: [],
    removedJobs: [],
    unchangedJobs: _sliceJobs.slice(0, 30),
  });
  await assembleJobsDataset();
}

main().catch((err) => {
  console.error(`❌ Giorgio Armani crawler failed: ${err?.message || err}`);
  process.exit(1);
});
