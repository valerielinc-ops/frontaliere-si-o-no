#!/usr/bin/env node
/**
 * Dedicated VF crawler runner.
 * Runs only VF company jobs and enforces full locale coverage for title/description.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { fileURLToPath } from 'node:url';
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
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
} from './lib/dedicated-crawler-common.mjs';
import { holdSourceLang } from './lib/job-locale-utils.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { resolveVfSwissLocation } from './lib/vf-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VF_KEY = 'vf-international-the-north-face-timberland';
// Same per-crawler-scoped scratch path runDedicatedBaseCrawler defaults to
// internally for a single-key run. The shared data/jobs.json is absent under
// CI's slice-only mode (assembly deferred to deploy time) and would otherwise
// race across ~25 sibling crawler-group steps sharing one filesystem —
// pointing this script's own DATA_JOBS at the scratch path means it sees the
// shared engine's actual freshly-crawled+localized output instead of
// crashing on the unguarded read below (issue #3768).
const DATA_JOBS = crawlerScratchPathFor(VF_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;

function writeVfJobs(jobs) {
  writeJsonAtomic(DATA_JOBS, jobs);
  writeJsonAtomic(PUBLIC_JOBS, jobs);
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

function isVfJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  const isVfWorkdayUrl = url.includes('/vfc_careers') || url.includes('vfc.com');
  return (
    key.includes(VF_KEY) ||
    key.includes('vf-international') ||
    key.includes('the-north-face') ||
    host.includes('vfc.com') ||
    (host.includes('myworkdayjobs.com') && isVfWorkdayUrl)
  );
}

function runBaseCrawler() {
  // Keep dedicated runner focused on crawl/localization only.
  // Do not reintroduce salary/address enrichment env flags here (handled by re-enrich-jobs.mjs).
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: VF_KEY,
    localizeOnlyCompanyKeys: VF_KEY,
    forceLocalizeKeys: VF_KEY,
  });
}

function normalizeVfLocations() {
  if (!fs.existsSync(DATA_JOBS)) return { normalized: 0, unresolved: 0, total: 0, byCanton: {} };
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let normalized = 0;
  let unresolved = 0;
  const byCanton = {};

  for (const job of jobs) {
    if (!isVfJob(job)) continue;
    const rawLocation = String(job.location || job.addressLocality || '').trim();
    const resolved = resolveVfSwissLocation(rawLocation);
    if (!resolved) {
      unresolved += 1;
      console.warn(`⚠️ VF job has no concrete Swiss Workday locality; leaving it unresolved: ${job.title || 'untitled'} (${rawLocation || 'unknown'})`);
      continue;
    }

    const changed =
      job.location !== resolved.locality ||
      job.addressLocality !== resolved.locality ||
      job.canton !== resolved.canton ||
      job.addressRegion !== resolved.canton ||
      job.country !== 'CH' ||
      job.addressCountry !== 'CH';
    job.location = resolved.locality;
    job.addressLocality = resolved.locality;
    job.canton = resolved.canton;
    job.addressRegion = resolved.canton;
    job.country = 'CH';
    job.addressCountry = 'CH';
    // Keep the field present even when Workday provides no postal code. The
    // assembler/build schema then derives a locality-coherent safe default;
    // never copy a fixed Stabio/Ticino value here.
    job.postalCode = String(job.postalCode || '');
    if (changed) normalized += 1;
    byCanton[resolved.canton] = (byCanton[resolved.canton] || 0) + 1;
  }

  if (normalized > 0) writeVfJobs(jobs);
  console.log(`🗺️ VF Swiss locality normalization: ${normalized}/${normalized + unresolved} changed, ${unresolved} unresolved; cantons ${JSON.stringify(byCanton)}`);
  return { normalized, unresolved, total: normalized + unresolved, byCanton };
}

function ensureSourceLang() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(jobs)) return;
  let changed = 0;
  for (const job of jobs) {
    if (!isVfJob(job)) continue;
    const heldLang = holdSourceLang(job, job.description || job.title, 'en');
    if (job.sourceLang !== heldLang) { job.sourceLang = heldLang; changed++; }
  }
  if (changed > 0) {
    writeVfJobs(jobs);
    console.log(`📝 Set sourceLang on ${changed} VF job(s).`);
  }
}

function validateVfLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_VF_STRICT',
    label: 'VF',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isVfJob,
    checkSlug: false,
    failOnMissingJobsFile: true,
    failWhenNoJobs: true,
    noJobsMessage: 'No VF jobs found after crawl.',
    sampleLimit: 25,
    detectSourceLang: (text) => detectLang(text, 'en'),
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(VF_KEY, 'VF');
  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  console.log('🎯 Running dedicated VF jobs crawler (with forced localization)...');

  // Snapshot VF jobs before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(VF_KEY, DATA_JOBS).filter(isVfJob))

  await runBaseCrawler();
  normalizeVfLocations();
  ensureSourceLang();
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isVfJob,
  });
  // Crawl change summary (new/updated/removed)
  {
    const raw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
    const jobs = (Array.isArray(raw) ? raw : []).filter(isVfJob);
    const afterSnapshot = snapshotJobSlugs(jobs);
    const crawlDiff = computeCrawlDiff(_beforeSnapshot, afterSnapshot);
    printCrawlChangeSummary(crawlDiff, 'VF');
    writeCrawlChangeSummaryToGH(crawlDiff, 'VF');
  }

  validateVfLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isVfJob) : [];
  writeJobsCrawlerSlice(VF_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: VF_KEY,
    label: 'VF',
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

main().catch((err) => exitCrawlerOnError(err, 'VF'));
