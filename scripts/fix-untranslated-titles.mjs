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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freeTranslateWithRetry, logCascadeSummary } from './lib/free-translate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BY_CRAWLER_DIR = path.resolve(__dirname, '..', 'data', 'jobs', 'by-crawler');
const LOCALES = ['it', 'en', 'de', 'fr'];
const DRY_RUN = process.argv.includes('--dry-run');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
function writeJson(p, v) { fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf-8'); }

async function main() {
  const files = fs.readdirSync(BY_CRAWLER_DIR).filter(f => f.endsWith('.json')).sort();
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
        // Only fix exact source copies
        if (existing.toLowerCase() !== sourceTitle.toLowerCase()) continue;

        // Skip international English titles (Manager, Engineer, etc.)
        const looksEnglish = existing.length < 50 && !/[àèéìòùüäöüß]/i.test(existing);
        const hasIntl = /\b(manager|engineer|developer|scrum|master|lead|head|specialist|analyst|coordinator|consultant|architect|designer|director|officer|intern|trainee|scientist)\b/i.test(existing);
        if (looksEnglish && hasIntl) {
          // Check if OTHER locales have different titles (meaning this is genuinely international)
          const othersDiffer = LOCALES.some(l => l !== locale && l !== sl && (tbl[l] || '').trim().toLowerCase() !== sourceTitle.toLowerCase());
          if (othersDiffer) { totalSkipped++; continue; }
        }

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

  console.log(`\n📊 Title fix complete: ${totalFixed} translated, ${totalSkipped} skipped (international), ${totalFailed} failed`);
  console.log(`   ${slicesChanged} slices modified`);
  logCascadeSummary();
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
