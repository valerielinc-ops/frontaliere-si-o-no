#!/usr/bin/env node
/**
 * One-shot backfill: recover indexed-URL coverage for jobs that were dropped
 * by dedicated crawlers BEFORE the archival fix landed (PR #703).
 *
 * For each `data/jobs/by-crawler/<key>.json`, walk every commit that touched
 * the file. Any job (by `id`) that appeared in history but is no longer in
 * the current slice is "lost" — re-archive it into
 * `data/jobs/expired/by-crawler/<key>.json` using the most-recent historical
 * version of the job. Existing expired entries are preserved (merge by slug);
 * the on-disk shape matches what `runStandardCrawlerPipeline` would write
 * going forward, so the build plugin renders the same JobExpiredView.
 *
 * Run once, commit the resulting data diff. Subsequent crawl runs handle
 * fresh drops automatically.
 *
 * Usage:
 *   node scripts/backfill-expired-from-history.mjs           # all crawlers
 *   node scripts/backfill-expired-from-history.mjs upd       # one crawler
 *   node scripts/backfill-expired-from-history.mjs upd galenica  # several
 *
 * Env:
 *   DRY_RUN=1   — log what would change, don't write
 *   MAX_COMMITS=N — cap history depth per file (default: unbounded)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import { compareExpiredAt } from './lib/compare-expired-at.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const BY_CRAWLER_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const EXPIRED_DIR = path.join(ROOT, 'data', 'jobs', 'expired', 'by-crawler');

const DRY_RUN = process.env.DRY_RUN === '1';
const MAX_COMMITS = process.env.MAX_COMMITS ? Number(process.env.MAX_COMMITS) : 0;

const argv = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const onlyKeys = new Set(argv);

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
}

function readJobsFromSlice(blob) {
  let parsed;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.jobs)) return parsed.jobs;
  return [];
}

function buildExpiredEntry(job) {
  const entry = {
    slug: job.slug,
    title: job.title || '',
    titleByLocale: job.titleByLocale || {},
    company: job.company || '',
    companyKey: job.companyKey || '',
    location: job.location || '',
    addressLocality: job.addressLocality || '',
    descriptionByLocale: job.descriptionByLocale || {},
    slugByLocale: job.slugByLocale || {},
    sector: job.sector || '',
    expiredAt: pickExpiredAt(job),
    previousSlugs:
      Array.isArray(job.previousSlugs) && job.previousSlugs.length > 0
        ? [...job.previousSlugs]
        : undefined,
    previousSlugsByLocale:
      job.previousSlugsByLocale &&
      typeof job.previousSlugsByLocale === 'object' &&
      Object.keys(job.previousSlugsByLocale).length > 0
        ? JSON.parse(JSON.stringify(job.previousSlugsByLocale))
        : undefined,
    postalCode: job.postalCode || '',
    streetAddress: job.streetAddress || '',
    salaryMin: job.salaryMin || null,
    salaryMax: job.salaryMax || null,
    salaryCurrency: job.salaryCurrency || job.currency || 'CHF',
    salaryPeriod: job.salaryPeriod || 'YEAR',
  };
  if (!entry.postalCode) delete entry.postalCode;
  if (!entry.streetAddress) delete entry.streetAddress;
  if (!entry.salaryMin) delete entry.salaryMin;
  if (!entry.salaryMax) delete entry.salaryMax;
  return entry;
}

/**
 * Pick an expiredAt timestamp from job metadata. Prefer the most recent
 * timestamp we have (crawledAt is when we last saw it alive — close enough
 * to "expired right after" without lying about the actual upstream removal
 * time, which we don't have for historical jobs).
 */
function pickExpiredAt(job) {
  const ca = job.crawledAt && !Number.isNaN(new Date(job.crawledAt).getTime()) ? job.crawledAt : null;
  const dp = job.datePosted && !Number.isNaN(new Date(job.datePosted).getTime()) ? job.datePosted : null;
  return ca || dp || new Date().toISOString();
}

// Non escludeva nulla oltre l'estensione: stesso difetto di
// repair-job-locales.mjs. Il filtro `onlyKeys` resta suo, il predicato no.
function listSliceFiles() {
  return listSliceFileNames(BY_CRAWLER_DIR)
    .filter((f) => (onlyKeys.size === 0 ? true : onlyKeys.has(path.basename(f, '.json'))));
}

