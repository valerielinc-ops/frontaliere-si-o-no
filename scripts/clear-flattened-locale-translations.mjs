#!/usr/bin/env node
/**
 * Issue #3721 data repair, step 2 of 2.
 *
 * `backfill-bullet-normalization.mjs` fixes the source-language `description`
 * field. The audit (`audit-parser-quality.mjs`'s `effectiveDescription`)
 * checks the first populated locale in `it, en, de, fr` order — for any
 * crawler whose source language isn't Italian, that's a *translated* field.
 * Those translations were produced by the free cascade before
 * `free-translate.mjs` was fixed to stop flattening structure
 * (`normalizeSpace` → `normalizeBlock` across all 10 tiers), so a job whose
 * source description has real bullets can still fail the audit purely
 * because its `descriptionByLocale.it` (or whichever locale the audit reads
 * first) lost every bullet in translation.
 *
 * This script finds exactly that pattern — a job where at least one locale
 * has real bullet structure but another locale's non-trivial description has
 * none — and deletes the flattened locale entry. That turns it into a
 * genuine gap, which the already-tested `repair-job-locales.mjs` /
 * `translateMissingJobLocales` pipeline then fills using the now-fixed
 * cascade. Scoped to the crawlers `parser-quality-3721-crawlers.mjs`
 * identified for #3721 (shared with `backfill-bullet-normalization.mjs`)
 * rather than every crawler.
 *
 * Usage:
 *   node scripts/clear-flattened-locale-translations.mjs            # apply
 *   node scripts/clear-flattened-locale-translations.mjs --dry-run  # report only
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGET_KEYS } from './lib/parser-quality-3721-crawlers.mjs';
import { countBullets } from './lib/translation-quality.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const JOBS_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const LOCALES = ['it', 'en', 'de', 'fr'];

// Below this, a locale entry is too short for bullet loss to matter (matches
// isAcceptableTranslation's MIN_TRANSLATION_CHARS-adjacent reasoning).
const MIN_FLATTENED_LEN = 200;
// Mirrors translation-quality.mjs's MIN_SOURCE_BULLETS_FOR_STRUCTURE_CHECK.
const MIN_BULLETS_TO_PROVE_STRUCTURE = 3;

const dryRun = process.argv.includes('--dry-run');

function plainLength(text = '') {
  return String(text || '').replace(/<[^>]+>/g, '').trim().length;
}

let totalJobsScanned = 0;
let totalCleared = 0;
const perCrawler = [];

for (const key of TARGET_KEYS) {
  const filePath = path.join(JOBS_DIR, `${key}.json`);
  if (!fs.existsSync(filePath)) continue;
  const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const jobs = Array.isArray(envelope.jobs) ? envelope.jobs : [];
  let clearedHere = 0;

  for (const job of jobs) {
    totalJobsScanned += 1;
    const dl = job.descriptionByLocale;
    if (!dl || typeof dl !== 'object') continue;

    // Structure evidence must include the top-level `description` (#3836): the
    // historical mergeLocaleTextMap normalizeSpace defect flattened EVERY
    // byLocale slot — including the source-language one — on every crawl, so
    // for the worst-hit crawlers no locale slot has bullets left and only the
    // authoritative `description` still proves the job had a real list. The
    // original byLocale-only scan skipped exactly those jobs.
    const maxBullets = Math.max(
      0,
      countBullets(job.description),
      ...LOCALES.map((l) => countBullets(dl[l])),
    );
    if (maxBullets < MIN_BULLETS_TO_PROVE_STRUCTURE) continue;

    for (const locale of LOCALES) {
      const candidate = dl[locale];
      if (!candidate) continue;
      if (countBullets(candidate) > 0) continue;
      if (plainLength(candidate) < MIN_FLATTENED_LEN) continue;
      clearedHere += 1;
      totalCleared += 1;
      if (!dryRun) {
        delete dl[locale];
        job.needsRetranslation = true;
      }
    }
  }

  if (clearedHere > 0) {
    perCrawler.push({ key, clearedHere });
    if (!dryRun) {
      envelope.assembledAt = new Date().toISOString();
      writeJsonAtomic(filePath, envelope);
    }
  }
}

console.log(`${dryRun ? '🔍 [dry-run] ' : ''}Scanned ${totalJobsScanned} jobs across ${TARGET_KEYS.size} target crawlers.`);
for (const { key, clearedHere } of perCrawler.sort((a, b) => b.clearedHere - a.clearedHere)) {
  console.log(`  ${key}: ${clearedHere} flattened locale entr${clearedHere === 1 ? 'y' : 'ies'} ${dryRun ? 'would be cleared' : 'cleared'}`);
}
console.log(`\n${dryRun ? 'Would clear' : 'Cleared'} ${totalCleared} flattened locale entries total.`);
if (!dryRun && totalCleared > 0) {
  console.log('Run `node scripts/repair-job-locales.mjs` next to refill the gaps via the fixed cascade.');
}
