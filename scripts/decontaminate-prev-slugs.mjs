#!/usr/bin/env node
/**
 * One-time decontamination pass for previousSlugs entries already
 * misattributed to the wrong job (see resolveRecoveryTarget in
 * backfill-prev-slugs-from-loss-events.mjs for the write-side guard that
 * prevents this going forward).
 *
 * Root cause: a loss event recorded during scan-prev-slug-losses.mjs's
 * git-history replay is keyed by a job.id snapshot up to 400 commits old.
 * backfill-prev-slugs-from-loss-events.mjs previously trusted that id was
 * still the same real posting today and wrote the recovered slug straight
 * onto whichever job currently holds it — corrupting an unrelated job's
 * previousSlugs whenever the id had been reused (e.g. a legacy collapsed-id
 * group later split by migrate-collapsed-job-ids.mjs, whose own
 * decontamination pass looked like a "loss" to the scan script and got
 * silently re-recovered onto the wrong job).
 *
 * This script re-validates every EXISTING previousSlugs / previousSlugsByLocale
 * entry against each job's own current stableSlugHash: entries that carry
 * another current job's disambiguator tail are moved to that job. Entries
 * whose tail matches no current job are left untouched — a trailing 6-char
 * segment with no confirmed owner isn't reliable evidence of contamination
 * (real slug words can coincidentally be 6 lowercase letters, e.g.
 * "-campus"), so there is no safe basis for dropping them.
 *
 * Usage:
 *   node scripts/decontaminate-prev-slugs.mjs            # dry-run report
 *   node scripts/decontaminate-prev-slugs.mjs --apply    # write changes
 */
import fs from 'node:fs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableSlugHash } from './lib/dedicated-crawler-common.mjs';
import { pruneEmptyPreviousSlugLocaleBuckets } from './lib/dedicated-crawler-common.mjs';
import { resolveRecoveryTarget } from './backfill-prev-slugs-from-loss-events.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { withGuardOff } from './lib/slug-preservation-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BY_CRAWLER_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const APPLY = process.argv.includes('--apply');

export function processFile(filePath) {
  const slice = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(slice.jobs)) return null;

  const bySuffixHash = new Map();
  for (const j of slice.jobs) {
    const h = stableSlugHash(j);
    if (h && !bySuffixHash.has(h)) bySuffixHash.set(h, j);
  }

  let moved = 0;
  const additions = new Map(); // targetJob -> { locales: Map<locale, Set(slug)>, flat: Set(slug) }

  const getEntry = (targetJob) => {
    if (!additions.has(targetJob)) additions.set(targetJob, { locales: new Map(), flat: new Set() });
    return additions.get(targetJob);
  };

  const addToTarget = (targetJob, locale, slug) => {
    const entry = getEntry(targetJob);
    if (!entry.locales.has(locale)) entry.locales.set(locale, new Set());
    entry.locales.get(locale).add(slug);
  };

  const addFlatToTarget = (targetJob, slug) => {
    getEntry(targetJob).flat.add(slug);
  };

  for (const job of slice.jobs) {
    const locales = job.previousSlugsByLocale;
    if (locales && typeof locales === 'object') {
      for (const [locale, arr] of Object.entries(locales)) {
        if (!Array.isArray(arr)) continue;
        const kept = [];
        for (const slug of arr) {
          const { targetJob, redirected } = resolveRecoveryTarget(job, slug, bySuffixHash);
          if (redirected) { moved++; addToTarget(targetJob, locale, slug); continue; }
          kept.push(slug);
        }
        locales[locale] = kept;
      }
    }
    if (Array.isArray(job.previousSlugs)) {
      job.previousSlugs = job.previousSlugs.filter((slug) => {
        const { targetJob, redirected } = resolveRecoveryTarget(job, slug, bySuffixHash);
        if (redirected) { moved++; addFlatToTarget(targetJob, slug); return false; }
        return true;
      });
    }
  }

  for (const [targetJob, entry] of additions) {
    if (!targetJob.previousSlugsByLocale || typeof targetJob.previousSlugsByLocale !== 'object') {
      targetJob.previousSlugsByLocale = {};
    }
    if (!Array.isArray(targetJob.previousSlugs)) targetJob.previousSlugs = [];
    for (const [locale, slugs] of entry.locales) {
      if (!Array.isArray(targetJob.previousSlugsByLocale[locale])) targetJob.previousSlugsByLocale[locale] = [];
      for (const slug of slugs) {
        if (!targetJob.previousSlugsByLocale[locale].includes(slug)) targetJob.previousSlugsByLocale[locale].push(slug);
        if (!targetJob.previousSlugs.includes(slug)) targetJob.previousSlugs.push(slug);
      }
    }
    for (const slug of entry.flat) {
      if (!targetJob.previousSlugs.includes(slug)) targetJob.previousSlugs.push(slug);
    }
  }

  let emptyLocaleBucketsPruned = 0;
  for (const job of slice.jobs) {
    emptyLocaleBucketsPruned += pruneEmptyPreviousSlugLocaleBuckets(job);
  }

  if (moved === 0 && emptyLocaleBucketsPruned === 0) return null;
  // This script's whole purpose is to DROP contaminated entries from the
  // wrong job — writeJsonAtomic's slug-preservation guard (#5157) otherwise
  // sees that drop as an accidental loss and re-injects the exact
  // contamination this pass is removing (documented escape hatch in
  // scripts/lib/slug-preservation-guard.mjs). Scoped to this write only.
  if (APPLY) withGuardOff(() => writeJsonAtomic(filePath, slice));
  return { moved, emptyLocaleBucketsPruned };
}

function main() {
  let totalMoved = 0;
  let totalEmptyLocaleBucketsPruned = 0;
  let filesChanged = 0;
  for (const name of listSliceFileNames(BY_CRAWLER_DIR)) {
    const res = processFile(path.join(BY_CRAWLER_DIR, name));
    if (res) {
      filesChanged++;
      totalMoved += res.moved;
      totalEmptyLocaleBucketsPruned += res.emptyLocaleBucketsPruned;
      console.log(`${name}: ${res.moved} moved, ${res.emptyLocaleBucketsPruned} empty locale bucket(s) pruned`);
    }
  }
  console.log(`\n${APPLY ? 'APPLIED' : 'DRY-RUN'}: ${filesChanged} file(s), ${totalMoved} slug(s) redirected to their correct current owner.`);
  console.log(`${totalEmptyLocaleBucketsPruned} empty locale bucket(s) pruned.`);
  if (!APPLY && filesChanged > 0) console.log('Re-run with --apply to write.');
}

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`
      || import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main();
}
