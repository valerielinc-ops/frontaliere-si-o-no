#!/usr/bin/env node
/**
 * scripts/assemble-jobs-dataset.mjs
 *
 * Assembles the global jobs artifacts from per-crawler slice files.
 *
 * Source directories (written by each migrated crawler):
 *   data/jobs/by-crawler/<key>.json
 *     → { crawlerKey, assembledAt, jobs: [...] }
 *   data/jobs-crawler-summaries/by-crawler/<key>.json
 *     → summary entry ({ key, label, generatedAt, total, ... })
 *
 * Assembled outputs (consumed by runtime/build — unchanged interface):
 *   data/jobs.json
 *   public/data/jobs.json
 *   data/jobs-crawler-summaries.json
 *
 * Merge rules:
 *   1. Stable identity: url → id/externalId → slug → title+company+location fallback.
 *   2. When the same identity appears in multiple slices, the slice with the
 *      newest `assembledAt` timestamp wins (last-write wins).
 *   3. Final sort: descending postedDate, then ascending stable identity for ties.
 *
 * Usage:
 *   node scripts/assemble-jobs-dataset.mjs              # assemble only
 *   node scripts/assemble-jobs-dataset.mjs --stats      # assemble + regenerate stats
 *
 * Module API (for crawlers):
 *   writeJobsCrawlerSlice(crawlerKey, jobs)    → write data/jobs/by-crawler/<key>.json
 *   writeSummaryCrawlerSlice(summaryEntry)     → write data/jobs-crawler-summaries/by-crawler/<key>.json
 *   assembleJobsDataset({ withStats? })        → run full assembly
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEmptyCrawlerSummaryStore,
  readCrawlerSummaryStore,
  writeCrawlerSummaryStore,
} from './lib/crawler-summary-store.mjs';
import { buildStableJobIdentity } from './lib/job-identity.mjs';
import { hardenJobsWithStructuredSalary } from './lib/structured-salary.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ── Assembler-specific identity ──────────────────────────────────────── */

/**
 * Build a deduplication key for the assembler.
 *
 * Unlike buildStableJobIdentity (which normalises URLs by stripping the hash),
 * we preserve the full raw URL including hash fragments. This is essential for
 * crawlers like Galenica that use hash-fragment URLs to distinguish individual
 * job positions (e.g. /it/jobs/#job.id=12345).
 *
 * Fallback chain: raw URL → slug → title+company+location
 */
function assemblerIdentity(job = {}) {
  const rawUrl = String(job.url || '').trim().toLowerCase().replace(/\/+$/, '');
  if (rawUrl) return `url:${rawUrl}`;

  // Delegate to the shared identity for non-URL fallbacks
  return buildStableJobIdentity(job);
}
const ROOT = path.resolve(__dirname, '..');

const JOBS_SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const EXPIRED_SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'expired', 'by-crawler');
const SUMMARIES_SLICES_DIR = path.join(ROOT, 'data', 'jobs-crawler-summaries', 'by-crawler');

const DATA_JOBS = path.join(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.join(ROOT, 'public', 'data', 'jobs.json');
const DATA_EXPIRED = path.join(ROOT, 'data', 'expired-jobs.json');
const DATA_META = path.join(ROOT, 'data', 'jobs-meta.json');
const DATA_SUMMARIES = path.join(ROOT, 'data', 'jobs-crawler-summaries.json');

/** Maximum number of expired jobs to keep across all crawlers. */
const EXPIRED_JOBS_CAP = 5000;

/* ── I/O helpers ──────────────────────────────────────────────────────── */

function readJson(filePath, fallback) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function listSliceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== '.gitkeep')
    .map((f) => path.join(dir, f))
    .sort(); // lexicographic — deterministic order
}

/* ── Per-crawler slice writers (used by migrated crawlers) ────────────── */

/**
 * Write a per-crawler jobs slice.
 *
 * Migrated crawlers call this instead of writing directly to data/jobs.json.
 * The assembler reads these slices and merges them into the global file.
 *
 * @param {string} crawlerKey   - Normalised company key (e.g. 'coop', 'galenica')
 * @param {object[]} jobs       - Array of job objects discovered in this run
 */