function processSlice(sliceFile) {
  const crawlerKey = path.basename(sliceFile, '.json');
  const currentRel = `data/jobs/by-crawler/${sliceFile}`;
  const currentPath = path.join(BY_CRAWLER_DIR, sliceFile);
  if (!fs.existsSync(currentPath)) return null;

  const currentJobs = readJobsFromSlice(fs.readFileSync(currentPath, 'utf-8'));
  const currentIds = new Set(currentJobs.map((j) => j.id).filter(Boolean));
  const currentSlugs = new Set(currentJobs.map((j) => j.slug).filter(Boolean));

  // Walk commits that touched this file. --follow handles renames; the
  // tradeoff is git ignores merge commits' textual diff, which is fine —
  // squash-merged commits still show, and we cover them via the per-commit
  // blob read below.
  let log = '';
  try {
    // --all is required here: the 2026-05-27 history rewrite (PR #645)
    // stranded the pre-rewrite branch tips. Those reachable-only-via-reflog
    // commits hold the very job data we're trying to recover — without
    // --all the walk only sees the ~5 post-rewrite commits.
    log = git(['log', '--all', '--follow', '--format=%H', '--', currentRel]);
  } catch (err) {
    console.error(`⚠️  git log failed for ${currentRel}: ${err.message}`);
    return null;
  }
  const commits = log.trim().split('\n').filter(Boolean);
  if (commits.length === 0) return null;
  const sliceCommits = MAX_COMMITS > 0 ? commits.slice(0, MAX_COMMITS) : commits;

  // Walk commits NEWEST → OLDEST (git log default order). First time we see
  // a lost id wins — that's the most recent version of the job.
  const lostById = new Map();
  for (const sha of sliceCommits) {
    let blob;
    try {
      blob = git(['show', `${sha}:${currentRel}`]);
    } catch {
      // File didn't exist at that commit (rename predecessor) — skip
      continue;
    }
    const jobs = readJobsFromSlice(blob);
    for (const job of jobs) {
      if (!job?.id || !job?.slug) continue;
      if (currentIds.has(job.id)) continue;
      if (currentSlugs.has(job.slug)) continue; // same slug, different id — treat as kept
      if (lostById.has(job.id)) continue;
      lostById.set(job.id, job);
    }
  }

  if (lostById.size === 0) return { crawlerKey, scannedCommits: sliceCommits.length, lost: 0, added: 0 };

  // Read any existing expired slice, merge by slug. We keep entries whose
  // expiredAt is newer (the existing slice may already have entries from
  // PR #703 or earlier cleanup-jobs runs that we shouldn't downgrade).
  const expiredPath = path.join(EXPIRED_DIR, sliceFile);
  let existing = [];
  if (fs.existsSync(expiredPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(expiredPath, 'utf-8'));
      if (Array.isArray(parsed)) existing = parsed;
    } catch { /* malformed → start fresh */ }
  }

  const bySlug = new Map();
  for (const ej of existing) {
    if (ej?.slug) bySlug.set(ej.slug, ej);
  }

  let added = 0;
  for (const job of lostById.values()) {
    const entry = buildExpiredEntry(job);
    const prev = bySlug.get(entry.slug);
    if (!prev) {
      bySlug.set(entry.slug, entry);
      added++;
    } else if (compareExpiredAt(prev.expiredAt, entry.expiredAt) < 0) {
      // Existing entry is older — refresh with newer historical data (rare
      // edge case: the same slug came/went multiple times).
      bySlug.set(entry.slug, entry);
    }
  }

  if (added === 0) return { crawlerKey, scannedCommits: sliceCommits.length, lost: lostById.size, added: 0 };

  const archived = [...bySlug.values()].sort((a, b) =>
    compareExpiredAt(b.expiredAt, a.expiredAt),
  );
  if (!DRY_RUN) {
    fs.mkdirSync(EXPIRED_DIR, { recursive: true });
    writeJsonAtomic(expiredPath, archived);
  }
  return { crawlerKey, scannedCommits: sliceCommits.length, lost: lostById.size, added };
}

function main() {
  if (!fs.existsSync(BY_CRAWLER_DIR)) {
    console.error(`❌ ${BY_CRAWLER_DIR} not found`);
    process.exit(1);
  }
  const files = listSliceFiles();
  if (files.length === 0) {
    console.log('ℹ️  No slice files matched.');
    return;
  }
  console.log(`🧮 Backfilling expired slices from history${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`   crawlers: ${files.length}, history cap: ${MAX_COMMITS || 'unbounded'}`);

  const summary = { crawlers: 0, withDrops: 0, addedTotal: 0, lostTotal: 0, scannedTotal: 0 };
  for (const file of files) {
    const result = processSlice(file);
    if (!result) continue;
    summary.crawlers++;
    summary.scannedTotal += result.scannedCommits;
    if (result.lost > 0) summary.withDrops++;
    summary.lostTotal += result.lost;
    summary.addedTotal += result.added;
    if (result.lost > 0 || process.env.VERBOSE === '1') {
      console.log(
        `  ${result.crawlerKey}: scanned=${result.scannedCommits} lost=${result.lost} added=${result.added}`,
      );
    }
  }
  console.log('');
  console.log(`✅ Done. Crawlers: ${summary.crawlers}, with drops: ${summary.withDrops}`);
  console.log(`   Total lost: ${summary.lostTotal}, newly archived: ${summary.addedTotal}`);
  console.log(`   Total commits scanned: ${summary.scannedTotal}`);
}

main();
