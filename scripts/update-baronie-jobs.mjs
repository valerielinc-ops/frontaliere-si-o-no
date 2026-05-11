#!/usr/bin/env node
/**
 * Dedicated Baronie (Chocolat Alprose SA / Baronie Switzerland SA) crawler runner.
 *
 * The company's careers page is at:
 *   https://www.baronie.com/en/careers
 *
 * Job detail pages are at:
 *   https://www.baronie.com/en/jobs/{slug}
 *
 * The company has offices in Belgium, Germany, UK, Switzerland (Caslano, TI),
 * Netherlands, France, and others.  We only want jobs located in Switzerland.
 *
 * This crawler:
 *   1. Scrapes the /en/careers page for all /en/jobs/ detail links.
 *   2. Fetches each detail page and extracts structured content.
 *   3. Filters to Swiss-only jobs (JSON-LD addressCountry=CH).
 *   4. Merges into data/jobs.json with stale translation cleanup.
 *   5. Translates and validates locale coverage.
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
  fetchBaronieJobUrls,
  fetchBaronieDetailPage,
  buildBaronieLocalizedContent,
  titleOverlap,
  isSwissJob,
} from './lib/baronie-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'baronie.json');

const COMPANY_KEY = 'baronie';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Baronie';
const COMPANY_HOST = 'www.baronie.com';
const COMPANY_DOMAIN = 'baronie.com';
const CAREERS_URL = 'https://www.baronie.com/en/careers';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;
const DETAIL_DELAY_MS = 800;

/* ── Helpers ───────────────────────────────────────────────── */
function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return fallback; }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeKey(value = '') {
  return String(value || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    key === 'chocolat-alprose-sa-baronie-switzerland-sa' ||
    key === 'chocolat-alprose' ||
    company.includes('baronie') ||
    company.includes('alprose') ||
    url.includes('baronie.com')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === COMPANY_HOST || host.endsWith('.baronie.com');
  } catch { return false; }
}

function inferCategory(title = '') {
  const h = normalize(title);
  if (/sales|account|commercial|vendite/i.test(h)) return 'sales';
  if (/customer.*service|support/i.test(h)) return 'customer-service';
  if (/sustainability|environment/i.test(h)) return 'sustainability';
  if (/admin|segretari/i.test(h)) return 'administration';
  if (/manager|lead|director|responsabile/i.test(h)) return 'management';
  if (/engineer|tecnico|production/i.test(h)) return 'production';
  return 'general';
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ── Job Builder ───────────────────────────────────────────── */
function buildBaronieJob(url, detail) {
  const title = detail.detailTitle || '';
  const city = detail.location || 'Caslano';
  const company = detail.company || 'Chocolat Alprose SA / Baronie Switzerland SA';

  const localized = buildBaronieLocalizedContent({
    title,
    location: city,
    company,
    detailMarkdown: detail.markdown,
  });

  const job = {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url,
    applyUrl: url,
    company,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: city,
    addressLocality: city,
    addressRegion: 'TI',
    addressCountry: 'CH',
    canton: DEFAULT_CANTON,
    country: 'CH',
    category: inferCategory(title),
    sector: 'Alimentare / Cioccolato',
    source: 'baronie-dedicated-crawler',
    sourceLang: detectLang(detail.markdown || title, 'en'),
    postedDate: new Date().toISOString().slice(0, 10),
    employmentType: 'full-time',
    contractType: 'permanent',
    validThrough: '',
    description: localized.descriptionByLocale.it,
    titleByLocale: localized.titleByLocale,
    descriptionByLocale: localized.descriptionByLocale,
    slugByLocale: localized.slugByLocale,
  };

  if (detail.markdown && detail.markdown.length > 100) {
    job._enrichedFromDetail = true;
  }

  return job;
}

/* ── Merge ─────────────────────────────────────────────────── */
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
      const clean = { ...job };
      delete clean._enrichedFromDetail;
      return clean;
    }
    updated += 1;
    const prevDesc = job._enrichedFromDetail ? {} : (prev.descriptionByLocale || {});
    const srcLang = job.sourceLang || prev.sourceLang || null;
    const clean = {
      ...prev,
      ...job,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3, srcLang),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale || {}, { ...prevDesc, ...(job.descriptionByLocale || {}) }, 30, srcLang),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3, srcLang),
      needsRetranslation: job._enrichedFromDetail ? true : (prev.needsRetranslation || false),
    };
    delete clean._enrichedFromDetail;
    return clean;
  });

  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  writeJson(PUBLIC_JOBS, allJobs);

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'Baronie');
  writeCrawlChangeSummaryToGH(diff, 'Baronie');
  writeJobsSummary(mergedTarget, 'Baronie');
  printPublishedJobUrls(mergedTarget, 'Baronie');
  return { total: mergedTarget.length, added, updated, diff };
}

