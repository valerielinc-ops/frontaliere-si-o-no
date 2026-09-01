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
 * another current job's disambiguator tail are moved to that job, including
 * a uniquely-owned target in another crawler slice. Entries whose tail
 * matches no current job are left untouched — a trailing 6-char
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
import { addPreviousSlugForLocale, promotePreviousSlugToLegacy } from './lib/dedicated-crawler-common.mjs';
import { resolveRecoveryTarget } from './backfill-prev-slugs-from-loss-events.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { withGuardOff } from './lib/slug-preservation-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BY_CRAWLER_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const APPLY = process.argv.includes('--apply');

function applyAddition(action) {
  if (action.locale !== null) {
    addPreviousSlugForLocale(
      action.targetJob,
      action.locale,
      action.slug,
      Number.MAX_SAFE_INTEGER,
      'decontaminate-prev-slugs',
    );
    return;
  }
  // A locale-aware action already synchronized this slug to the legacy flat
  // union. Only promote genuinely flat-only history; promotePreviousSlugToLegacy
  // intentionally removes locale provenance and must not erase a locale move.
  if (Array.isArray(action.targetJob.previousSlugs)
      && action.targetJob.previousSlugs.includes(action.slug)) return;
  promotePreviousSlugToLegacy(
    action.targetJob,
    action.slug,
    Number.MAX_SAFE_INTEGER,
    'decontaminate-prev-slugs',
  );
}

function removePlannedSlugs(job, plans) {
  const flat = new Set(plans.filter((plan) => plan.locale === null).map((plan) => plan.slug));
  if (flat.size && Array.isArray(job.previousSlugs)) {
    job.previousSlugs = job.previousSlugs.filter((slug) => !flat.has(slug));
  }

  const byLocale = new Map();
  for (const plan of plans) {
    if (plan.locale === null) continue;
    if (!byLocale.has(plan.locale)) byLocale.set(plan.locale, new Set());
    byLocale.get(plan.locale).add(plan.slug);
  }
  for (const [locale, slugs] of byLocale) {
    if (!Array.isArray(job.previousSlugsByLocale?.[locale])) continue;
    job.previousSlugsByLocale[locale] = job.previousSlugsByLocale[locale]
      .filter((slug) => !slugs.has(slug));
  }
}

/**
 * Process one or more crawler slices as a single ownership namespace.
 *
 * Cross-file redirects are written to their target slice before any claimant
 * removal. If a later write fails, the old route therefore still exists on
 * the claimant and a retry can safely finish the move; successful earlier
 * files are already idempotent. Hashes with more than one global record are
 * deliberately not used for cross-file routing, while same-file resolution
 * retains the historical first-owner behavior.
 */
