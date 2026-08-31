#!/usr/bin/env node
// seed-url-first-seen-precise.mjs
//
// One-shot backfill for data/url-first-seen.json with per-URL
// firstSeenAt dates derived from real source-of-truth data:
//
//   1. data/jobs/by-crawler/*.json  → builds slug → firstSeenAt index
//      (canonical slug, slugByLocale.{it,en,de,fr}, previousSlugs).
//      Every URL whose last path segment matches a known slug gets
//      that job's `firstSeenAt` (YYYY-MM-DD).
//
//   2. Everything else (clusters, gsc-keyword landings, hub pages, …)
//      falls back to a historical date past every approved pattern's
//      minAgeDays. This preserves current thinning decisions while
//      avoiding the "stamp everything today and disable thinning for
//      15 days" foot-gun of the empty-file initial seed path.
//
// URL discovery: fetched from the live sitemap index. Running this
// locally produces a file that can be committed and consumed by
// trafficEvidenceFilter on subsequent builds. After this seed lands
// on origin/main, `refresh-url-first-seen.mjs` operates in
// "incremental" mode (the file is no longer empty), so any URL
// emitted but not already present gets stamped with today's date
// (and a real 15-day grace window).
//
// Usage:
//   node scripts/seed-url-first-seen-precise.mjs
//     [--sitemap-base=https://frontaliereticino.ch]
//     [--out=data/url-first-seen.json]
//     [--fallback-date=YYYY-MM-DD]   default 2026-04-01
//     [--dry-run]

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIVE_CHECK_USER_AGENT, DEFAULT_LIVE_CHECK_TIMEOUT_MS } from './lib/live-link-check.mjs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const DEFAULTS = {
  sitemapBase: 'https://frontaliereticino.ch',
  out: 'data/url-first-seen.json',
  fallbackDate: '2026-04-01',
  dryRun: false,
};

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--sitemap-base=')) out.sitemapBase = a.slice(15);
    else if (a.startsWith('--out=')) out.out = a.slice(6);
    else if (a.startsWith('--fallback-date=')) out.fallbackDate = a.slice(16);
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

function lastSegment(urlPath) {
  const segments = urlPath.split('/').filter(Boolean);
  return segments[segments.length - 1] || '';
}

// Merge `slug → date` keeping the OLDEST observed date. A slug can
// belong to a single canonical job but the same string may also
// appear as a `previousSlugs` entry on a younger job (re-used after
// the canonical owner was retired). We want the oldest known date so
// no URL that legitimately is old gets a fresh-stamp.
function addOldest(map, slug, date) {
  if (!slug || !date) return;
  const cur = map.get(slug);
  if (!cur || date < cur) map.set(slug, date);
}