/* ── Adapter ───────────────────────────────────────────────── */
function updateAdapterConfig(jobs) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = {
      location: job.location,
      canton: DEFAULT_CANTON,
      company: job.company,
      postedDate: job.postedDate,
    };
  }
  writeJson(ADAPTER_PATH, {
    companyKey: COMPANY_KEY,
    companyName: COMPANY_NAME,
    companyHost: COMPANY_HOST,
    enabled: true,
    priority: 10,
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL],
    notes: 'Baronie (Chocolat Alprose SA) — chocolate manufacturer in Caslano, TI. Custom parser extracts structured content from detail pages. Only Swiss jobs are included.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

/* ── Validation ────────────────────────────────────────────── */
function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_BARONIE_STRICT',
    label: 'Baronie',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_baronie_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Baronie jobs found after dedicated crawl.',
    detectSourceLang: () => 'en',
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Baronie');
  console.log('═══════════════════════════════════════════════');
  console.log('  Baronie — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  // 1. Discover job URLs
  console.log('🔍 Fetching Baronie job listings...');
  const jobUrls = await fetchBaronieJobUrls(TIMEOUT_MS);
  console.log(`📋 Found ${jobUrls.length} job URLs`);
  if (jobUrls.length === 0) {
    console.log('⚠️ No job URLs found — skipping.');
    return;
  }

  // 2. Fetch and parse each detail page
  console.log('\n📄 Fetching detail pages...');
  const parsed = [];
  for (const url of jobUrls) {
    const detail = await fetchBaronieDetailPage(url, TIMEOUT_MS);
    if (detail) {
      const swiss = isSwissJob(detail);
      console.log(`  ${swiss ? '✅' : '⏭️ '} ${detail.detailTitle || '(no title)'} → ${detail.location || '(no location)'} [${detail.sectionCount} sections, ${detail.markdown.length} chars]${swiss ? '' : ' — SKIPPED (not Swiss)'}`);
      if (swiss) {
        parsed.push({ url, detail });
      }
    } else {
      console.log(`  ⚠️ ${url} → detail page failed`);
    }
    if (parsed.length < jobUrls.length) await sleep(DETAIL_DELAY_MS);
  }

  console.log(`\n🇨🇭 Swiss jobs: ${parsed.length} / ${jobUrls.length} total`);
  if (parsed.length === 0) {
    console.log('⚠️ No Swiss jobs found — skipping.');
    return;
  }

  // 3. Build job objects with title overlap guard
  const jobs = parsed.map(({ url, detail }) => {
    const job = buildBaronieJob(url, detail);
    // Title overlap guard is informational (titles come from detail page h1)
    if (detail.detailTitle && job.title) {
      const overlap = titleOverlap(detail.detailTitle, job.title);
      if (overlap < 0.6) {
        console.warn(`  ⚠️ Title overlap ${(overlap * 100).toFixed(0)}% for ${url}`);
      }
    }
    return job;
  });

  // 4. Deduplicate
  const seenKeys = new Set();
  const deduplicated = [];
  for (const job of jobs) {
    const key = `${normalize(job.title)}|${normalize(job.location)}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      deduplicated.push(job);
    }
  }
  if (deduplicated.length < jobs.length) {
    console.log(`\n🔄 Deduplicated: ${jobs.length} → ${deduplicated.length} unique`);
  }

  // 5. Merge
  const { total, added, updated, diff} = mergeJobs(deduplicated);
  updateAdapterConfig(deduplicated);

  // 6. Translate missing locales
  console.log('\n🌐 Running locale fill for Baronie jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  // 7. Validate
  validateLocales();

  console.log('\n📊 === Baronie Job Stats ===');
  console.log(`  🍫 Total Baronie jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Baronie',
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
  console.error(`❌ Baronie crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