export function processFiles(filePaths, {
  apply = APPLY,
  writeSlice = (filePath, slice) => writeJsonAtomic(filePath, slice),
} = {}) {
  const entries = filePaths.map((filePath) => ({
    filePath,
    slice: JSON.parse(fs.readFileSync(filePath, 'utf8')),
  })).filter((entry) => Array.isArray(entry.slice.jobs));
  const ownerEntry = new WeakMap();
  const globalOwners = new Map();

  for (const entry of entries) {
    for (const job of entry.slice.jobs) {
      ownerEntry.set(job, entry);
      const hash = stableSlugHash(job);
      if (!hash) continue;
      if (!globalOwners.has(hash)) globalOwners.set(hash, []);
      globalOwners.get(hash).push(job);
    }
  }

  const globallyUnique = new Map(
    [...globalOwners].filter(([, jobs]) => jobs.length === 1).map(([hash, jobs]) => [hash, jobs[0]]),
  );
  const plans = [];
  const stats = new Map(entries.map((entry) => [entry, { moved: 0, emptyLocaleBucketsPruned: 0 }]));

  for (const entry of entries) {
    const owners = new Map(globallyUnique);
    for (const job of entry.slice.jobs) {
      const hash = stableSlugHash(job);
      if (hash && !owners.has(hash)) owners.set(hash, job);
      // A same-slice owner is stronger than a unique global fallback.
      if (hash && ownerEntry.get(owners.get(hash)) !== entry) owners.set(hash, job);
    }

    for (const job of entry.slice.jobs) {
      for (const [locale, slugs] of Object.entries(job.previousSlugsByLocale || {})) {
        if (!Array.isArray(slugs)) continue;
        for (const slug of slugs) {
          const { targetJob, redirected } = resolveRecoveryTarget(job, slug, owners);
          if (!redirected) continue;
          plans.push({ sourceEntry: entry, sourceJob: job, targetEntry: ownerEntry.get(targetJob), targetJob, locale, slug });
          stats.get(entry).moved++;
        }
      }
      if (Array.isArray(job.previousSlugs)) {
        for (const slug of job.previousSlugs) {
          const { targetJob, redirected } = resolveRecoveryTarget(job, slug, owners);
          if (!redirected) continue;
          plans.push({ sourceEntry: entry, sourceJob: job, targetEntry: ownerEntry.get(targetJob), targetJob, locale: null, slug });
          stats.get(entry).moved++;
        }
      }
    }
  }

  const crossFilePlans = plans.filter((plan) => plan.sourceEntry !== plan.targetEntry);
  for (const plan of crossFilePlans) applyAddition(plan);

  // Persist cross-file targets first. A failure here cannot remove a claimant
  // route; a retry merely deduplicates additions that were already written.
  if (apply) {
    const targets = [...new Set(crossFilePlans.map((plan) => plan.targetEntry))]
      .sort((a, b) => a.filePath.localeCompare(b.filePath));
    for (const entry of targets) writeSlice(entry.filePath, entry.slice, { phase: 'cross-file-target' });
  }

  const plansByJob = new Map();
  for (const plan of plans) {
    if (!plansByJob.has(plan.sourceJob)) plansByJob.set(plan.sourceJob, []);
    plansByJob.get(plan.sourceJob).push(plan);
    if (plan.sourceEntry === plan.targetEntry) applyAddition(plan);
  }
  for (const [job, jobPlans] of plansByJob) removePlannedSlugs(job, jobPlans);

  for (const entry of entries) {
    for (const job of entry.slice.jobs) {
      stats.get(entry).emptyLocaleBucketsPruned += pruneEmptyPreviousSlugLocaleBuckets(job);
    }
  }

  const changedEntries = entries.filter((entry) => (
    stats.get(entry).moved > 0
    || stats.get(entry).emptyLocaleBucketsPruned > 0
    || crossFilePlans.some((plan) => plan.targetEntry === entry)
  ));
  if (apply) {
    // This pass intentionally drops claimant entries. Disable the preservation
    // guard only for each final atomic slice write; target-first additions
    // above remain protected by the normal writer.
    for (const entry of changedEntries.sort((a, b) => a.filePath.localeCompare(b.filePath))) {
      withGuardOff(() => writeSlice(entry.filePath, entry.slice, { phase: 'final' }));
    }
  }

  const affected = changedEntries.map((entry) => ({ filePath: entry.filePath, ...stats.get(entry) }));
  return {
    moved: plans.length,
    emptyLocaleBucketsPruned: affected.reduce((sum, entry) => sum + entry.emptyLocaleBucketsPruned, 0),
    affected,
  };
}

export function processFile(filePath, options) {
  const result = processFiles([filePath], options);
  if (result.affected.length === 0) return null;
  const [{ moved, emptyLocaleBucketsPruned }] = result.affected;
  return { moved, emptyLocaleBucketsPruned };
}

function main() {
  const filePaths = listSliceFileNames(BY_CRAWLER_DIR).map((name) => path.join(BY_CRAWLER_DIR, name));
  const result = processFiles(filePaths);
  for (const entry of result.affected) {
    console.log(`${path.basename(entry.filePath)}: ${entry.moved} moved, ${entry.emptyLocaleBucketsPruned} empty locale bucket(s) pruned`);
  }
  console.log(`\n${APPLY ? 'APPLIED' : 'DRY-RUN'}: ${result.affected.length} file(s), ${result.moved} slug(s) redirected to their correct current owner.`);
  console.log(`${result.emptyLocaleBucketsPruned} empty locale bucket(s) pruned.`);
  if (!APPLY && result.affected.length > 0) console.log('Re-run with --apply to write.');
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
