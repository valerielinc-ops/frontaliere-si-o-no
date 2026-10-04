#!/usr/bin/env node
import { sourcePostingDateFields, mergeSourcePostingDates } from './lib/source-posting-date.mjs';
/**
 * PEMSA — Dedicated Crawler
 *
 * Crawls https://www.pemsa.ch/it/le-nostre-offerte-di-lavoro/
 * 1. Fetches national listing page (all cantons) → extracts job URLs
 * 2. Fetches each detail page → extracts JSON-LD JobPosting
 * 3. Merges into data/jobs.json
 * 4. Updates adapter config
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
  captureLostSlugs,
} from './lib/dedicated-crawler-common.mjs';
import {
  parsePemsaListingPage,
  parsePemsaDetailPage,
  isPemsaSwissRelevant,
  buildPemsaLocalizedContent,
  mergePemsaJobRecord,
  PEMSA_FABRICATED_DESCRIPTION_RE,
} from './lib/pemsa-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTER_PATH = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters', 'pemsa.json');

const COMPANY_KEY = 'pemsa';
// Per-crawler-scoped scratch path — this crawler does its own fetch+merge
// (no runDedicatedBaseCrawler call), but still runs as one of ~25 sibling
// background steps sharing a filesystem checkout in CI, so writing straight
// to the shared, gitignored, CI-absent data/jobs.json is the same
// cross-process-racy write pattern behind #3769/#3770. Scope it per-company.
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'PEMSA';
const COMPANY_HOST = 'www.pemsa.ch';
const COMPANY_DOMAIN = 'pemsa.ch';
const CAREERS_URL = 'https://www.pemsa.ch/it/le-nostre-offerte-di-lavoro/';
const LOCALES = ['it', 'en', 'de', 'fr'];

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
const DETAIL_DELAY_MS = 500;

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

function isTargetJob(job = {}) {
  const key = normalizeKey(job.companyKey || job.company || '');
  const company = normalize(job.company || '');
  const url = String(job.url || '').toLowerCase();
  return (
    key === COMPANY_KEY ||
    company.includes('pemsa') ||
    url.includes('pemsa.ch')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'www.pemsa.ch' || host === 'pemsa.ch';
  } catch {
    return false;
  }
}

function inferCategory(title = '') {
  const h = normalize(title);
  if (/muratore|carpentiere|manovale|edil/i.test(h)) return 'edilizia';
  if (/idraulic|sanitari|riscaldamento|rvcs/i.test(h)) return 'impiantistica';
  if (/elettric/i.test(h)) return 'elettricità';
  if (/ferraiolo|metalcostruttore|saldatore/i.test(h)) return 'metallo';
  if (/meccanico|manutentore|montatore/i.test(h)) return 'meccanica';
  if (/giardiniere|gessatore|pittore|piastrellista|impermeabilizzat|copritetto|paviment/i.test(h)) return 'edilizia';
  if (/autista|rullista|macchinista|ponteggi/i.test(h)) return 'cantiere';
  if (/disegnatore|progettista/i.test(h)) return 'progettazione';
  if (/fresator/i.test(h)) return 'cantiere';
  return 'edilizia';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}


function buildPemsaJob(detail, url) {
  const city = detail.city || '';
  // PEMSA is a national agency (HQ Geneva + Ticino branch); the JSON-LD region
  // field is usually empty, so derive the canton per-job from the city. No HQ
  // default — leave blank when unresolved so the downstream hardening fills it
  // instead of mislabeling on a fixed canton.
  const canton = inferAnyCanton(city) || inferAnyCanton(detail.region || '') || '';
  const localized = buildPemsaLocalizedContent(detail);
  const { sourceLang } = localized;

  return {
    title: localized.titleByLocale[sourceLang],
    slug: localized.slugByLocale[sourceLang] || localized.slugByLocale.it,
    url,
    applyUrl: url,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    companyDomain: COMPANY_DOMAIN,
    location: city,
    addressLocality: city,
    addressRegion: detail.region || canton,
    addressCountry: detail.country || 'CH',
    canton,
    country: 'CH',
    category: inferCategory(detail.title),
    sector: 'Edilizia e tecnica',
    source: 'pemsa-dedicated-crawler',
    sourceLang,
    ...sourcePostingDateFields(detail.datePosted),
    employmentType: detail.employmentType?.toLowerCase().includes('part') ? 'part-time' : 'full-time',
    contractType: 'temporary',
    validThrough: detail.validThrough || '',
    description: localized.descriptionByLocale[sourceLang] || '',
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
  // Stored records lose the text the crawler side once wrote (the invented
  // recruitment paragraph, the central company paragraph) and the
  // translations made from it before they are merged (issue 5253).
  const targetExisting = dropFabricatedDescriptions(existing.filter(isTargetJob), PEMSA_FABRICATED_DESCRIPTION_RE, 'PEMSA');
  const beforeSnapshot = snapshotJobSlugs(targetExisting);
  const existingByKey = new Map(targetExisting.map((job) => [jobMatchKey(job), job]));

  let added = 0;
  let updated = 0;
  let unpublished = 0;
  const mergedTarget = [];
  for (const job of discoveredJobs) {
    const prev = existingByKey.get(jobMatchKey(job)) || null;
    // Source text only (issue 5253): a job without a body keeps the body an
    // earlier run read from the source, or is not published this run.
    const merged = mergePemsaJobRecord(prev, job);
    if (!merged) {
      unpublished += 1;
      console.log(`  ⏭️ No source body for ${job.url} — not published this run`);
      continue;
    }
    if (!prev) {
      added += 1;
    } else {
      updated += 1;
      captureLostSlugs(merged, prev.slugByLocale, prev.slug, 20);
    }
    mergedTarget.push(merged);
  }
  if (unpublished > 0) console.log(`  ⏭️ ${unpublished} PEMSA job(s) without a source body not published`);

  const allJobs = [...nonTargetJobs, ...mergedTarget];
  writeJson(DATA_JOBS, allJobs);
  writeJson(PUBLIC_JOBS, allJobs);

  const afterSnapshot = snapshotJobSlugs(mergedTarget);
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'PEMSA');
  writeCrawlChangeSummaryToGH(diff, 'PEMSA');
  writeJobsSummary(mergedTarget, 'PEMSA');
  printPublishedJobUrls(mergedTarget, 'PEMSA');
  return { total: mergedTarget.length, added, updated, diff };
}

export function updateAdapterConfig(jobs, outputPath = ADAPTER_PATH) {
  const seedMetaByUrl = {};
  for (const job of jobs) {
    seedMetaByUrl[job.url] = {
      location: job.location,
      canton: job.canton || DEFAULT_CANTON,
      company: COMPANY_NAME,
      ...mergeSourcePostingDates({}, job),
    };
  }
  writeJson(outputPath, {
    companyKey: COMPANY_KEY,
    companyName: COMPANY_NAME,
    companyHost: COMPANY_HOST,
    enabled: true,
    priority: 18,
    crawlerModes: ['html'],
    seedUrls: [CAREERS_URL],
    notes: 'Dedicated PEMSA crawler. National listing (all cantons). Detail pages have JSON-LD JobPosting with full location data; canton inferred per-job from the city. Construction/trades staffing agency.',
    updatedAt: new Date().toISOString(),
    seedMetaByUrl,
  });
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_PEMSA_STRICT',
    label: 'PEMSA',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_pemsa_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No PEMSA jobs found after dedicated crawl.',
    detectSourceLang: (text, job) => job?.sourceLang || detectLang(text, 'it'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'PEMSA');
  console.log('═══════════════════════════════════════════════');
  console.log('  PEMSA — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  console.log('🔍 Fetching PEMSA job listings (all cantons)...');
  const jobUrls = await parsePemsaListingPage(TIMEOUT_MS);
  console.log(`📋 Found ${jobUrls.length} job URLs on listing page`);

  if (jobUrls.length === 0) {
    console.log('⚠️ No job URLs found — skipping.');
    return;
  }

  // Fetch detail pages for JSON-LD
  console.log('\n📄 Fetching detail pages for job data...');
  const jobs = [];
  let skipped = 0;
  for (const url of jobUrls) {
    const detail = await parsePemsaDetailPage(url, TIMEOUT_MS);
    if (detail && detail.title && isPemsaSwissRelevant(detail)) {
      console.log(`  ✅ ${detail.title} → ${detail.city || '?'} (${detail.region || '?'})`);
      jobs.push(buildPemsaJob(detail, url));
    } else if (detail) {
      console.log(`  ⏭️  ${detail.title} → ${detail.city || '?'} (${detail.region || '?'}) [skipped]`);
      skipped++;
    } else {
      console.log(`  ⚠️ ${url} → detail page failed`);
      skipped++;
    }
    if (jobs.length + skipped < jobUrls.length) await sleep(DETAIL_DELAY_MS);
  }

  console.log(`\n📍 Swiss-relevant: ${jobs.length} / ${jobUrls.length}`);

  if (jobs.length === 0) {
    console.log('⚠️ No Swiss-relevant jobs found — skipping.');
    return;
  }

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
    console.log(`🔄 Deduplicated: ${jobs.length} → ${deduplicated.length} unique`);
  }

  const { total, added, updated, diff} = mergeJobs(deduplicated);
  updateAdapterConfig(deduplicated);

  console.log('\n🌐 Running locale fill for PEMSA jobs...');
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob,
  });

  validateLocales();

  console.log('\n📊 === PEMSA Job Stats ===');
  console.log(`  🏢 Total PEMSA jobs: ${total}`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTargetJob) : [];
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'PEMSA',
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => exitCrawlerOnError(error, 'PEMSA'));
}
