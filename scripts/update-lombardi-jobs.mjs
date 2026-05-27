#!/usr/bin/env node
/**
 * Lombardi Group — Dedicated Crawler
 *
 * Crawls https://lombardi.group/eng/careers/open-positions
 * 1. Fetches listing page → extracts embedded _jobs JSON
 * 2. Filters Swiss/Ticino jobs (sedeId=1 → Giubiasco)
 * 3. Enriches with detail page data (full description, requirements)
 * 4. Merges into data/jobs.json
 * 5. Updates adapter config
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
  parseLombardiListingPage,
  parseLombardiDetailPage,
  isLombardiTicinoRelevant,
  buildLombardiLocalizedContent,
  titleOverlap,
} from './lib/lombardi-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'lombardi-group.json');

const COMPANY_KEY = 'lombardi-group';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Lombardi Group';
const COMPANY_HOST = 'lombardi.group';
const COMPANY_DOMAIN = 'lombardi.group';
const CAREERS_URL = 'https://lombardi.group/eng/careers/open-positions';
const DETAIL_BASE = 'https://lombardi.group/eng/careers/job?id=';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
const DETAIL_DELAY_MS = 800;

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

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    company.includes('lombardi') ||
    url.includes('lombardi.group')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'lombardi.group' || host.endsWith('.lombardi.group');
  } catch {
    return false;
  }
}

function inferCategory(title = '') {
  const h = normalize(title);
  if (/ingegnere|engineer|ingénieur|bauingenieur/i.test(h)) return 'engineering';
  if (/disegnatore|zeichner|dessinateur|projeteur|dibujante/i.test(h)) return 'drafting';
  if (/apprendista|apprenti|praxis/i.test(h)) return 'apprenticeship';
  if (/project.*manager|capo.*progetto|chef.*projet|projektleiter|abteilungsleiter|directeur/i.test(h)) return 'management';
  if (/it\b|devops|tecnico.*it|sistemist/i.test(h)) return 'technology';
  if (/electrical|elettr/i.test(h)) return 'engineering';
  return 'engineering';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildLombardiJob(raw, detail) {
  const listingTitle = String(raw.titolo || '').replace(/\s+/g, ' ').trim();
  const city = detail?.city || 'Giubiasco';
  const occupancy = detail?.occupancy || `${raw.occupMin || 80}%–${raw.occupMax || 100}%`;

  // Title resolution: prefer listing title, verify with detail page title
  let title = listingTitle;
  if (detail?.detailTitle) {
    const overlap = titleOverlap(listingTitle, detail.detailTitle);
    if (overlap < 0.6 && detail.detailTitle.length > 5) {
      console.warn(`  ⚠️ Title overlap ${(overlap * 100).toFixed(0)}% — listing: "${listingTitle}" vs detail: "${detail.detailTitle}"`);
      // Use the longer/more specific title
      title = detail.detailTitle.length > listingTitle.length ? detail.detailTitle : listingTitle;
    }
  }

  // Use full structured markdown from detail page
  const detailMarkdown = detail?.markdown || '';

  const localized = buildLombardiLocalizedContent({
    title,
    city,
    occupancy,
    detailMarkdown,
  });

  const job = {
    title: localized.titleByLocale.it,
    slug: localized.slugByLocale.it,
    url: `${DETAIL_BASE}${raw.annuncioId}`,
    applyUrl: `${DETAIL_BASE}${raw.annuncioId}`,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: city,
    addressLocality: city,
    addressRegion: 'TI',
    addressCountry: 'CH',
    canton: DEFAULT_CANTON,
    country: 'CH',
    category: inferCategory(title),
    sector: 'Ingegneria civile',
    source: 'lombardi-dedicated-crawler',
    sourceLang: detailMarkdown ? detectLang(detailMarkdown, 'it') : detectLang(title, 'it'),
    postedDate: new Date().toISOString().slice(0, 10),
    employmentType: occupancy.includes('100%') ? 'full-time' : 'part-time',
    contractType: 'permanent',
    validThrough: '',
    description: detailMarkdown || localized.descriptionByLocale.it,
    titleByLocale: localized.titleByLocale,
    descriptionByLocale: localized.descriptionByLocale,
    slugByLocale: localized.slugByLocale,
  };

  // Mark as enriched from detail page for stale translation cleanup
  if (detailMarkdown.length > 100) {
    job._enrichedFromDetail = true;
  }

  return job;
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
      const clean = { ...job };
      delete clean._enrichedFromDetail;
      return clean;
    }
    updated += 1;
    // When description was enriched from detail page, clear stale locale translations
    // so translateMissingJobLocales() regenerates them from the new rich content
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
  printCrawlChangeSummary(diff, 'Lombardi Group');
  writeCrawlChangeSummaryToGH(diff, 'Lombardi Group');
  writeJobsSummary(mergedTarget, 'Lombardi Group');
  printPublishedJobUrls(mergedTarget, 'Lombardi Group');
  return { total: mergedTarget.length, added, updated, diff };
}

function updateAdapterConfig(jobs) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = {
      location: job.location,
      canton: DEFAULT_CANTON,
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
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated Lombardi Group crawler parses embedded _jobs JSON from listing page, then enriches from detail pages. Filters sedeId=1 (Giubiasco, TI).',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_LOMBARDI_STRICT',
    label: 'Lombardi Group',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_lombardi_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Lombardi Group jobs found after dedicated crawl.',
    detectSourceLang: () => 'it',
    // Tolerate up to 2 missing/untranslated descriptions per run — Lombardi has
    // only ~3 jobs; a single AI translation failure shouldn't block the entire
    // crawler. Untranslated descriptions are retried automatically on next run.
    maxToleratedMissingDescriptions: 2,
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Lombardi Group');
  console.log('═══════════════════════════════════════════════');
  console.log('  Lombardi Group — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  console.log('🔍 Fetching Lombardi Group job listings...');
  const rawJobs = await parseLombardiListingPage(TIMEOUT_MS);
  console.log(`📋 Found ${rawJobs.length} total positions`);

  // Filter: Switzerland + Ticino sedeId
  const swissJobs = rawJobs.filter((j) => j.descNazione === 'Switzerland');
  console.log(`🇨🇭 Swiss positions: ${swissJobs.length}`);

  const ticinoJobs = swissJobs.filter((j) => isLombardiTicinoRelevant(j));
  console.log(`📍 Ticino-relevant (Giubiasco): ${ticinoJobs.length}`);

  if (ticinoJobs.length === 0) {
    console.log('⚠️ No Ticino-relevant jobs found — skipping.');
    return;
  }

  // Enrich with detail page data
  console.log('\n📄 Fetching detail pages...');
  const enriched = [];
  for (const raw of ticinoJobs) {
    const detail = await parseLombardiDetailPage(raw.annuncioId, TIMEOUT_MS);
    if (detail) {
      console.log(`  ✅ ${raw.titolo} → ${detail.city} (${detail.occupancy}) [${detail.sectionCount} sections, ${detail.markdown.length} chars]`);
    } else {
      console.log(`  ⚠️ ${raw.titolo} → detail page failed`);
    }
    enriched.push({ raw, detail });
    if (enriched.length < ticinoJobs.length) await sleep(DETAIL_DELAY_MS);
  }

  const jobs = enriched.map(({ raw, detail }) => buildLombardiJob(raw, detail));

  // Deduplicate by title + city
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

  const { total, added, updated, diff} = mergeJobs(deduplicated);
  updateAdapterConfig(deduplicated);

  console.log('\n🌐 Running locale fill for Lombardi Group jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n📊 === Lombardi Group Job Stats ===');
  console.log(`  🏢 Total Lombardi jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'Lombardi Group',
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
  console.error(`❌ Lombardi Group crawler failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
