#!/usr/bin/env node
/**
 * fix-untranslated-titles.mjs — One-shot batch fix for jobs with source-copy titles.
 *
 * Finds jobs where titleByLocale[locale] is an exact copy of the source title
 * and translates them using the free-translate cascade (DeepL → MyMemory → etc).
 *
 * Does NOT use AI/LLM — only the free cascade. Fast, cheap, reliable.
 * Does NOT modify descriptions, slugs, or needsRetranslation flags.
 *
 * Usage:
 *   DEEPL_API_KEY=xxx DEEPL_API_KEY_2=yyy node scripts/fix-untranslated-titles.mjs [--dry-run]
 */

import fs from 'node:fs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freeTranslateWithRetry, logCascadeSummary } from './lib/free-translate.mjs';
import { titleLooksUntranslated } from './lib/job-locale-utils.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BY_CRAWLER_DIR = path.resolve(__dirname, '..', 'data', 'jobs', 'by-crawler');
const LOCALES = ['it', 'en', 'de', 'fr'];
const DRY_RUN = process.argv.includes('--dry-run');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }

async function main() {
  const files = listSliceFileNames(BY_CRAWLER_DIR).sort();
  let totalFixed = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let slicesChanged = 0;

  console.log(`🔧 Fixing untranslated titles across ${files.length} slices...`);
  if (DRY_RUN) console.log('   (DRY RUN — no files will be modified)\n');

  for (const file of files) {
    const slicePath = path.join(BY_CRAWLER_DIR, file);
    const sliceData = readJson(slicePath);
    const jobs = Array.isArray(sliceData?.jobs) ? sliceData.jobs : [];
    if (jobs.length === 0) continue;

    let sliceChanged = false;

    for (const job of jobs) {
      const sl = job.sourceLang || 'it';
      const sourceTitle = (job.title || '').trim();
      if (!sourceTitle || sourceTitle.length < 3) continue;

      const tbl = job.titleByLocale || {};

      for (const locale of LOCALES) {
        if (locale === sl) continue;
        const existing = (tbl[locale] || '').trim();
        if (!existing) continue;

        // S3 (2026-08-10): this used to skip the slot whenever at least one
        // OTHER non-source locale differed from the source ("international
        // title, nothing to do"). That cross-locale rule is the reported bug —
        // it excuses an untranslated IT slot on the evidence of a translated EN
        // slot — so the question is now asked per slot, by the shared primitive,
        // which needs no corroboration from the neighbouring locales.
        //
        // `source-copy` only, on purpose: this script rewrites the slot with a
        // machine translation OF THE SOURCE TITLE, which is a repair for a slot
        // holding a verbatim copy and nothing at all for a slot holding a
        // partial translation. Widening it to every `untranslated` verdict would
        // hand the same input to the same cascade and overwrite a half-good
        // title with, at best, the same half-good title.
        const verdict = titleLooksUntranslated({
          title: existing,
          sourceTitle,
          sourceLang: sl,
          targetLocale: locale,
          company: job.company || '',
          location: job.addressLocality || job.location || '',
        });
        if (verdict.reason !== 'source-copy') { totalSkipped++; continue; }

        // Translate using free cascade
        const translated = await freeTranslateWithRetry({
          text: sourceTitle,
          sourceLang: sl,
          targetLang: locale,
          maxRetries: 1,
        });

        if (translated && translated.toLowerCase() !== sourceTitle.toLowerCase()) {
          if (!DRY_RUN) {
            tbl[locale] = translated;
            job.titleByLocale = tbl;
            sliceChanged = true;
          }
          totalFixed++;
        } else {
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

  // "skipped" no longer means "international title": the escape hatch that used
  // that word is gone. It now means the slot is not a verbatim copy of the
  // source — which includes correctly-translated slots AND the partially-
  // translated ones this script cannot repair (see the note in the loop).
  console.log(`\n📊 Title fix complete: ${totalFixed} translated, ${totalSkipped} skipped (not a source copy), ${totalFailed} failed`);
  console.log(`   ${slicesChanged} slices modified`);
  logCascadeSummary();
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
