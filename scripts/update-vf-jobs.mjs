#!/usr/bin/env node
/**
 * Dedicated VF crawler runner.
 * Runs only VF company jobs and enforces full locale coverage for title/description.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
} from './lib/dedicated-crawler-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const VF_KEY = 'vf-international-the-north-face-timberland';

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
  console.log('🎯 Running dedicated VF jobs crawler (with forced localization)...');

  // Snapshot VF jobs before crawl for diff summary
  let _beforeSnapshot = new Map();
  if (fs.existsSync(DATA_JOBS)) {
    try {
      const pre = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
      _beforeSnapshot = snapshotJobSlugs(Array.isArray(pre) ? pre.filter(isVfJob) : []);
    } catch {}
  }

  await runBaseCrawler();
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isVfJob,
  });
  // Crawl change summary (new/updated/removed)
  {
    const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
    const jobs = (Array.isArray(raw) ? raw : []).filter(isVfJob);
    const afterSnapshot = snapshotJobSlugs(jobs);
    const crawlDiff = computeCrawlDiff(_beforeSnapshot, afterSnapshot);
    printCrawlChangeSummary(crawlDiff, 'VF');
    writeCrawlChangeSummaryToGH(crawlDiff, 'VF');
  }

  validateVfLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isVfJob) : [];
  writeJobsCrawlerSlice(VF_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: VF_KEY,
    label: 'VF',
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
  console.error(`❌ VF crawler failed: ${err?.message || err}`);
  process.exit(1);
});
