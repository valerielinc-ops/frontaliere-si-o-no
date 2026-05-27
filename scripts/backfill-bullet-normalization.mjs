#!/usr/bin/env node
/**
 * One-shot backfill: re-runs `normalizeDescriptionBullets` over the
 * description field of every job in the 4 crawlers whose slice files
 * regressed against the parser-quality ratchet on 2026-05-07.
 *
 * Affected crawlers:
 *   - eoc-ente-ospedaliero-cantonale
 *   - kanton-gr
 *   - marriott
 *   - vtg
 *
 * Why: the parsers themselves now apply the bullet-normalizer (kanton-gr
 * fix in parseDetailPage, marriott fix in buildJobFromApi, eoc fix in
 * cleanEocDescription, vtg via shared helper). But the slice files were
 * already committed with the old flat descriptions — this script catches
 * the data up so the live CI audit passes without waiting for a fresh
 * crawl-and-republish round-trip per crawler.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const TARGET_KEYS = new Set([
  'eoc-ente-ospedaliero-cantonale',
  'kanton-gr',
  'marriott',
  'vtg',
]);

function isTargetJob(job) {
  return job && typeof job === 'object' && TARGET_KEYS.has(job.companyKey);
}

function rewriteDescription(job) {
  const before = String(job.description || '');
  const after = normalizeDescriptionBullets(before);
  if (after === before) return false;
  job.description = after;
  if (job.descriptionByLocale && typeof job.descriptionByLocale === 'object') {
    const sourceLang = job.sourceLang ||
      (job.descriptionByLocale.it ? 'it' :
        job.descriptionByLocale.de ? 'de' :
          job.descriptionByLocale.en ? 'en' : 'fr');
    if (job.descriptionByLocale[sourceLang] === before) {
      job.descriptionByLocale[sourceLang] = after;
    }
  }
  return true;
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
    fs.writeFileSync(filePath, JSON.stringify(raw, null, 2) + '\n');
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
    fs.writeFileSync(filePath, JSON.stringify(raw, null, 2) + '\n');
  }
  return { file: filePath, total: jobs.length, changed };
}

console.log('🔁 Backfilling bullet normalization for 4 regressed crawlers');

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