export function writeJobsCrawlerSlice(crawlerKey, jobs) {
  if (!crawlerKey || typeof crawlerKey !== 'string') {
    throw new TypeError('writeJobsCrawlerSlice: crawlerKey must be a non-empty string');
  }
  if (!Array.isArray(jobs)) {
    throw new TypeError('writeJobsCrawlerSlice: jobs must be an array');
  }

  const hardened = hardenJobsWithStructuredSalary(jobs);
  fs.mkdirSync(JOBS_SLICES_DIR, { recursive: true });
  const slicePath = path.join(JOBS_SLICES_DIR, `${crawlerKey}.json`);
  const payload = {
    crawlerKey,
    assembledAt: new Date().toISOString(),
    jobs: hardened.jobs,
  };
  writeJson(slicePath, payload);
  const hardeningSuffix = hardened.updated > 0 ? `, salary hardened ${hardened.updated}` : '';
  console.log(`📂 Wrote jobs slice: data/jobs/by-crawler/${crawlerKey}.json (${hardened.total} jobs${hardeningSuffix})`);
}

/**
 * Write a per-crawler summary slice.
 *
 * Migrated crawlers call this so each run's summary is isolated and
 * can be assembled without clobbering concurrent writes.
 *
 * @param {object} summaryEntry - Summary entry object (key, label, generatedAt, ...)
 */
export function writeSummaryCrawlerSlice(summaryEntry) {
  if (!summaryEntry?.key || typeof summaryEntry.key !== 'string') {
    throw new TypeError('writeSummaryCrawlerSlice: summaryEntry.key must be a non-empty string');
  }

  fs.mkdirSync(SUMMARIES_SLICES_DIR, { recursive: true });
  const slicePath = path.join(SUMMARIES_SLICES_DIR, `${summaryEntry.key}.json`);
  writeJson(slicePath, summaryEntry);
  console.log(`📂 Wrote summary slice: data/jobs-crawler-summaries/by-crawler/${summaryEntry.key}.json`);
}

/* ── Assembly logic ───────────────────────────────────────────────────── */

/**
 * Assemble per-crawler job slices into data/jobs.json.
 *
 * **Hybrid mode (transition period):**
 * While only some crawlers are migrated to per-crawler slices, the assembler
 * operates in hybrid mode:
 *   1. Start with the existing monolithic data/jobs.json as the baseline.
 *   2. Remove all jobs that belong to migrated crawlers (those with slices).
 *   3. Add all jobs from the per-crawler slices.
 *
 * This preserves all non-migrated crawler jobs in the global file while
 * replacing migrated crawlers' sections with slice-derived content.
 *
 * **Full mode (after all crawlers are migrated):**
 * When every crawler writes a slice, the baseline is effectively empty
 * and the global file is fully assembled from slices only.
 *
 * Returns the assembled jobs array, or null if no slices exist.
 */
function assembleJobs() {
  const sliceFiles = listSliceFiles(JOBS_SLICES_DIR);

  if (sliceFiles.length === 0) {
    console.log('ℹ️  No per-crawler job slices found — data/jobs.json left unchanged.');
    return null;
  }

  // Load all slices
  const slices = [];
  for (const slicePath of sliceFiles) {
    const slice = readJson(slicePath, null);
    if (!slice || !Array.isArray(slice.jobs)) {
      console.warn(`⚠️  Skipping malformed slice: ${path.basename(slicePath)}`);
      continue;
    }
    slices.push(slice);
    console.log(`  📄 ${path.basename(slicePath)}: ${slice.jobs.length} jobs (assembledAt: ${slice.assembledAt || '?'})`);
  }

  if (slices.length === 0) return null;

  // Collect the set of crawlerKeys that have been migrated
  const migratedKeys = new Set(slices.map((s) => s.crawlerKey).filter(Boolean));

  // Baseline: existing monolithic jobs.json, minus jobs from migrated crawlers
  const existing = readJson(DATA_JOBS, []);
  const baseline = Array.isArray(existing)
    ? existing.filter((job) => {
        const key = String(job.companyKey || '').toLowerCase();
        return !migratedKeys.has(key);
      })
    : [];

  if (migratedKeys.size < (existing.length > 0 ? 1 : 0)) {
    console.log(`  🔄 Hybrid mode: keeping ${baseline.length} jobs from non-migrated crawlers`);
  }

  // Collect all slice jobs, tag with assembledAt for dedup
  const allTagged = [];
  for (const slice of slices) {
    for (const job of slice.jobs) {
      allTagged.push({ job, assembledAt: slice.assembledAt || '' });
    }
  }

  // Deduplicate slice jobs: last-write wins (newest assembledAt per identity)
  const byIdentity = new Map();
  for (const tagged of allTagged) {
    const identity = assemblerIdentity(tagged.job);
    if (!identity) continue;
    const existing = byIdentity.get(identity);
    if (!existing || tagged.assembledAt >= existing.assembledAt) {
      byIdentity.set(identity, tagged);
    }
  }

  const sliceJobs = [...byIdentity.values()].map((t) => t.job);

  // Merge baseline + slice jobs
  // Deduplicate across them: slice jobs take precedence over baseline
  const sliceIdentities = new Set(sliceJobs.map(assemblerIdentity));
  const baselineFiltered = baseline.filter((job) => !sliceIdentities.has(assemblerIdentity(job)));
  const merged = [...baselineFiltered, ...sliceJobs];

  // Stable sort: newest postedDate first, then stable by identity string
  const sorted = merged.sort((a, b) => {
    const dateA = String(a.postedDate || '').slice(0, 10);
    const dateB = String(b.postedDate || '').slice(0, 10);
    if (dateB > dateA) return 1;
    if (dateA > dateB) return -1;
    // Tiebreak: stable by assembler identity
    const idA = assemblerIdentity(a) || '';
    const idB = assemblerIdentity(b) || '';
    return idA.localeCompare(idB);
  });

  // ── Final slug dedup pass ────────────────────────────────────────────
  // The URL-based identity dedup above handles most duplicates, but
  // different URLs (or baseline entries from pre-migration data) can map
  // to the same slug. Since slugs are used as the unique page identifier
  // by the build system, we must guarantee no duplicate slugs.
  // Keep the first occurrence (newest postedDate thanks to sort above).
  const seenSlugs = new Set();
  let slugDupeCount = 0;
  const deduped = sorted.filter((job) => {
    const slug = String(job.slug || '').trim();
    if (!slug) return true; // keep slugless jobs (shouldn't happen, but safe)
    if (seenSlugs.has(slug)) {
      slugDupeCount++;
      return false;
    }
    seenSlugs.add(slug);
    return true;
  });

  if (slugDupeCount > 0) {
    console.log(`  🧹 Slug dedup: removed ${slugDupeCount} entries with duplicate slugs (${deduped.length} remaining)`);
  }

  return hardenJobsWithStructuredSalary(deduped).jobs;
}

