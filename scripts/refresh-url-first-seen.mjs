#!/usr/bin/env node
// refresh-url-first-seen.mjs
//
// Scan dist/sitemap-*.xml for every emitted URL, merge into
// data/url-first-seen.json. New URLs get today's date; existing entries
// are preserved (monotonic — never overwrite an earlier first-seen).
//
// Consumed by build-plugins/shared/trafficEvidenceFilter.ts to apply
// the `minAgeDays` grace window per approved-patterns entry:
// freshly-emitted URLs (age < minAgeDays from first-seen) get a `full`
// override even when no evidence source recognizes them, protecting
// them from being indexed thin before evidence has time to accumulate.
//
// Run from the deploy workflow after build, before the audit step, so
// the row committed to history reflects today's emit set.
//
// Usage:
//   node scripts/refresh-url-first-seen.mjs [--dist=dist]
//                                           [--out=data/url-first-seen.json]
//                                           [--dry-run]
//
// Exit codes:
//   0  ok (file unchanged OR updated)
//   2  dist dir missing / unreadable

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Initial seed date — used the FIRST time this script runs against an
// empty url-first-seen.json. Backfills every URL discovered in dist
// sitemaps with a historical date so the 15-day grace window does not
// retroactively mark every existing URL as `full` for two weeks.
// Effective semantics:
//   - File empty (initial seed)  → stamp all current URLs with this date
//                                  (past the longest grace window in any
//                                  approved pattern → no grace → thinning
//                                  decisions match current behaviour)
//   - File non-empty (steady state) → stamp NEW URLs with today's date
//                                     (15-day grace protects them)
// Override with `--initial-seed-date=YYYY-MM-DD` for local backfills.
const DEFAULT_INITIAL_SEED_DATE = '2026-04-01';

function parseArgs(argv) {
  const out = {
    dist: 'dist',
    out: 'data/url-first-seen.json',
    dryRun: false,
    initialSeedDate: DEFAULT_INITIAL_SEED_DATE,
  };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--dist=')) out.dist = a.slice(7);
    else if (a.startsWith('--out=')) out.out = a.slice(6);
    else if (a.startsWith('--initial-seed-date=')) out.initialSeedDate = a.slice(20);
  }
  return out;
}

function normalizePath(p) {
  if (!p) return '';
  let s = p;
  if (s.startsWith('http://') || s.startsWith('https://')) {
    try { s = new URL(s).pathname; } catch { return ''; }
  }
  const q = s.indexOf('?'); if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf('#'); if (h >= 0) s = s.slice(0, h);
  s = s.replace(/\/index\.html$/, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (!s.startsWith('/')) s = '/' + s;
  return s;
}

// Extract `<loc>...</loc>` URLs from a sitemap XML string. Regex is
// safer than an XML parser here — sitemaps are very regular and we
// don't need namespace awareness.
const LOC_RX = /<loc>([^<]+)<\/loc>/g;

function extractUrlsFromSitemap(xml) {
  const urls = new Set();
  let m;
  while ((m = LOC_RX.exec(xml)) !== null) {
    const norm = normalizePath(m[1]);
    if (norm) urls.add(norm);
  }
  return urls;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const distDir = isAbsolute(args.dist) ? args.dist : join(ROOT, args.dist);
  if (!existsSync(distDir)) {
    console.error(`[url-first-seen] dist not found: ${distDir}`);
    process.exit(2);
  }

  // Find all sitemap-*.xml files in dist root. sitemap.xml itself is
  // the index — its <loc> entries point to the per-section sitemaps.
  // Scan both: the index gives us section-level URLs, the per-section
  // shards give us the leaf-page URLs.
  const allUrls = new Set();
  const entries = readdirSync(distDir);
  const sitemapFiles = entries.filter(f => f.startsWith('sitemap') && f.endsWith('.xml'));
  console.log(`[url-first-seen] scanning ${sitemapFiles.length} sitemap files in ${distDir}`);
  for (const f of sitemapFiles) {
    try {
      const xml = readFileSync(join(distDir, f), 'utf8');
      const urls = extractUrlsFromSitemap(xml);
      for (const u of urls) allUrls.add(u);
    } catch (err) {
      console.warn(`[url-first-seen] could not read ${f}: ${err.message}`);
    }
  }
  console.log(`[url-first-seen] discovered ${allUrls.size} unique URLs across all sitemaps`);

  // Load existing url-first-seen.json (monotonic — never overwrite an
  // earlier first-seen date).
  const outPath = isAbsolute(args.out) ? args.out : join(ROOT, args.out);
  let existing = {};
  if (existsSync(outPath)) {
    try {
      const raw = await readFile(outPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed;
      }
    } catch (err) {
      console.warn(`[url-first-seen] could not parse existing ${outPath}: ${err.message}`);
    }
  }

  // Initial seed = empty file. Without special-casing, every URL would
  // get stamped with today's date, putting the entire emit set inside
  // the 15-day grace window and effectively disabling thinning until
  // those entries age out. Use a historical seed date (well past every
  // approved pattern's `minAgeDays`) so existing URLs behave as
  // "already old" and only URLs added in FUTURE runs receive today's
  // stamp + real 15-day protection.
  const isInitialSeed = Object.keys(existing).length === 0;
  const today = new Date().toISOString().slice(0, 10);
  const stampDate = isInitialSeed ? args.initialSeedDate : today;
  console.log(
    `[url-first-seen] mode: ${isInitialSeed ? 'INITIAL-SEED' : 'incremental'} ` +
    `(stampDate=${stampDate})`
  );
  let added = 0;
  for (const u of allUrls) {
    if (!existing[u]) {
      existing[u] = stampDate;
      added++;
    }
  }
  console.log(`[url-first-seen] ${added} new URLs stamped with ${stampDate}; ${Object.keys(existing).length} total entries`);

  if (args.dryRun) {
    console.log(`[url-first-seen] dry-run — file not written`);
    return;
  }
  if (added === 0) {
    console.log(`[url-first-seen] no new URLs — file unchanged`);
    return;
  }
  // Sort keys so the file diff is predictable in git.
  const sorted = {};
  for (const k of Object.keys(existing).sort()) sorted[k] = existing[k];
  await writeFile(outPath, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`[url-first-seen] wrote ${outPath}`);
}

main().catch(err => {
  console.error('[url-first-seen] fatal:', err);
  process.exit(2);
});
