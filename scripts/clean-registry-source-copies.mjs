#!/usr/bin/env node
/**
 * clean-registry-source-copies.mjs — one-shot bonifica of poisoned slug-registry
 * entries (follow-up of the previousSlugs / registryPinnedLocaleSlug fix,
 * issues #3785/#3794/#3844/#3852/#3874).
 *
 * WHAT IS POISONED
 * Early registry entries were frozen BEFORE AI localization finished: every
 * (or several) locale slot(s) in `slugByLocale` are byte-copies of the raw
 * source slug (e.g. the KSA entries registered 2026-07-09 with the raw DE slug
 * across all four locales). Registry entries carry NO sourceLang, so
 * `registryPinnedLocaleSlug` now applies the unknown-source rule and refuses
 * to pin any per-locale value that is identical to another locale's value —
 * those slots are dead weight that older/weaker code paths could still trip
 * over, and they mask the "backfill the locale once a REAL translation
 * exists" contract of backfillRegistryLocaleSlugs.
 *
 * REMOVAL CRITERION (deliberately narrower than the guard)
 * A locale slot is removed only when BOTH hold:
 *   1. the guard refuses to pin it under unknown sourceLang
 *      (registryPinnedLocaleSlug(entry, locale, null) === null while the slot
 *      is non-empty) — i.e. it is a cross-locale identical copy; AND
 *   2. its value equals the entry's immutable `canonicalSlug` — the frozen
 *      raw-source-slug pattern. A duplicate group whose value differs from
 *      canonicalSlug is AMBIGUOUS (it could be the legit source slot of a
 *      half-translated entry, or two real translations that coincide — see the
 *      `halfCopied` case in tests/registry-pinned-locale-slug.test.ts, where
 *      'de' is a legitimate pin once sourceLang is known): those slots are
 *      left untouched and counted as skipped.
 *
 * Removing a slot never strands an indexed URL: `canonicalSlug` (the master
 * slug) is never touched, the entry itself is never deleted, and a removed
 * true-source slot self-heals — source-locale slugs are derived
 * deterministically from the source title (no AI), so backfillRegistryLocaleSlugs
 * re-adds the same value on the next crawl that knows the sourceLang, while
 * non-source locales get backfilled the first time a REAL translation exists.
 *
 * USAGE
 *   node scripts/clean-registry-source-copies.mjs            # dry-run (default): report only
 *   node scripts/clean-registry-source-copies.mjs --apply    # rewrite data/slug-registry.json
 *
 * Honors SLUG_REGISTRY_PATH_OVERRIDE (same contract as loadSlugRegistry).
 * Unlike loadSlugRegistry, a malformed registry file is a HARD error here —
 * silently treating it as `{}` and then applying would wipe the registry.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registryPinnedLocaleSlug, normalizeSpace } from './lib/dedicated-crawler-common.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY_PATH = path.resolve(__dirname, '..', 'data', 'slug-registry.json');
const SAMPLE_LIMIT = 10;

function resolveRegistryPath() {
  const override = process.env.SLUG_REGISTRY_PATH_OVERRIDE;
  return override ? path.resolve(override) : DEFAULT_REGISTRY_PATH;
}

export function cleanRegistrySourceCopies(registry) {
  const stats = {
    entriesScanned: 0,
    poisonedEntries: 0,          // entries with >=1 slot removed
    slotsRemoved: 0,
    ambiguousEntriesSkipped: 0,  // entries with copy-slots left in place (value != canonicalSlug)
    ambiguousSlotsSkipped: 0,
    samples: [],
  };

  for (const [fp, entry] of Object.entries(registry)) {
    stats.entriesScanned += 1;
    if (!entry || typeof entry !== 'object') continue;
    const byLocale = entry.slugByLocale;
    if (!byLocale || typeof byLocale !== 'object') continue;

    const canonical = normalizeSpace(String(entry.canonicalSlug || ''));
    const removedLocales = [];
    let ambiguousHere = 0;

    for (const [locale, rawValue] of Object.entries(byLocale)) {
      const value = normalizeSpace(String(rawValue || ''));
      if (!value) continue;
      // Reuse the guard verbatim: under unknown sourceLang a non-null return
      // means the slot is unique across locales → a real (pinnable) slug.
      if (registryPinnedLocaleSlug(entry, locale, null) !== null) continue;
      // Cross-locale identical copy. Unambiguously poisoned only when it is
      // the frozen raw canonical/master slug; anything else could be a legit
      // source slot or coincidentally-identical real translations → skip.
      if (canonical && value === canonical) {
        removedLocales.push(locale);
      } else {
        ambiguousHere += 1;
      }
    }

    if (ambiguousHere > 0) {
      stats.ambiguousEntriesSkipped += 1;
      stats.ambiguousSlotsSkipped += ambiguousHere;
    }
    if (removedLocales.length === 0) continue;

    stats.poisonedEntries += 1;
    stats.slotsRemoved += removedLocales.length;
    if (stats.samples.length < SAMPLE_LIMIT) {
      stats.samples.push({
        fingerprint: fp,
        canonicalSlug: entry.canonicalSlug,
        removedLocales,
      });
    }
    for (const locale of removedLocales) {
      delete byLocale[locale];
    }
  }

  return stats;
}

function main() {
  const apply = process.argv.includes('--apply');
  const registryPath = resolveRegistryPath();

  if (!fs.existsSync(registryPath)) {
    console.error(`Registry not found: ${registryPath}`);
    process.exit(1);
  }
  // Hard-fail on malformed JSON (no loadSlugRegistry `{}` fallback): applying
  // a clean pass on an accidentally-empty parse would destroy the registry.
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    console.error(`Registry root must be an object: ${registryPath}`);
    process.exit(1);
  }

  const stats = cleanRegistrySourceCopies(registry);

  console.log(`Slug-registry source-copy bonifica ${apply ? '(APPLY)' : '(dry-run)'} — ${registryPath}`);
  console.log(`  Entries scanned:                 ${stats.entriesScanned}`);
  console.log(`  Poisoned entries (slots pruned): ${stats.poisonedEntries}`);
  console.log(`  Locale slots removed:            ${stats.slotsRemoved}`);
  console.log(`  Ambiguous entries skipped:       ${stats.ambiguousEntriesSkipped}`);
  console.log(`  Ambiguous slots left in place:   ${stats.ambiguousSlotsSkipped}`);
  if (stats.samples.length > 0) {
    console.log(`  Sample (first ${stats.samples.length}):`);
    for (const s of stats.samples) {
      console.log(`    - ${s.fingerprint} [${s.removedLocales.join(',')}] ${s.canonicalSlug}`);
    }
  }

  if (!apply) {
    console.log('\nDry-run: nothing written. Re-run with --apply to persist.');
    return;
  }
  writeJsonAtomic(registryPath, registry);
  console.log(`\nApplied: registry rewritten atomically (${stats.slotsRemoved} slot(s) removed, entries never deleted).`);
}

// Allow importing cleanRegistrySourceCopies without running main (tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
