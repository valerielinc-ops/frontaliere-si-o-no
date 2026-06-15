#!/usr/bin/env node
/**
 * build-cf-hot-404s.mjs — bounded, traffic-targeted hot-list of non-Ticino
 * job-detail 404s for cfHot404BridgePlugin to recover.
 *
 * Why bounded (not the full compat accumulator): PR #2000 tried to emit a
 * bridge at EVERY non-Ticino compat job path (~241k). On top of
 * jobsSeoPagesPlugin's ~312k Ticino soft-landings that OOM'd the SSG build
 * (8GB heap) — reverted in #2031. The fix is to recover only the paths
 * Cloudflare confirms are ACTUALLY HIT: the long-tail with zero traffic is
 * not worth a page. The CF edge analytics records every real 404 with a hit
 * count, so we rank by hits and cap hard — a few thousand pages, safe by
 * construction.
 *
 * Output `data/cf-hot-404s.json`:
 *   { generatedAt, source:'cloudflare', windowHours, cap, paths:[{path,hits}] }
 * sorted by hits desc, accumulated across runs (keep max hits per path),
 * capped at MAX_PATHS. Ticino + nationwide `_AGGREGATE_` sections are EXCLUDED
 * (owned by jobsSeoPagesPlugin). Only single-segment job-detail slugs.
 *
 * Auth: CF_API_TOKEN (Zone→Analytics→Read), from Firebase Remote Config:
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     node scripts/load-rc-env.mjs)" && node scripts/build-cf-hot-404s.mjs
 *
 * Usage:
 *   node scripts/build-cf-hot-404s.mjs            # refresh + accumulate + write
 *   node scripts/build-cf-hot-404s.mjs --dry-run  # print stats, no write
 *   node scripts/build-cf-hot-404s.mjs --cap=8000 # override MAX_PATHS
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchErrorPaths, resolveZoneId, DEFAULT_ZONE_NAME } from './lib/cf-analytics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'cf-hot-404s.json');
const APEX_HOST = process.env.CF_ZONE_NAME || DEFAULT_ZONE_NAME;

// Hard cap — the safety rail learned from the #2000 OOM. Even a degraded CF
// response or a future traffic spike can never make the bridge plugin emit
// more than this many pages. ~12k thin pages is a ~3-4% bump on the IT shard,
// comfortably inside the headroom that already survives the ~312k TI pages.
const MAX_PATHS = 12000;

// Drop one-hit noise: a single hit is usually a bot path-probe, not a real
// expired/indexed URL worth a page. Real expired URLs get repeat hits from
// Google + returning visitors.
const MIN_HITS = 2;

// Ticino + nationwide sections are owned by jobsSeoPagesPlugin; never include.
const TICINO_RE =
  /^\/(cerca-lavoro-ticino|en\/(find-jobs?|job-search)-ticino|de\/(jobs-im|jobsuche|stellenangebote)-tessin|fr\/(trouver-emploi|recherche-emploi|emplois)-tessin)\//;
const AGGREGATE_RE =
  /^\/(cerca-lavoro-svizzera|en\/find-jobs-switzerland|de\/jobs-in-schweiz|fr\/trouver-emploi-suisse)\//;
// A non-Ticino per-canton job-detail path: optional locale prefix, a job-board
// section stem + canton slug, then exactly ONE slug segment.
const JOB_DETAIL_RE =
  /^(?:\/(?:en|de|fr))?\/(?:cerca-lavoro|find-jobs?|job-search|jobs-i[mn]|jobsuche|stellenangebote|trouver-emploi|recherche-emploi|emplois)-[a-z-]+\/[^/]+\/?$/;

function parseArgs(argv) {
  const opts = { dryRun: false, cap: MAX_PATHS };
  for (const a of argv) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a.startsWith('--cap=')) opts.cap = Math.max(1, Number(a.slice(6)) || MAX_PATHS);
  }
  return opts;
}

function readExisting() {
  try {
    const j = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    return Array.isArray(j?.paths) ? j.paths : [];
  } catch {
    return [];
  }
}

function isHotCandidate(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return false;
  if (!JOB_DETAIL_RE.test(p)) return false;
  if (TICINO_RE.test(p) || AGGREGATE_RE.test(p)) return false;
  return true;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = process.env.CF_API_TOKEN;
  if (!token) {
    console.error('❌ CF_API_TOKEN not set. Run `node scripts/load-rc-env.mjs` first.');
    process.exit(1);
  }
  const zoneId = await resolveZoneId(token, APEX_HOST, process.env.CF_ZONE_ID);
  const rows = await fetchErrorPaths(token, zoneId, {
    hours: 23.9,
    minStatus: 404,
    maxStatus: 404,
    host: APEX_HOST,
    limit: 10000,
  });

  // Accumulate: keep the MAX hits ever seen per path across runs (a path that
  // was hot last week but quiet today should not drop off immediately).
  const hits = new Map();
  for (const { path: p, hits: h } of readExisting()) {
    if (isHotCandidate(p)) hits.set(p.replace(/\/+$/, ''), h || 0);
  }
  let fresh = 0;
  for (const r of rows) {
    if (r.count < MIN_HITS) continue;
    const norm = r.path.replace(/\/+$/, '');
    if (!isHotCandidate(norm)) continue;
    const prev = hits.get(norm) || 0;
    if (r.count > prev) hits.set(norm, r.count);
    if (prev === 0) fresh++;
  }

  const sorted = [...hits.entries()]
    .map(([p, h]) => ({ path: p, hits: h }))
    .sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path))
    .slice(0, opts.cap);

  console.log(
    `📊 CF non-Ticino job 404s: ${rows.length} CF rows → ${hits.size} accumulated (${fresh} new this run), ` +
      `capped to ${sorted.length} (MAX ${opts.cap}, min-hits ${MIN_HITS}).`,
  );
  if (sorted.length) {
    console.log('   top:', sorted.slice(0, 3).map((x) => `${x.hits}×${x.path}`).join('  '));
  }

  if (opts.dryRun) {
    console.log('🧪 --dry-run: no write.');
    return;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'cloudflare',
    windowHours: 23.9,
    cap: opts.cap,
    minHits: MIN_HITS,
    paths: sorted,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`✅ Wrote ${OUT} (${sorted.length} paths).`);
}

main().catch((err) => {
  console.error(`❌ ${err?.message || err}`);
  process.exit(1);
});
