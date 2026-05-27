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
 *   node scripts/fix-untranslated-descriptions.mjs [--dry-run] [--max N]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freeTranslateWithRetry, logCascadeSummary } from './lib/free-translate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BY_CRAWLER_DIR = path.resolve(__dirname, '..', 'data', 'jobs', 'by-crawler');
const LOCALES = ['it', 'en', 'de', 'fr'];
const DRY_RUN = process.argv.includes('--dry-run');
const MAX = (() => {
  const idx = process.argv.indexOf('--max');
  return idx !== -1 && process.argv[idx + 1] ? Number(process.argv[idx + 1]) : Infinity;
})();

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
function writeJson(p, v) { fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf-8'); }

async function main() {
  const files = fs.readdirSync(BY_CRAWLER_DIR).filter(f => f.endsWith('.json')).sort();
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
          maxRetries: 1,
        });

        if (translated && translated.length >= 100 && translated.toLowerCase() !== sourceDesc.toLowerCase()) {
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

main().catch(err => { console.error('❌', err.message); process.exit(1); });
