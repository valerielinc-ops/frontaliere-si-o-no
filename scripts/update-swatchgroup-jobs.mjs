#!/usr/bin/env node
/**
 * Dedicated Swatch Group crawler runner.
 * Runs only companies mapped to swatchgroup.com and enforces locale coverage.
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
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang } from './lib/dedicated-crawler-common.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
// Fixed per-script scratch key (not the dynamic companyKeys array — that's
// loaded from adapter files at runtime, after this module-scope const runs).
// Passed explicitly as dataJobsPath below so runDedicatedBaseCrawler agrees
// on the same path regardless of how it would resolve companyKeys.join('_')
// internally (bug class #3775/#3768, confirmed cause #3769/#3770).
const SWATCHGROUP_SCRATCH_KEY = 'swatchgroup';
const DATA_JOBS = crawlerScratchPathFor(SWATCHGROUP_SCRATCH_KEY);
const SWATCH_FALLBACK_KEYS = [
  'comadur-swatch-group',
  'eta-sa-swatch-group',
  'nivarox-swatch-group',
  'swatch-group-assembly',
  'swiss-timing-swatch-group',
  'rado',
];

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

function loadSwatchCompanyKeys() {
  if (!fs.existsSync(ADAPTERS_DIR)) return [];
  const files = fs.readdirSync(ADAPTERS_DIR).filter((f) => f.endsWith('.json'));
  const keys = [];

  for (const file of files) {
    const full = path.join(ADAPTERS_DIR, file);
    try {
      const adapter = JSON.parse(fs.readFileSync(full, 'utf-8'));
      const host = normalize(adapter?.companyHost || '');
      const key = normalizeKey(adapter?.companyKey || file.replace(/\.json$/, ''));
      if (host.includes('swatchgroup.com') && key) keys.push(key);
    } catch {
      // Skip malformed adapter files.
    }
  }
  const merged = [...keys, ...SWATCH_FALLBACK_KEYS].map((k) => normalizeKey(k)).filter(Boolean);
  return [...new Set(merged)];
}

function isSwatchJob(job, swatchKeysSet) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  return swatchKeysSet.has(key) || host.includes('swatchgroup.com');
}

function runBaseCrawler(companyKeys) {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys,
    localizeOnlyCompanyKeys: companyKeys,
    forceLocalizeKeys: companyKeys,
    dataJobsPath: DATA_JOBS,
  });
}

function ensureSourceLang(companyKeys) {
  if (!fs.existsSync(DATA_JOBS)) return;
  const swatchKeysSet = new Set(companyKeys.map((k) => normalizeKey(k)));
  const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(jobs)) return;
  let changed = 0;
  for (const job of jobs) {
    if (!isSwatchJob(job, swatchKeysSet)) continue;
    const lang = detectLang(job.description || job.title, 'de');
    if (job.sourceLang !== lang) { job.sourceLang = lang; changed++; }
  }
  if (changed > 0) {
    writeJsonAtomic(DATA_JOBS, jobs);
    console.log(`📝 Set sourceLang on ${changed} Swatch Group job(s).`);
  }
}

function logSwatchJobStats(companyKeys, beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json non trovato — nessuna statistica disponibile.');
    return { total: 0, ticino: 0, discarded: 0, crawlDiff: { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] } };
  }
  const swatchKeysSet = new Set(companyKeys.map((k) => normalizeKey(k)));
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];

  // All Swatch jobs (any location)
  const swatchJobs = allJobs.filter((job) => isSwatchJob(job, swatchKeysSet));
  // Ticino-only jobs (canton === 'TI')
  const ticinoJobs = swatchJobs.filter((job) => normalize(job?.canton) === 'ti');
  const discarded = swatchJobs.length - ticinoJobs.length;

  console.log(`\n📊 === Swatch Group Job Stats ===`);
  console.log(`  🔍 Job totali trovati (Swatch Group): ${swatchJobs.length}`);
  console.log(`  ✅ Job in Ticino (canton=TI): ${ticinoJobs.length}`);
  console.log(`  ❌ Job scartati (location non Ticino): ${discarded}`);
  if (discarded > 0) {
    const discardedLocations = swatchJobs
      .filter((job) => normalize(job?.canton) !== 'ti')
      .map((job) => `${job?.title || '?'} → ${job?.location || job?.canton || '?'}`)
      .slice(0, 10);
    console.log(`  📍 Esempi scartati:`);
    for (const loc of discardedLocations) console.log(`     - ${loc}`);
    if (swatchJobs.length - ticinoJobs.length > 10) {
      console.log(`     ... e altri ${swatchJobs.length - ticinoJobs.length - 10}`);
    }
  }
  console.log('');

  // Crawl change summary (new/updated/removed)
  const afterSnapshot = snapshotJobSlugs(swatchJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Swatch Group');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Swatch Group');

  return { total: swatchJobs.length, ticino: ticinoJobs.length, discarded, crawlDiff };
}

function validateSwatchLocaleCoverage(companyKeys) {
  const swatchKeysSet = new Set(companyKeys.map((k) => normalizeKey(k)));
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_SWATCH_STRICT',
    label: 'Swatch',
    dataJobsPath: DATA_JOBS,
    isTargetJob: (job) => isSwatchJob(job, swatchKeysSet),
    detectSourceLang: (text) => detectLang(text, 'de'),
    deriveSlug: (job, locale) => String(job?.slugByLocale?.[locale] || job?.slug || '').trim(),
    noJobsMessage: 'Nessun job Swatch Group trovato dopo il crawl — niente da validare.',
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard('swatchgroup', 'Swatch Group');
  const companyKeys = loadSwatchCompanyKeys();
  if (companyKeys.length === 0) {
    console.log('ℹ️ Nessun adapter swatchgroup.com trovato. Niente da fare.');
    return;
  }
  console.log(`⌚ Running dedicated Swatch Group crawler for ${companyKeys.length} companies...`);

  // Snapshot company jobs before crawl for diff summary
  let _beforeSnapshot = new Map();
  if (fs.existsSync(DATA_JOBS)) {
    try {
      const swatchKeysSet = new Set(companyKeys.map((k) => normalizeKey(k)));
      const pre = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
      _beforeSnapshot = snapshotJobSlugs(Array.isArray(pre) ? pre.filter((j) => isSwatchJob(j, swatchKeysSet)) : []);
    } catch {}
  }

  await runBaseCrawler(companyKeys);
  ensureSourceLang(companyKeys);

  // Log stats: total jobs found, Ticino vs non-Ticino
  const stats = logSwatchJobStats(companyKeys, _beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ Nessun job Swatch trovato in questa esecuzione. Nessun errore — uscita OK.');
    return;
  }

  validateSwatchLocaleCoverage(companyKeys);

  // Write per-crawler slices for each Swatch sub-company and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  // Swatchgroup is a multi-company crawler — read from assembled data/jobs.json
  // (not a single per-crawler slice) to get all sub-company jobs for slicing.
  const _allJobsRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _allJobs = Array.isArray(_allJobsRaw) ? _allJobsRaw : [];
  let _aggregateTotal = 0;
  for (const ck of companyKeys) {
    const _ckNorm = normalizeKey(ck);
    const _ckJobs = _allJobs.filter((j) => normalizeKey(j?.companyKey || '') === _ckNorm);
    // A brand with 0 jobs THIS run only means this crawl found no fresh
    // listings for it — writeJobsCrawlerSlice(ck, []) would throw via the
    // shrink guard if a non-empty slice already exists on disk, so the slice
    // write stays conditional. But skipping the summary write too (as before)
    // freezes that brand's `generatedAt` at its last non-zero run, which
    // crawler-health.mjs then flags as "stale" days later even though the
    // crawler ran fine every day (#4167 — same class already fixed for the
    // aggregate 'swatchgroup' key below). Always refresh the per-brand
    // summary, reporting the still-persisted slice count when this run found
    // nothing new for that brand.
    const _ckTotal = _ckJobs.length > 0 ? _ckJobs.length : readExistingCrawlerJobs(ck, DATA_JOBS).length;
    if (_ckJobs.length > 0) {
      _aggregateTotal += _ckJobs.length;
      writeJobsCrawlerSlice(ck, _ckJobs);
    }
    writeSummaryCrawlerSlice({
      key: ck,
      label: ck,
      generatedAt: new Date().toISOString(),
      total: _ckTotal,
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
  }
  // registerCrawlerSummaryGuard() above registers its exit-fallback under the
  // 'swatchgroup' key, but the per-brand loop only ever writes the *brand*
  // keys (rado, swatch-group-assembly, ...) — never 'swatchgroup' itself.
  // Those brand writes still flip the module-level _summaryWritten flag in
  // assemble-jobs-dataset.mjs, so the exit guard's own fallback never fires
  // either. Net effect: by-crawler/swatchgroup.json was frozen at whatever
  // it last held (often a stale/empty stub), which health checks and #3797's
  // audit misread as "silently empty" despite the brand files getting fresh
  // jobs every run. Write the aggregate under 'swatchgroup' explicitly so
  // the audit sees real, current data for this key too.
  writeSummaryCrawlerSlice({
    key: 'swatchgroup',
    label: 'Swatch Group',
    generatedAt: new Date().toISOString(),
    total: _aggregateTotal,
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

main().catch((err) => exitCrawlerOnError(err, 'Swatch Group'));
