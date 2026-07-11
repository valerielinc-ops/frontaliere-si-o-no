#!/usr/bin/env node
/**
 * clean-expired-slice-source-copies.mjs — one-shot bonifica of poisoned
 * slugByLocale copies frozen inside data/jobs/expired/by-crawler/<key>.json
 * (follow-up of clean-registry-source-copies.mjs / issue #4055, item 1 of
 * #4057).
 *
 * WHY EXPIRED SLICES NEED THEIR OWN PASS
 * clean-registry-source-copies.mjs bonifies data/slug-registry.json, but the
 * poisoned-copy pattern (several/all slugByLocale slots frozen as a
 * byte-copy of the source-locale slug before AI localization finished) can
 * also land directly on a JOB object, independent of the registry. For an
 * ACTIVE job this self-heals: the next crawl re-derives/backfills the locale
 * once a real translation exists. An EXPIRED job never crawls again — once
 * archived to data/jobs/expired/by-crawler/<key>.json (expired-jobs-archive.mjs)
 * its slugByLocale is frozen forever. Those poisoned slots still feed
 * `expiredJobSlugVariants` (build-plugins/shared/expiredSlugVariants.ts),
 * which the soft-landing build plugin (jobsSeoPagesPlugin) uses to index
 * orphan URLs onto expired-job content — so a poisoned slot is not inert
 * data, it is a redundant/wrong entry in that resolution index.
 *
 * REMOVAL CRITERION (identical decision to clean-registry-source-copies.mjs,
 * shared via pruneSourceCopySlots — see scripts/lib/dedicated-crawler-common.mjs)
 * `entry.slug` plays the immutable canonicalSlug role here (registerJobSlug
 * seeds a registry entry's canonicalSlug from job.slug at first
 * registration, so the same frozen raw-source-slug value ends up in both
 * places). `entry.sourceLang` is passed through when the archived job
 * carries one so the sourceLang-aware branch of registryPinnedLocaleSlug
 * applies; older entries without it fall back to the unknown-source
 * cross-locale-duplicate rule (same behavior as the registry script).
 *
 * USAGE
 *   node scripts/clean-expired-slice-source-copies.mjs            # dry-run (default): report only
 *   node scripts/clean-expired-slice-source-copies.mjs --apply    # rewrite the expired slices
 *
 * Honors EXPIRED_SLICES_DIR_OVERRIDE (test hook, mirrors
 * SLUG_REGISTRY_PATH_OVERRIDE). A malformed slice file is logged and
 * skipped, never treated as empty-and-overwritten.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneSourceCopySlots, normalizeSpace } from './lib/dedicated-crawler-common.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SLICES_DIR = path.resolve(__dirname, '..', 'data', 'jobs', 'expired', 'by-crawler');
const SAMPLE_LIMIT = 10;

function resolveSlicesDir() {
  const override = process.env.EXPIRED_SLICES_DIR_OVERRIDE;
  return override ? path.resolve(override) : DEFAULT_SLICES_DIR;
}

/**
 * Bonify one expired-slice array in place. Exported for tests; `main()`
 * aggregates this across every per-crawler slice file on disk.
 *
 * @param {object[]} slice - array of expired-job entries (buildExpiredEntry shape)
 * @returns {object} stats (same shape as cleanRegistrySourceCopies)
 */
export function cleanExpiredSliceSourceCopies(slice) {
  const stats = {
    entriesScanned: 0,
    poisonedEntries: 0,
    slotsRemoved: 0,
    ambiguousEntriesSkipped: 0,
    ambiguousSlotsSkipped: 0,
    samples: [],
  };
  if (!Array.isArray(slice)) return stats;

  for (const entry of slice) {
    stats.entriesScanned += 1;
    if (!entry || typeof entry !== 'object') continue;
    if (!entry.slugByLocale || typeof entry.slugByLocale !== 'object') continue;

    const canonical = normalizeSpace(String(entry.slug || ''));
    const sourceLang = entry.sourceLang || null;
    const { removedLocales, ambiguousSlots } = pruneSourceCopySlots(entry, canonical, sourceLang);

    if (ambiguousSlots > 0) {
      stats.ambiguousEntriesSkipped += 1;
      stats.ambiguousSlotsSkipped += ambiguousSlots;
    }
    if (removedLocales.length === 0) continue;

    stats.poisonedEntries += 1;
    stats.slotsRemoved += removedLocales.length;
    if (stats.samples.length < SAMPLE_LIMIT) {
      stats.samples.push({ slug: entry.slug, removedLocales });
    }
  }
  return stats;
}

function main() {
  const apply = process.argv.includes('--apply');
  const dir = resolveSlicesDir();

  if (!fs.existsSync(dir)) {
    console.error(`Expired slices dir not found: ${dir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const totals = {
    filesScanned: 0,
    filesChanged: 0,
    entriesScanned: 0,
    poisonedEntries: 0,
    slotsRemoved: 0,
    ambiguousEntriesSkipped: 0,
    ambiguousSlotsSkipped: 0,
    samples: [],
  };

  for (const file of files) {
    const filePath = path.join(dir, file);
    let slice;
    try {
      slice = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.error(`Skipping malformed slice ${file}: ${err.message}`);
      continue;
    }
    if (!Array.isArray(slice)) continue;

    totals.filesScanned += 1;
    const stats = cleanExpiredSliceSourceCopies(slice);
    totals.entriesScanned += stats.entriesScanned;
    totals.poisonedEntries += stats.poisonedEntries;
    totals.slotsRemoved += stats.slotsRemoved;
    totals.ambiguousEntriesSkipped += stats.ambiguousEntriesSkipped;
    totals.ambiguousSlotsSkipped += stats.ambiguousSlotsSkipped;
    for (const s of stats.samples) {
      if (totals.samples.length < SAMPLE_LIMIT) totals.samples.push({ file, ...s });
    }

    if (stats.slotsRemoved > 0) {
      totals.filesChanged += 1;
      if (apply) writeJsonAtomic(filePath, slice);
    }
  }

  console.log(`Expired-slice source-copy bonifica ${apply ? '(APPLY)' : '(dry-run)'} — ${dir}`);
  console.log(`  Files scanned:                   ${totals.filesScanned}`);
  console.log(`  Files changed:                   ${totals.filesChanged}`);
  console.log(`  Entries scanned:                 ${totals.entriesScanned}`);
  console.log(`  Poisoned entries (slots pruned): ${totals.poisonedEntries}`);
  console.log(`  Locale slots removed:            ${totals.slotsRemoved}`);
  console.log(`  Ambiguous entries skipped:       ${totals.ambiguousEntriesSkipped}`);
  console.log(`  Ambiguous slots left in place:   ${totals.ambiguousSlotsSkipped}`);
  if (totals.samples.length > 0) {
    console.log(`  Sample (first ${totals.samples.length}):`);
    for (const s of totals.samples) {
      console.log(`    - ${s.file} ${s.slug} [${s.removedLocales.join(',')}]`);
    }
  }

  if (!apply) {
    console.log('\nDry-run: nothing written. Re-run with --apply to persist.');
    return;
  }
  console.log(`\nApplied: ${totals.filesChanged} slice file(s) rewritten atomically (${totals.slotsRemoved} slot(s) removed, entries never deleted).`);
}

// Allow importing cleanExpiredSliceSourceCopies without running main (tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
