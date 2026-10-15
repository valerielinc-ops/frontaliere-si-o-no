#!/usr/bin/env node
/**
 * One-time re-key migration for jobs collapsed by the legacy `mergeUrlKey`
 * leftmost-token bug (see scripts/lib/job-url-key.mjs).
 *
 * The legacy merge key latched onto a token SHARED across a whole crawler (an
 * apply.refline.ch company id, a Weebly/Drupal upload-folder id, a `%20`+year
 * artifact, or cseb's shared first UUID). Every sibling posting therefore got
 * the SAME merge key, and `mergePreserveLocaleData` merged them all onto ONE
 * stable `id` while overwriting each job's en/de/fr `titleByLocale` /
 * `descriptionByLocale` / `slugByLocale` with the single surviving "winner".
 * Result: N distinct postings shared 1 `id` → 1 job-detail file + 1 slug-map
 * entry, so N-1 of them resolved to a mismatching detail and rendered the SPA
 * "annuncio non più disponibile" orphan view (and the en/de/fr slugs collided).
 *
 * The function fix re-keys siblings distinctly GOING FORWARD, but the existing
 * committed crawler output still carries the shared `id` (merge preserves
 * `old.id`), so the collapse never self-heals. This migration repairs the
 * persisted data:
 *
 *   1. Group each crawler file's jobs by their current stored `id`.
 *   2. A group with >1 job whose URLs now yield >1 distinct `mergeUrlKey` is a
 *      collapsed group. Re-assign each job a distinct, deterministic id derived
 *      from its (fixed) merge key: `${companyKey}-${sha1(mergeUrlKey)[:12]}`.
 *   3. De-contaminate locale maps: the source-locale slot is correct per job
 *      (fresh data wins for the source locale on every crawl); the non-source
 *      slots are the winner's. Keep ONLY the source-locale entry in
 *      titleByLocale / descriptionByLocale / slugByLocale and clear the
 *      cross-contaminated previousSlugs(*). The next crawl re-translates the
 *      non-source locales correctly per job.
 *
 * Idempotent: after the first run no id-group spans multiple merge keys, so a
 * re-run is a no-op. Dry-run by default; pass --apply to write.
 *
 * Usage:
 *   node scripts/migrate-collapsed-job-ids.mjs            # dry-run report
 *   node scripts/migrate-collapsed-job-ids.mjs --apply    # write changes
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mergeUrlKey } from './lib/job-url-key.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { withGuardOff } from './lib/slug-preservation-guard.mjs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';

const APPLY = process.argv.includes('--apply');
const ROOT = process.cwd();
const DIRS = [
  path.join(ROOT, 'data/jobs/by-crawler'),
  path.join(ROOT, 'data/jobs/expired/by-crawler'),
];
const LOCALE_MAPS = ['titleByLocale', 'descriptionByLocale', 'slugByLocale'];

function shortId(companyKey, mergeKey) {
  const hash = createHash('sha1').update(mergeKey).digest('hex').slice(0, 12);
  return `${companyKey || 'unknown'}-${hash}`;
}

/** Keep only the source-locale entry in each contaminated locale map. */
function decontaminate(job) {
  const src = job.sourceLang || 'it';
  for (const mapName of LOCALE_MAPS) {
    const map = job[mapName];
    if (map && typeof map === 'object') {
      const kept = {};
      if (map[src] != null) kept[src] = map[src];
      job[mapName] = kept;
    }
  }
  // The merged previousSlugs/previousSlugsByLocale carry every sibling's slug —
  // pure cross-contamination. Clear them; the immutable slug-registry still
  // preserves genuine rename history, and the next crawl re-captures real renames.
  if (Array.isArray(job.previousSlugs)) job.previousSlugs = [];
  if (job.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object') {
    job.previousSlugsByLocale = {};
  }
}

function processFile(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const isWrapped = !Array.isArray(parsed) && Array.isArray(parsed?.jobs);
  const jobs = Array.isArray(parsed) ? parsed : (isWrapped ? parsed.jobs : null);
  if (!jobs) return null;

  // Group by current stored id.
  const byId = new Map();
  for (const job of jobs) {
    if (!job || !job.id) continue;
    if (!byId.has(job.id)) byId.set(job.id, []);
    byId.get(job.id).push(job);
  }

  let splitGroups = 0;
  let reIded = 0;
  let decon = 0;
  for (const [, group] of byId) {
    if (group.length < 2) continue;
    const keys = new Set(group.map((j) => mergeUrlKey(j.url)).filter(Boolean));
    if (keys.size < 2) continue; // genuine duplicates — leave merged
    splitGroups++;
    for (const job of group) {
      const mk = mergeUrlKey(job.url);
      if (!mk) continue;
      const newId = shortId(job.companyKey, mk);
      if (newId !== job.id) { job.id = newId; reIded++; }
      decontaminate(job);
      decon++;
    }
  }

  if (splitGroups === 0) return { file, splitGroups, reIded, decon, changed: false };

  if (APPLY) {
    // This migration intentionally clears cross-contaminated previousSlugs(*)
    // on split-off siblings — writeJsonAtomic's slug-preservation guard
    // (#5157) otherwise re-injects that exact contamination right back
    // (documented escape hatch in scripts/lib/slug-preservation-guard.mjs).
    // Scoped to this write only.
    withGuardOff(() => writeJsonAtomic(file, parsed));
  }
  return { file, splitGroups, reIded, decon, changed: true };
}

let totalSplit = 0, totalReId = 0, totalDecon = 0, filesChanged = 0;
for (const dir of DIRS) {
  for (const name of listSliceFileNames(dir)) {
    const res = processFile(path.join(dir, name));
    if (res && res.changed) {
      filesChanged++;
      totalSplit += res.splitGroups;
      totalReId += res.reIded;
      totalDecon += res.decon;
      const rel = path.relative(ROOT, res.file);
      console.log(`${rel}: ${res.splitGroups} collapsed group(s) split → ${res.reIded} re-ided, ${res.decon} de-contaminated`);
    }
  }
}
console.log(`\n${APPLY ? 'APPLIED' : 'DRY-RUN'}: ${filesChanged} file(s), ${totalSplit} group(s), ${totalReId} id(s) reassigned, ${totalDecon} job(s) de-contaminated.`);
if (!APPLY && filesChanged > 0) console.log('Re-run with --apply to write.');
