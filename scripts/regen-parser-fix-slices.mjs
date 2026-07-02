#!/usr/bin/env node
/**
 * One-shot regeneration of `data/jobs/by-crawler/{bitfinex,cseb}.json` to
 * apply the parser fixes from this PR without waiting for the next
 * scheduled crawl.
 *
 *   - bitfinex: dedupe duplicate Recruitee listings (same title + same body
 *     posted N times with different IDs).
 *   - cseb:     re-parse current Abacus API response so descriptions get
 *     line-start bullets again (the parser fix to decodeAndStrip +
 *     buildDescription preserves <li> structure).
 *
 * The full pipeline (`scripts/update-{bitfinex,cseb}-jobs.mjs`) also runs
 * AI re-translation, which needs API keys and can take many minutes per
 * crawler. This script intentionally skips that step: it regenerates the
 * slice file with the fixed parser output and preserves the existing
 * `*ByLocale` translation fields so the audit unblocks immediately. The
 * next scheduled crawl will refresh translations through the normal flow.
 *
 * Usage:
 *   node scripts/regen-parser-fix-slices.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchAllBitfinexJobs } from './lib/bitfinex-job-parser.mjs';
import { fetchAllCsebJobs } from './lib/cseb-job-parser.mjs';
import { writeJobsCrawlerSlice } from './assemble-jobs-dataset.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');

function readSlice(key) {
  const file = path.join(SLICES_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw) ? raw : (raw.jobs || []);
}

/**
 * Merge a fresh parser output with the existing slice: keep the parser's
 * structural fields (description, title, location, etc.) but preserve any
 * existing `*ByLocale` translations keyed on the same job id, so we don't
 * lose IT/DE/FR coverage just because we re-ran the source-language parse.
 */
// Grace period before an existing job absent from a regen run is dropped —
// mirrors mergePreserveLocaleData's silent-job-loss guard in
// scripts/lib/dedicated-crawler-common.mjs (same construct, same fix).
const GRACE_PERIOD_MAX_MISSES = 2;

function mergePreservingTranslations(freshJobs, existingJobs) {
  const existingById = new Map();
  const matchedIds = new Set();
  for (const ex of existingJobs) {
    if (ex && ex.id) existingById.set(ex.id, ex);
  }
  const merged = freshJobs.map((fresh) => {
    const ex = existingById.get(fresh.id);
    if (!ex) return fresh;
    matchedIds.add(fresh.id);
    const sl = fresh.sourceLang || ex.sourceLang || 'en';
    return {
      ...ex,
      ...fresh,
      titleByLocale: {
        ...(ex.titleByLocale || {}),
        ...(fresh.titleByLocale || {}),
        [sl]: fresh.title,
      },
      descriptionByLocale: {
        ...(ex.descriptionByLocale || {}),
        ...(fresh.descriptionByLocale || {}),
        [sl]: fresh.description,
      },
      slugByLocale: {
        ...(ex.slugByLocale || {}),
        ...(fresh.slugByLocale || {}),
      },
      requirementsByLocale: ex.requirementsByLocale || fresh.requirementsByLocale,
    };
  });

  const retained = [];
  for (const [id, ex] of existingById) {
    if (matchedIds.has(id)) continue;
    const missStreak = (Number(ex.crawlerMissStreak) || 0) + 1;
    if (missStreak > GRACE_PERIOD_MAX_MISSES) continue;
    retained.push({ ...ex, crawlerMissStreak: missStreak });
  }
  return retained.length ? [...merged, ...retained] : merged;
}

async function regenBitfinex() {
  console.log('\n=== bitfinex ===');
  const existing = readSlice('bitfinex');
  console.log(`  existing slice: ${existing.length} jobs`);
  const fresh = await fetchAllBitfinexJobs();
  const merged = mergePreservingTranslations(fresh, existing);
  // Delegate to the canonical writer so the slice gets the envelope shape
  // ({ crawlerKey, assembledAt, jobs }) the assembler requires — a bare array
  // is treated as malformed and hard-fails assemble-jobs-dataset. It also
  // restores the prev-slug safety net (trackSlugHistoryDrift) and firstSeenAt
  // backfill that a direct write would bypass.
  writeJobsCrawlerSlice('bitfinex', merged);
}

async function regenCseb() {
  console.log('\n=== cseb ===');
  const existing = readSlice('cseb');
  console.log(`  existing slice: ${existing.length} jobs`);
  const fresh = await fetchAllCsebJobs();
  const merged = mergePreservingTranslations(fresh, existing);
  writeJobsCrawlerSlice('cseb', merged);
}

async function main() {
  await regenBitfinex();
  await regenCseb();
  console.log('\n✓ Slices regenerated. Run `node scripts/audit-parser-quality.mjs --skip-urls` to verify.');
}

main().catch((err) => {
  console.error('❌ Regen failed:', err);
  process.exit(1);
});
