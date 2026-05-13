#!/usr/bin/env node
/**
 * backfill-renamed-slugs-from-history.mjs
 *
 * One-shot recovery for jobs whose source URL was rewritten by the vendor.
 *
 * The crawler diff logic keyed jobs by full URL. When PwC (and similar
 * Workday-style boards) rewrites the slug-portion of the URL while keeping
 * the underlying UUID, the old job is silently dropped and the new job is
 * added — losing the SEO bridge between old and new slugs. ~2.5k slugs in
 * the last 7 days fell off this way.
 *
 * This script scans the last N days of git history for removed jobs in
 * `data/jobs/by-crawler/*.json`, extracts each removed job's UUID + slug,
 * and if a current job in the same file shares that UUID with a different
 * slug, the old slug is added to `previousSlugs` on the current job. The
 * next build emits a bridge page (canonical → new URL) instead of an
 * expired soft-landing at the old URL.
 *
 * The matchKey fix in `update-pwc-jobs.mjs` and
 * `dedicated-crawler-common.mjs:mergePreserveLocaleData` prevents new
 * occurrences. This script repairs the historical damage.
 *
 * Usage:
 *   node scripts/backfill-renamed-slugs-from-history.mjs [--dry-run] [--days N] [--max N]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractStableJobId } from './lib/job-match-key.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BY_CRAWLER_DIR = path.resolve(ROOT, 'data', 'jobs', 'by-crawler');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const daysIdx = args.indexOf('--days');
const DAYS = daysIdx !== -1 ? parseInt(args[daysIdx + 1], 10) || 7 : 7;
const maxIdx = args.indexOf('--max');
const MAX_PER_JOB = maxIdx !== -1 ? parseInt(args[maxIdx + 1], 10) || 20 : 20;

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, v) {
  fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, 'utf8');
}

/**
 * Walk diff lines for one per-crawler slice between the given ref and HEAD.
 * Yields { slug, url } for every job removed in that range.
 */
function extractRemovedJobs(file, sinceRef) {
  const rel = path.relative(ROOT, file);
  let diff = '';
  try {
    diff = execSync(`git log ${sinceRef}..HEAD -p --no-color -- ${rel}`, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 500 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const removed = [];
  let pendingSlug = null;
  let pendingUrl = null;
  // We walk line-by-line. A removed job block is a contiguous run of
  // `-` lines containing `"slug": "..."` and `"url": "..."`. They may
  // appear in either order — capture both, emit when we have both.
  for (const line of diff.split('\n')) {
    if (!line.startsWith('-')) {
      // Reset on non-removal lines to avoid pairing across jobs.
      if (line.startsWith('+')) continue;
      if (pendingSlug && pendingUrl) {
        removed.push({ slug: pendingSlug, url: pendingUrl });
      }
      pendingSlug = null;
      pendingUrl = null;
      continue;
    }
    const m1 = line.match(/"slug":\s*"([^"]+)"/);
    if (m1) pendingSlug = m1[1];
    const m2 = line.match(/"url":\s*"([^"]+)"/);
    if (m2) pendingUrl = m2[1];
    if (pendingSlug && pendingUrl) {
      removed.push({ slug: pendingSlug, url: pendingUrl });
      pendingSlug = null;
      pendingUrl = null;
    }
  }
  return removed;
}

function indexCurrentJobsByStableId(file) {
  const data = readJson(file);
  const jobs = Array.isArray(data) ? data : (data.jobs || []);
  const byKey = new Map();
  for (const j of jobs) {
    const k = extractStableJobId(j.url);
    if (k && !byKey.has(k)) byKey.set(k, j);
  }
  return { data, jobs, byKey };
}

function main() {
  console.log(`🔧 backfill-renamed-slugs-from-history — ${DRY_RUN ? 'DRY RUN' : 'LIVE'} (last ${DAYS}d, cap ${MAX_PER_JOB} previousSlugs/job)`);

  const sinceRef = execSync(
    `git rev-list -1 --before="${DAYS} days ago" HEAD`,
    { cwd: ROOT, encoding: 'utf8' },
  ).trim();
  if (!sinceRef) {
    console.error(`❌ No commit ${DAYS} days ago — aborting.`);
    process.exit(1);
  }
  console.log(`📌 Scanning commits ${sinceRef.slice(0, 10)}..HEAD`);

  const files = fs.readdirSync(BY_CRAWLER_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(BY_CRAWLER_DIR, f))
    .sort();

  let totalDropped = 0;
  let totalMatched = 0;
  let totalAdded = 0;
  let totalSkipped = 0;
  const slicesChanged = [];

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const removed = extractRemovedJobs(file, sinceRef);
    if (removed.length === 0) continue;
    totalDropped += removed.length;

    const { data, jobs, byKey } = indexCurrentJobsByStableId(file);
    let sliceAdded = 0;

    for (const { slug, url } of removed) {
      const key = extractStableJobId(url);
      if (!key) continue;
      const current = byKey.get(key);
      if (!current) continue; // job genuinely gone — leave for soft-landing
      totalMatched++;

      // Don't re-add slugs that are already known (current slug, current
      // locale slug, or already in previousSlugs).
      const isKnown = current.slug === slug
        || Object.values(current.slugByLocale || {}).includes(slug)
        || (Array.isArray(current.previousSlugs) && current.previousSlugs.includes(slug));
      if (isKnown) {
        totalSkipped++;
        continue;
      }

      if (!Array.isArray(current.previousSlugs)) current.previousSlugs = [];
      if (current.previousSlugs.length >= MAX_PER_JOB) {
        totalSkipped++;
        continue;
      }
      current.previousSlugs.push(slug);
      totalAdded++;
      sliceAdded++;
    }

    if (sliceAdded > 0) {
      slicesChanged.push({ file: rel, added: sliceAdded });
      if (!DRY_RUN) writeJson(file, data);
    }
  }

  console.log('');
  console.log(`📊 Removed jobs scanned:       ${totalDropped}`);
  console.log(`   Matched to current UUID:    ${totalMatched}`);
  console.log(`   Added to previousSlugs:     ${totalAdded}`);
  console.log(`   Skipped (already known/cap):${totalSkipped}`);
  console.log(`   Slices changed:             ${slicesChanged.length}`);
  for (const s of slicesChanged.slice(0, 15)) {
    console.log(`     - ${s.file}: +${s.added}`);
  }
  if (slicesChanged.length > 15) {
    console.log(`     ... ${slicesChanged.length - 15} more`);
  }
  if (DRY_RUN) console.log('\n(no files written — re-run without --dry-run to persist)');
}

main();