/**
 * Assemble all per-crawler summary slices into data/jobs-crawler-summaries.json.
 * Returns the assembled store or null if no slices exist.
 */
function assembleSummaries() {
  const sliceFiles = listSliceFiles(SUMMARIES_SLICES_DIR);

  if (sliceFiles.length === 0) {
    console.log('ℹ️  No per-crawler summary slices found — data/jobs-crawler-summaries.json left unchanged.');
    return null;
  }

  // Collect all slice entries
  const sliceEntries = [];
  for (const slicePath of sliceFiles) {
    const entry = readJson(slicePath, null);
    if (!entry || typeof entry.key !== 'string') {
      console.warn(`⚠️  Skipping malformed summary slice: ${path.basename(slicePath)}`);
      continue;
    }
    sliceEntries.push(entry);
  }

  // Merge with existing global summaries: slice entries take precedence over
  // entries from the monolithic store (the slice is the source of truth).
  const existingStore = readCrawlerSummaryStore(DATA_SUMMARIES, { allowMissing: true });
  const sliceKeys = new Set(sliceEntries.map((e) => e.key));

  // Keep existing entries that have NOT been migrated to per-crawler slices
  const legacyEntries = existingStore.summaries.filter((s) => !sliceKeys.has(s.key));

  // Most-recently-generated entries first
  const sortedSliceEntries = [...sliceEntries].sort((a, b) => {
    const tA = a.generatedAt || '';
    const tB = b.generatedAt || '';
    return tB.localeCompare(tA);
  });

  const payload = {
    updatedAt: new Date().toISOString(),
    summaries: [...sortedSliceEntries, ...legacyEntries].slice(0, 120),
  };

  return payload;
}

/* ── Expired jobs assembly ─────────────────────────────────────────────── */

/**
 * Assemble all per-crawler expired job slices into data/expired-jobs.json.
 * Each slice is an array of expired job entries with slugs as unique keys.
 * Returns the assembled array, or null if no slices exist.
 */
