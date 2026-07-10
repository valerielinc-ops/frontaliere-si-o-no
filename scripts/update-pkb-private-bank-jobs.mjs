#!/usr/bin/env node
/**
 * Dedicated PKB Private Bank crawler runner.
 *
 * PKB Private Bank SA uses the Arca24 recruitment ATS at
 * https://careers.pkb.ch/jobs.php (same ATS backend as LIS Lugano Istituti
 * Sociali). This crawler was previously retired (#222) after repeatedly
 * returning 0 jobs — root cause: the listing page requires a bot-recognised
 * User-Agent (containing "Slackbot") plus `?custom2=Yes&source=direct` query
 * params to skip Arca24's JS-redirect bounce page and return real HTML. See
 * scripts/lib/pkb-private-bank-job-parser.mjs for full detail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { fileURLToPath } from 'node:url';
import { safeLocationToken } from './lib/safe-location-token.mjs';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  detectLang,
  deriveLocalizedSlug,
  mergePreserveLocaleData,
} from './lib/dedicated-crawler-common.mjs';
import {
  fetchPkbJobUrls,
  fetchPkbDetailPage,
  buildPkbJob,
  PKB_KEY,
  COMPANY_NAME,
  COMPANY_DOMAIN,
} from './lib/pkb-private-bank-job-parser.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run (see corner-banca/dic-sa
// runners for the same pattern; bug class of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(PKB_KEY);
const PUBLIC_DATA_JOBS = `${DATA_JOBS}.public.json`;

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isPkbJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return key.includes(PKB_KEY) || host.includes('pkb.ch');
}

function isTrustedPkbDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.endsWith('pkb.ch');
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────
// Fetch + parse
// ──────────────────────────────────────────────────────────────

async function fetchAndParsePkbJobs() {
  console.log(`🏦 Fetching ${COMPANY_NAME} jobs from Arca24 (${COMPANY_DOMAIN})...`);
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  const { jobs: listingJobs, attempted, succeeded, failed } = await fetchPkbJobUrls({ timeoutMs });
  console.log(`  📦 Listing pages: ${succeeded}/${attempted} fetched, ${listingJobs.length} job link(s) found`);
  if (listingJobs.length === 0) {
    console.log('⚠️ No listing jobs found. Keeping existing PKB jobs unchanged.');
    return [];
  }

  const parsedJobs = [];
  for (const listingJob of listingJobs) {
    // eslint-disable-next-line no-await-in-loop
    const detail = await fetchPkbDetailPage(listingJob.url, { timeoutMs });
    const merged = detail || {
      title: listingJob.title,
      location: listingJob.location,
      url: listingJob.url,
      description: listingJob.snippet,
    };
    const job = buildPkbJob(listingJob.url, merged);
    if (!job) continue;
    job.sourceLang = detectLang(job.description || job.title, 'it');
    job.crawledAt = new Date().toISOString();
    parsedJobs.push(job);
    console.log(`  ✅ ${job.title} — ${job.location} (${job.canton})`);
  }
  console.log(`✅ Parsed ${COMPANY_NAME} jobs: ${parsedJobs.length}`);
  return parsedJobs;
}

// ──────────────────────────────────────────────────────────────
// Merge & write
// ──────────────────────────────────────────────────────────────

function writeJobsFiles(jobs) {
  writeJsonAtomic(DATA_JOBS, jobs);
  if (fs.existsSync(PUBLIC_DATA_JOBS)) {
    writeJsonAtomic(PUBLIC_DATA_JOBS, jobs);
  }
}

function mergeParsedPkbJobs(parsedJobs) {
  const existing = readExistingCrawlerJobs(PKB_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? existing : [];
  const nonPkb = allJobs.filter((job) => !isPkbJob(job));
  const pkbExisting = allJobs.filter(isPkbJob);

  const byUrl = new Map();
  for (const job of parsedJobs) {
    const key = String(job?.url || '').trim().replace(/\/+$/, '');
    if (!key) continue;
    // safeLocationToken guard mirrors corner-banca's slug-only guard: avoid
    // literal "undefined"/"null" leaking into active location tokens.
    job.location = safeLocationToken(job.location, job.location || 'Lugano');
    byUrl.set(key, job);
  }
  const deduped = [...byUrl.values()];

  const cleanPkbJobs = mergePreserveLocaleData(pkbExisting, deduped).sort(
    (a, b) => String(b.postedDate || '').localeCompare(String(a.postedDate || ''))
  );
  const merged = [...nonPkb, ...cleanPkbJobs];
  writeJobsFiles(merged);
  return cleanPkbJobs;
}

// ──────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────

function validatePkbLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_PKB_STRICT',
    label: 'PKB',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isPkbJob,
    failOnMissingJobsFile: true,
    failWhenNoJobs: true,
    noJobsMessage: 'No PKB Private Bank jobs found after crawl.',
    detectSourceLang: (text) => detectLang(text, 'it'),
    deriveSlug: deriveLocalizedSlug,
    isTrustedDomain: isTrustedPkbDomain,
    untrustedDomainReason: 'untrusted_domain_for_pkb_job',
  });
}

async function runBaseCrawler() {
  console.log('🚀 Running shared crawler for AI localization...');
  await runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: PKB_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    forceLocalizationWhenAiEnabledOnly: true,
  });
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(PKB_KEY, 'PKB');
  console.log(`🏦 Running dedicated ${COMPANY_NAME} jobs crawler (Arca24)...`);

  const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(PKB_KEY, DATA_JOBS).filter(isPkbJob));

  const parsedJobs = await fetchAndParsePkbJobs();
  if (parsedJobs.length === 0) {
    console.log('⚠️ No valid jobs parsed — keeping existing PKB jobs unchanged.');
    return;
  }

  const publishedJobs = mergeParsedPkbJobs(parsedJobs);
  printPublishedJobUrls(publishedJobs, 'PKB');
  writeJobsSummary(publishedJobs, 'PKB');

  const afterSnapshot = snapshotJobSlugs(publishedJobs);
  const crawlDiff = computeCrawlDiff(_beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'PKB');
  writeCrawlChangeSummaryToGH(crawlDiff, 'PKB');

  await runBaseCrawler();
  validatePkbLocaleCoverage();

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isPkbJob) : [];
  writeJobsCrawlerSlice(PKB_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: PKB_KEY,
    label: 'PKB',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: crawlDiff.newJobs.length,
    updatedCount: crawlDiff.updatedJobs.length,
    removedCount: crawlDiff.removedJobs.length,
    unchangedCount: crawlDiff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: crawlDiff.newJobs.slice(0, 30),
    updatedJobs: crawlDiff.updatedJobs.slice(0, 30),
    removedJobs: crawlDiff.removedJobs.slice(0, 30),
    unchangedJobs: (crawlDiff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

main().catch((err) => exitCrawlerOnError(err, 'PKB'));
