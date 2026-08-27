#!/usr/bin/env node
/**
 * fix-untranslated-descriptions.mjs — Batch fix for jobs with source-copy descriptions.
 *
 * Finds jobs where descriptionByLocale[locale] is an exact copy of the source description
 * and translates them using the free-translate cascade (DeepL → SimplyTranslate → etc).
 *
 * Does NOT use AI/LLM — only the free cascade.
 * Does NOT modify titles, slugs, or needsRetranslation flags.
 *
 * Usage:
 *   node scripts/fix-untranslated-descriptions.mjs [--dry-run] [--max N] [--slice <basename>]
 *
 *   --slice limits the run to a single by-crawler slice (basename with or without
 *   .json, e.g. `banca-cler`) for surgical, single-company fixes.
 */

import fs from 'node:fs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freeTranslateWithRetry, logCascadeSummary } from './lib/free-translate.mjs';
import { isAcceptableTranslation, MIN_TRANSLATION_CHARS } from './lib/translation-quality.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BY_CRAWLER_DIR = path.resolve(__dirname, '..', 'data', 'jobs', 'by-crawler');
const LOCALES = ['it', 'en', 'de', 'fr'];
// Translation-quality gate lives in a shared leaf lib so every writer of the
// indexed descriptionByLocale dataset uses the SAME thresholds (single source
// of truth). Re-exported here for back-compat with existing importers/tests.
export {
  MIN_TRANSLATION_RATIO,
  MIN_TRANSLATION_CHARS,
  isAcceptableTranslation,
} from './lib/translation-quality.mjs';
const DRY_RUN = process.argv.includes('--dry-run');
const MAX = (() => {
  const idx = process.argv.indexOf('--max');
  return idx !== -1 && process.argv[idx + 1] ? Number(process.argv[idx + 1]) : Infinity;
})();
const SLICE = (() => {
  const idx = process.argv.indexOf('--slice');
  if (idx === -1 || !process.argv[idx + 1]) return null;
  return process.argv[idx + 1].replace(/\.json$/, '');
})();

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }

async function main() {
  let files = listSliceFileNames(BY_CRAWLER_DIR);
  if (SLICE) {
    files = files.filter(f => f.replace(/\.json$/, '') === SLICE);
    if (files.length === 0) {
      console.error(`❌ No slice matching --slice "${SLICE}" in ${BY_CRAWLER_DIR}`);
      process.exit(1);
    }
    console.log(`🎯 Scoped to slice: ${SLICE}`);
  }
  let totalFixed = 0;
  let totalFailed = 0;
  let slicesChanged = 0;
  let charsTranslated = 0;

  console.log(`🔧 Fixing untranslated descriptions across ${files.length} slices...`);
  if (DRY_RUN) console.log('   (DRY RUN — no files will be modified)');
  if (MAX < Infinity) console.log(`   (MAX: ${MAX} descriptions)`);
  console.log('');

  for (const file of files) {
    if (totalFixed + totalFailed >= MAX) break;

    const slicePath = path.join(BY_CRAWLER_DIR, file);
    const sliceData = readJson(slicePath);
    const jobs = Array.isArray(sliceData?.jobs) ? sliceData.jobs : [];
    if (jobs.length === 0) continue;

    let sliceChanged = false;

    for (const job of jobs) {
      if (totalFixed + totalFailed >= MAX) break;

      const sl = job.sourceLang || 'it';
      const sourceDesc = (job.description || '').trim();
      if (!sourceDesc || sourceDesc.length < 120) continue;

      const dbl = job.descriptionByLocale || {};

      for (const locale of LOCALES) {
        if (locale === sl) continue;
        if (totalFixed + totalFailed >= MAX) break;

        const existing = (dbl[locale] || '').trim();
        if (!existing) continue;
        // Only fix exact source copies
        if (existing.toLowerCase() !== sourceDesc.toLowerCase()) continue;

        // Translate using free cascade
        const translated = await freeTranslateWithRetry({
          text: sourceDesc,
          sourceLang: sl,
          targetLang: locale,
          fieldType: 'description',
          maxRetries: 1,
        });

        const isNewLanguage = translated && translated.toLowerCase() !== sourceDesc.toLowerCase();
        // Single source of truth: same gate the sibling writers use.
        const isAcceptable = isAcceptableTranslation(sourceDesc, translated);

        if (isNewLanguage && isAcceptable && translated.length >= 120) {
          if (!DRY_RUN) {
            dbl[locale] = translated;
            job.descriptionByLocale = dbl;
            sliceChanged = true;
          }
          totalFixed++;
          charsTranslated += sourceDesc.length;
          // Log progress every 20 translations
          if (totalFixed % 20 === 0) {
            console.log(`   ... ${totalFixed} done, ${(charsTranslated / 1000).toFixed(0)}K chars`);
          }
        } else {
          // Diagnostic: distinguish a clipped/truncated translation (passes the
          // char floor but fails the source-length ratio) from other failures.
          const clipped =
            isNewLanguage &&
            translated &&
            translated.length >= MIN_TRANSLATION_CHARS &&
            !isAcceptable;
          if (clipped) {
            const pct = ((translated.length / sourceDesc.length) * 100).toFixed(0);
            console.log(`  ⚠️  ${file.replace('.json', '')} [${locale}]: truncated translation (${pct}% of source, ${translated.length}/${sourceDesc.length} chars) — skipped`);
          }
          totalFailed++;
        }
      }
    }

    if (sliceChanged && !DRY_RUN) {
      writeJson(slicePath, sliceData);
      slicesChanged++;
      console.log(`  ✅ ${file.replace('.json', '')}`);
    }
  }

  console.log(`\n📊 Description fix complete: ${totalFixed} translated, ${totalFailed} failed`);
  console.log(`   ${slicesChanged} slices modified, ${(charsTranslated / 1000).toFixed(0)}K chars translated`);
  logCascadeSummary();
}

// Only run the batch when invoked directly as a script; allow the helper above
// to be imported (e.g. by localize-vf-existing-jobs.mjs / re-localize-jobs.mjs)
// without side effects.
const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch(err => { console.error('❌', err.message); process.exit(1); });
}