function assembleExpiredJobs() {
  const sliceFiles = listSliceFiles(EXPIRED_SLICES_DIR);

  if (sliceFiles.length === 0) {
    console.log('ℹ️  No per-crawler expired job slices found — data/expired-jobs.json left unchanged.');
    return null;
  }

  const bySlug = new Map();
  let totalSliceEntries = 0;

  for (const slicePath of sliceFiles) {
    const entries = readJson(slicePath, null);
    if (!Array.isArray(entries)) {
      console.warn(`⚠️  Skipping malformed expired slice: ${path.basename(slicePath)}`);
      continue;
    }
    totalSliceEntries += entries.length;
    for (const entry of entries) {
      if (!entry.slug) continue;
      const existing = bySlug.get(entry.slug);
      // Keep the most recently expired entry for each slug
      if (!existing || (entry.expiredAt || '') >= (existing.expiredAt || '')) {
        bySlug.set(entry.slug, entry);
      }
    }
  }

  // Also merge any existing aggregated expired-jobs.json (from deploy-time cleanup)
  const existingAgg = readJson(DATA_EXPIRED, []);
  if (Array.isArray(existingAgg)) {
    for (const entry of existingAgg) {
      if (!entry.slug) continue;
      const existing = bySlug.get(entry.slug);
      if (!existing || (entry.expiredAt || '') >= (existing.expiredAt || '')) {
        bySlug.set(entry.slug, entry);
      }
    }
  }

  // Sort by expiredAt descending, cap at EXPIRED_JOBS_CAP
  let assembled = [...bySlug.values()]
    .sort((a, b) => (b.expiredAt || '').localeCompare(a.expiredAt || ''));
  if (assembled.length > EXPIRED_JOBS_CAP) {
    assembled = assembled.slice(0, EXPIRED_JOBS_CAP);
  }

  console.log(`  📄 ${sliceFiles.length} expired slices: ${totalSliceEntries} entries → ${assembled.length} unique slugs`);
  return assembled;
}

/* ── Meta generation ──────────────────────────────────────────────────── */

/**
 * Generate data/jobs-meta.json from the assembled jobs array.
 */
function generateMeta(jobCount) {
  const existing = readJson(DATA_META, {});
  return {
    ...existing,
    lastUpdated: new Date().toISOString(),
    totalJobs: jobCount,
    sources: {
      ...(existing.sources || {}),
      arbeitSwiss: 0,
      ubs: 0,
      migros: 0,
      tutti: 0,
      remotive: 0,
      findwork: 0,
      adzuna: 0,
      curatedTicino: jobCount,
    },
  };
}

/* ── Main assembly entry point ────────────────────────────────────────── */

/**
 * Run the full assembly pipeline.
 *
 * @param {object} [options]
 * @param {boolean} [options.withStats=false] - Whether to regenerate job board stats after assembly
 */
export async function assembleJobsDataset({ withStats = false } = {}) {
  // In slice-only mode crawlers skip assembly — it runs during deploy instead.
  if (String(process.env.CRAWLER_SLICE_ONLY || '0') === '1') {
    console.log('📦 Slice-only mode: skipping assembly (will run at deploy time)');
    return;
  }
  console.log('🔧 Assembling jobs dataset from per-crawler slices...');

  // --- Jobs ---
  const assembled = assembleJobs();
  if (assembled !== null) {
    writeJson(DATA_JOBS, assembled);
    fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
    writeJson(PUBLIC_JOBS, assembled);
    console.log(`✅ data/jobs.json assembled: ${assembled.length} jobs from ${listSliceFiles(JOBS_SLICES_DIR).length} slices`);

    // --- Meta (derived from assembled jobs) ---
    const meta = generateMeta(assembled.length);
    writeJson(DATA_META, meta);
    console.log(`✅ data/jobs-meta.json generated: ${assembled.length} total jobs`);
  }

  // --- Expired jobs ---
  const expiredJobs = assembleExpiredJobs();
  if (expiredJobs !== null) {
    writeJson(DATA_EXPIRED, expiredJobs);
    console.log(`✅ data/expired-jobs.json assembled: ${expiredJobs.length} expired jobs`);
  }

  // --- Summaries ---
  const summaryStore = assembleSummaries();
  if (summaryStore !== null) {
    writeCrawlerSummaryStore(DATA_SUMMARIES, summaryStore);
    console.log(`✅ data/jobs-crawler-summaries.json assembled: ${summaryStore.summaries.length} crawler entries`);
  }

  // --- Stats (optional) ---
  if (withStats) {
    const { generateJobBoardStats } = await import('./generate-job-board-stats.mjs');
    const result = generateJobBoardStats();
    console.log(`📈 Stats regenerated: ${result.summary.totals.activeJobs} active jobs`);
  }

  console.log('✅ Assembly complete.');
}

/* ── CLI entry point ──────────────────────────────────────────────────── */

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const withStats = process.argv.includes('--stats');
  assembleJobsDataset({ withStats }).catch((err) => {
    console.error('❌ Assembly failed:', err?.message || err);
    process.exit(1);
  });
}
