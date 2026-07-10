#!/usr/bin/env node
/**
 * Dedicated McDonald's Switzerland crawler runner.
 *
 * See scripts/lib/mcdonalds-job-parser.mjs for the full root-cause
 * explanation and discovery strategy (sitemap enumeration + per-job
 * JSON-LD, no Playwright needed — the client-side /api/get-jobs endpoint
 * is bot-protected, but the public sitemap + SSR detail pages are not).
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
  fetchMcdoJobs,
  MCDO_KEY,
  COMPANY_NAME,
  COMPANY_DOMAIN,
} from './lib/mcdonalds-job-parser.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = crawlerScratchPathFor(MCDO_KEY);
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

function isMcdoJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return key === MCDO_KEY || key.startsWith('mcdonald') || host.includes('mcdonalds.ch');
}

function isTrustedMcdoDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.endsWith('mcdonalds.ch');
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────
// Fetch + parse
// ──────────────────────────────────────────────────────────────

async function fetchAndParseMcdoJobs() {
  console.log(`🍟 Fetching ${COMPANY_NAME} jobs from ${COMPANY_DOMAIN} (sitemap discovery)...`);
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;

  const rawJobs = await fetchMcdoJobs({ timeoutMs, detailConcurrency: 8 });
  console.log(`✅ Parsed ${COMPANY_NAME} jobs: ${rawJobs.length}`);

  const jobs = rawJobs.map((job) => ({
    ...job,
    sourceLang: detectLang(job.description || job.title, 'de'),
    crawledAt: new Date().toISOString(),
    titleByLocale: { de: job.title },
    slugByLocale: { de: job.slug },
    descriptionByLocale: { de: job.description },
  }));
  for (const job of jobs) {
    console.log(`  ✅ ${job.title} — ${job.location} (${job.canton})`);
  }
  return jobs;
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

function mergeParsedMcdoJobs(parsedJobs) {
  const existing = readExistingCrawlerJobs(MCDO_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? existing : [];
  const nonMcdo = allJobs.filter((job) => !isMcdoJob(job));
  const mcdoExisting = allJobs.filter(isMcdoJob);

  const byUrl = new Map();
  for (const job of parsedJobs) {
    const key = String(job?.url || '').trim().replace(/\/+$/, '');
    if (!key) continue;
    job.location = safeLocationToken(job.location, job.location || 'Svizzera');
    byUrl.set(key, job);
  }
  const deduped = [...byUrl.values()];

  const cleanMcdoJobs = mergePreserveLocaleData(mcdoExisting, deduped).sort(
    (a, b) => String(b.postedDate || '').localeCompare(String(a.postedDate || ''))
  );
  const merged = [...nonMcdo, ...cleanMcdoJobs];
  writeJobsFiles(merged);
  return cleanMcdoJobs;
}

// ──────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────

function validateMcdoLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_MCDONALDS_STRICT',
    label: "McDonald's Switzerland",
    dataJobsPath: DATA_JOBS,
    isTargetJob: isMcdoJob,
    failOnMissingJobsFile: true,
    failWhenNoJobs: true,
    noJobsMessage: "No McDonald's Switzerland jobs found after crawl.",
    detectSourceLang: (text) => detectLang(text, 'de'),
    deriveSlug: deriveLocalizedSlug,
    isTrustedDomain: isTrustedMcdoDomain,
    untrustedDomainReason: 'untrusted_domain_for_mcdonalds_job',
  });
}

async function runBaseCrawler() {
  console.log('🚀 Running shared crawler for AI localization...');
  await runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: MCDO_KEY,
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
  registerCrawlerSummaryGuard(MCDO_KEY, "McDonald's");
  console.log(`🍟 Running dedicated ${COMPANY_NAME} jobs crawler (sitemap + JSON-LD)...`);

  const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(MCDO_KEY, DATA_JOBS).filter(isMcdoJob));

  const parsedJobs = await fetchAndParseMcdoJobs();
  if (parsedJobs.length === 0) {
    console.log('⚠️ No valid jobs parsed — keeping existing McDonald\'s jobs unchanged.');
    return;
  }

  const publishedJobs = mergeParsedMcdoJobs(parsedJobs);
  printPublishedJobUrls(publishedJobs, "McDonald's");
  writeJobsSummary(publishedJobs, "McDonald's");

  const afterSnapshot = snapshotJobSlugs(publishedJobs);
  const crawlDiff = computeCrawlDiff(_beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, "McDonald's");
  writeCrawlChangeSummaryToGH(crawlDiff, "McDonald's");

  await runBaseCrawler();
  validateMcdoLocaleCoverage();

  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isMcdoJob) : [];
  writeJobsCrawlerSlice(MCDO_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: MCDO_KEY,
    label: "McDonald's",
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

main().catch((err) => exitCrawlerOnError(err, "McDonald's"));
