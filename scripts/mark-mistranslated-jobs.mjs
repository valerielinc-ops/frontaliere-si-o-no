#!/usr/bin/env node
/**
 * mark-mistranslated-jobs.mjs
 *
 * Scans `data/jobs.json` for jobs whose `descriptionByLocale[locale]` carries
 * text in the wrong language (per `detectLanguageWithConfidence` at ≥0.50
 * confidence) and flags those jobs with `needsRetranslation = true` in the
 * matching `data/jobs/by-crawler/*.json` slice. The daily
 * `translate-pending-jobs` cron then picks them up and re-translates.
 *
 * Run when the `tests/job-locale-consistency.test.ts` threshold (10 mismatches)
 * is exceeded due to backlog — the test is the early-warning ratchet; this
 * script clears the backlog by feeding it back to the translate pipeline.
 *
 * Usage:
 *   node scripts/mark-mistranslated-jobs.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectLanguageWithConfidence } from './lib/detect-language.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOCALES = ['it', 'en', 'de', 'fr'];
const DRY_RUN = process.argv.includes('--dry-run');

function main() {
  const jobs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'jobs.json'), 'utf8'));
  const offending = new Set();
  for (const job of jobs) {
    if (job.needsRetranslation) continue;
    for (const locale of LOCALES) {
      const desc = String(job.descriptionByLocale?.[locale] || '').trim();
      if (desc.length < 120) continue;
      const detected = detectLanguageWithConfidence(desc, locale);
      if (detected.confidence >= 0.50 && detected.lang !== locale) {
        offending.add(job.slug);
        break;
      }
    }
  }
  console.log(`Offending slugs: ${offending.size}`);

  const byCrawler = path.join(ROOT, 'data', 'jobs', 'by-crawler');
  let totalMarked = 0;
  let slicesChanged = 0;
  const files = fs.readdirSync(byCrawler).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const fp = path.join(byCrawler, f);
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const list = Array.isArray(data) ? data : (data.jobs || []);
    let modified = false;
    for (const j of list) {
      if (offending.has(j.slug) && !j.needsRetranslation) {
        j.needsRetranslation = true;
        modified = true;
        totalMarked++;
      }
    }
    if (modified) {
      if (!DRY_RUN) fs.writeFileSync(fp, JSON.stringify(data, null, 2) + '\n');
      slicesChanged++;
    }
  }
  console.log(`${DRY_RUN ? '[dry-run] would mark' : 'Marked'} ${totalMarked} jobs across ${slicesChanged} slices`);
}

main();