function loadSlugIndex(rootDir) {
  const index = new Map();
  const dir = join(rootDir, 'data/jobs/by-crawler');
  if (!existsSync(dir)) {
    console.warn(`[seed] ${dir} not found — slug index will be empty`);
    return index;
  }
  let files = 0, jobs = 0, withFs = 0;
  for (const f of listSliceFileNames(dir)) {
    files++;
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const list = Array.isArray(d) ? d : (d.jobs || []);
      for (const j of list) {
        jobs++;
        const fs_ = j.firstSeenAt;
        if (!fs_) continue;
        const date = fs_.slice(0, 10);
        withFs++;
        if (j.slug) addOldest(index, j.slug, date);
        if (j.slugByLocale && typeof j.slugByLocale === 'object') {
          for (const v of Object.values(j.slugByLocale)) {
            if (typeof v === 'string') addOldest(index, v, date);
          }
        }
        if (Array.isArray(j.previousSlugs)) {
          for (const ps of j.previousSlugs) {
            if (typeof ps === 'string') addOldest(index, ps, date);
            else if (ps && typeof ps.slug === 'string') addOldest(index, ps.slug, date);
            // some previousSlugs entries are themselves locale-keyed maps
            else if (ps && typeof ps === 'object') {
              for (const v of Object.values(ps)) {
                if (typeof v === 'string') addOldest(index, v, date);
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[seed] ${f}: ${err.message}`);
    }
  }
  console.log(`[seed] slug index: ${files} files, ${jobs} jobs (${withFs} with firstSeenAt) → ${index.size} unique slugs`);
  return index;
}

async function fetchSitemap(url) {
  // Same sibling fix as scripts/build-search-cluster-301-map.mjs (issue
  // #6774): this fetch had no bound at all, so one slow/hanging shard could
  // stall the whole sequential collectLiveUrls() loop indefinitely.
  const r = await fetch(url, {
    headers: { 'User-Agent': DEFAULT_LIVE_CHECK_USER_AGENT },
    signal: AbortSignal.timeout(DEFAULT_LIVE_CHECK_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return await r.text();
}

const LOC_RX = /<loc>([^<]+)<\/loc>/g;
function extractLocs(xml) {
  const out = [];
  let m;
  while ((m = LOC_RX.exec(xml)) !== null) out.push(m[1]);
  return out;
}

async function collectLiveUrls(sitemapBase) {
  const indexXml = await fetchSitemap(`${sitemapBase}/sitemap.xml`);
  const sitemapUrls = extractLocs(indexXml);
  console.log(`[seed] sitemap index: ${sitemapUrls.length} shards`);
  const all = new Set();
  let shardI = 0;
  for (const smUrl of sitemapUrls) {
    shardI++;
    try {
      const xml = await fetchSitemap(smUrl);
      const locs = extractLocs(xml);
      for (const u of locs) {
        const p = normalizePath(u);
        if (p) all.add(p);
      }
      if (shardI % 10 === 0 || shardI === sitemapUrls.length) {
        console.log(`[seed] [${shardI}/${sitemapUrls.length}] ${smUrl.split('/').pop()} → ${locs.length} URLs (cumulative: ${all.size})`);
      }
    } catch (err) {
      console.warn(`[seed] could not fetch ${smUrl}: ${err.message}`);
    }
  }
  return all;
}

function classifyUrl(urlPath) {
  // High-level URL class hints — used only for reporting which
  // bucket got which match coverage, not for stamping logic.
  if (urlPath.startsWith('/cerca-lavoro-') || /^\/(en|de|fr)\//.test(urlPath)) {
    const seg = urlPath.split('/').filter(Boolean);
    if (seg.length >= 2) {
      const last = seg[seg.length - 1];
      if (last.startsWith('search-') || last.startsWith('recherche-') || last.startsWith('suche-') || last.startsWith('ricerca-')) return 'cluster';
    }
  }
  if (urlPath.includes('/lavoro-') || urlPath.includes('/jobs-') || urlPath.includes('/emploi-') || urlPath.includes('/employer-')) return 'hub';
  return 'other';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[seed] config: ${JSON.stringify(args)}`);

  const slugIndex = loadSlugIndex(ROOT);
  const allUrls = await collectLiveUrls(args.sitemapBase);
  console.log(`[seed] total unique URLs: ${allUrls.size}`);

  const outPath = isAbsolute(args.out) ? args.out : join(ROOT, args.out);
  let existing = {};
  if (existsSync(outPath)) {
    try {
      const raw = readFileSync(outPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
    } catch (err) {
      console.warn(`[seed] could not parse ${outPath}: ${err.message}`);
    }
  }
  console.log(`[seed] existing entries: ${Object.keys(existing).length}`);

  const stats = {
    matched: 0,           // slug match → precise job date
    fallback: 0,          // no match → fallback historical date
    preserved: 0,         // already in `existing`, kept as-is
    classBuckets: { cluster: 0, hub: 0, other: 0, job: 0 },
  };

  const out = { ...existing };
  for (const u of allUrls) {
    if (out[u]) { stats.preserved++; continue; }
    const slug = lastSegment(u);
    const preciseDate = slugIndex.get(slug);
    if (preciseDate) {
      out[u] = preciseDate;
      stats.matched++;
      stats.classBuckets.job++;
    } else {
      out[u] = args.fallbackDate;
      stats.fallback++;
      const cls = classifyUrl(u);
      stats.classBuckets[cls] = (stats.classBuckets[cls] || 0) + 1;
    }
  }

  console.log(`[seed] results:`);
  console.log(`  matched (precise job date): ${stats.matched}`);
  console.log(`  fallback (${args.fallbackDate}):   ${stats.fallback}`);
  console.log(`  preserved (already present):  ${stats.preserved}`);
  console.log(`  total entries in output:      ${Object.keys(out).length}`);
  console.log(`  fallback breakdown:`);
  for (const [k, v] of Object.entries(stats.classBuckets)) {
    if (k === 'job') continue;
    console.log(`    ${k}: ${v}`);
  }

  if (args.dryRun) {
    console.log(`[seed] dry-run — file not written`);
    return;
  }

  // Sort keys for predictable diff.
  const sorted = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  writeFileSync(outPath, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`[seed] wrote ${outPath}`);
}

main().catch(err => {
  console.error('[seed] fatal:', err);
  process.exit(2);
});
