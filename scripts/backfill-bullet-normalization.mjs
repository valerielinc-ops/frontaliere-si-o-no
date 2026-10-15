#!/usr/bin/env node
/**
 * One-shot backfill: re-runs `normalizeDescriptionBullets` over the
 * description field of every job in the crawlers whose slice files
 * regressed against the parser-quality ratchet, on 2026-05-07 and
 * 2026-07-08 (#3721).
 *
 * Why: the parsers themselves now apply the bullet-normalizer, but the
 * slice files were already committed with the old flat descriptions —
 * this script catches the data up so the live CI audit passes without
 * waiting for a fresh crawl-and-republish round-trip per crawler.
 *
 * Idempotent: normalizeDescriptionBullets returns input unchanged when
 * structure is already present.
 *
 * Usage:
 *   node scripts/backfill-bullet-normalization.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDescriptionBullets } from './lib/crawler-template.mjs';
import { stripInlineJsCode } from './lib/hospital-custom-html-helpers.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { TARGET_KEYS } from './lib/parser-quality-3721-crawlers.mjs';
import { countBullets } from './lib/translation-quality.mjs';

// lis-lugano-istituti-sociali (#3721): leaked Arca24 ATS widget JS
// (`var alertM = {...}`) survived extraction pre-fix and duplicated across
// jobs — strip it from already-committed descriptions too, not just bullets.
const JS_LEAK_KEYS = new Set(['lis-lugano-istituti-sociali']);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function isTargetJob(job) {
  return job && typeof job === 'object' && TARGET_KEYS.has(job.companyKey);
}

function normalizeField(job, before) {
  const deLeaked = JS_LEAK_KEYS.has(job.companyKey) ? stripInlineJsCode(before) : before;
  return normalizeDescriptionBullets(deLeaked);
}

function rewriteDescription(job) {
  let changed = false;

  const before = String(job.description || '');
  const after = normalizeField(job, before);
  if (after !== before) {
    job.description = after;
    changed = true;
  }

  // Each descriptionByLocale entry is normalized independently, not just the
  // one matching sourceLang: a translated copy can carry its own surviving
  // inline `•` markers even when it no longer string-equals `job.description`
  // (e.g. vz-vermoegenszentrum's locale copies had already diverged from the
  // canonical description before this backfill ran), and a crawler can have
  // real bullet-recoverable text in a non-source locale while the source
  // locale itself is untouched (e.g. kispi's it/en/fr entries).
  if (job.descriptionByLocale && typeof job.descriptionByLocale === 'object') {
    for (const locale of Object.keys(job.descriptionByLocale)) {
      const localeBefore = String(job.descriptionByLocale[locale] || '');
      const localeAfter = normalizeField(job, localeBefore);
      if (localeAfter !== localeBefore) {
        job.descriptionByLocale[locale] = localeAfter;
        changed = true;
      }
    }

    // The source-locale mirror can independently drift stale relative to the
    // ground-truth `job.description` (e.g. postauto: a separately-stored
    // copy that never received the parser's structure-preserving fix, with
    // no inline markers left to recover via the pass above). If it has
    // strictly fewer bullets than the freshly-normalized description, it's
    // stale — resync it from the ground truth.
    const sourceLang = job.sourceLang ||
      (job.descriptionByLocale.it ? 'it' :
        job.descriptionByLocale.de ? 'de' :
          job.descriptionByLocale.en ? 'en' : 'fr');
    const mirror = job.descriptionByLocale[sourceLang];
    if (mirror !== undefined && mirror !== after && countBullets(after) > countBullets(mirror)) {
      job.descriptionByLocale[sourceLang] = after;
      changed = true;
    }
  }

  return changed;
}

function processSlice(filePath) {
  if (!fs.existsSync(filePath)) return { file: filePath, missing: true };
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : (raw.jobs || []);
  let changed = 0;
  for (const j of jobs) {
    if (rewriteDescription(j)) changed++;
  }
  if (changed > 0) {
    writeJsonAtomic(filePath, raw);
  }
  return { file: filePath, total: jobs.length, changed };
}

function processMonolith(filePath) {
  if (!fs.existsSync(filePath)) return { file: filePath, missing: true };
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let changed = 0;
  for (const j of jobs) {
    if (!isTargetJob(j)) continue;
    if (rewriteDescription(j)) changed++;
  }
  if (changed > 0) {
    writeJsonAtomic(filePath, raw);
  }
  return { file: filePath, total: jobs.length, changed };
}

console.log(`🔁 Backfilling bullet normalization for ${TARGET_KEYS.size} regressed crawlers`);

for (const key of TARGET_KEYS) {
  const slicePath = path.join(ROOT, 'data', 'jobs', 'by-crawler', `${key}.json`);
  const r = processSlice(slicePath);
  console.log(`  • ${key}: ${r.missing ? 'MISSING' : `${r.changed}/${r.total} normalized`}`);
}

const monoPaths = [
  path.join(ROOT, 'data', 'jobs.json'),
  path.join(ROOT, 'public', 'data', 'jobs.json'),
];
for (const p of monoPaths) {
  const r = processMonolith(p);
  console.log(`  • ${path.relative(ROOT, p)}: ${r.missing ? 'MISSING' : `${r.changed}/${r.total} normalized`}`);
}

console.log('✅ Backfill complete.');
