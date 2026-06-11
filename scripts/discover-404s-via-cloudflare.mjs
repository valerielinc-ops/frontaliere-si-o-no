#!/usr/bin/env node
/**
 * discover-404s-via-cloudflare.mjs
 *
 * Third producer for the `data/seo-404-compat-paths.json` accumulator, beside
 * the two GSC-based ones (sync-gsc-orphans.mjs, discover-404s-via-inspection.mjs).
 *
 * Why Cloudflare as a source: GSC's Search Analytics only returns URLs with ≥1
 * impression and its URL Inspection API only tells us about URLs we already
 * suspect. Cloudflare edge analytics, by contrast, records EVERY real 404 hit
 * at the edge — human + bot, including zero-impression long-tail URLs GSC never
 * surfaces — with no GSC quota. Feeding those paths into the same accumulator
 * lets the build emit a reconciled soft-landing / bridge page at each, exactly
 * like the GSC producers.
 *
 * Pipeline parity: this script only APPENDS candidate paths. The workflow then
 * runs `prune-404-compat-paths.ts`, which drops every path the resolver
 * (`resolveSearchConsoleCompatTarget`) can't map — so the committed-snapshot
 * test (`tests/search-console-compat.test.ts`) stays green. Same gate as the
 * GSC producers; do NOT commit this file without running the prune step.
 *
 * Usage:
 *   node scripts/load-rc-env.mjs && node scripts/discover-404s-via-cloudflare.mjs
 *   node scripts/discover-404s-via-cloudflare.mjs --dry-run
 *   node scripts/discover-404s-via-cloudflare.mjs --hours=23 --limit=10000
 *
 * Environment (required): CF_API_TOKEN (Zone→Analytics→Read). Optional:
 *   CF_ZONE_ID, CF_ZONE_NAME (defaults to frontaliereticino.ch).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCompatFloor, COMPAT_PATHS_SANITY_FLOOR } from './lib/compat-paths-floor-guard.mjs';
import { fetchErrorPaths, resolveZoneId, DEFAULT_ZONE_NAME } from './lib/cf-analytics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COMPAT_PATH = path.join(ROOT, 'data', 'seo-404-compat-paths.json');

// Only the apex serves reconcilable content pages. www/t/cdn subdomains have
// their own concerns (redirects, analytics proxy, asset host) and must not leak
// into the compat accumulator.
const APEX_HOST = process.env.CF_ZONE_NAME || DEFAULT_ZONE_NAME;

// Skip static-asset and infra 404s — the resolver only maps content/job URLs,
// so assets would just be dropped by the prune step anyway (and a missing
// asset is a different bug class, tracked separately e.g. brand logos #1744).
const ASSET_RX = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|map|json|xml|txt|webmanifest|woff2?|ttf|eot|pdf)$/i;
const INFRA_PREFIX_RX = /^\/(?:cdn-cgi|assets|images|og|data|static|\.well-known)\//;

function parseArgs(argv) {
  // minCount=2 drops one-hit noise: real expired/indexed URLs get repeated
  // hits from Google + returning visitors, whereas random bot path-probes are
  // typically one-shot. Without this floor the sweep would feed thousands of
  // throwaway bot URLs into the accumulator → needless bridge pages → dist
  // bloat (against the dist-shrink program). prune + resolver still gate
  // resolvability on top of this.
  const opts = { dryRun: false, hours: 23, limit: 10000, minCount: 2 };
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'dry-run') opts.dryRun = true;
    else if (key === 'hours') opts.hours = Number(val);
    else if (key === 'limit') opts.limit = Number(val);
    else if (key === 'min-count') opts.minCount = Number(val);
  }
  return opts;
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Keep only content paths the reconciler could plausibly map. */
function isCandidate(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return false;
  if (p === '/') return false;
  if (ASSET_RX.test(p)) return false;
  if (INFRA_PREFIX_RX.test(p)) return false;
  return true;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = process.env.CF_API_TOKEN;
  if (!token) {
    console.error(
      '❌ CF_API_TOKEN not set. Run `node scripts/load-rc-env.mjs` first ' +
        '(or export it). Needs Zone→Analytics→Read.',
    );
    process.exit(1);
  }

  const zoneId = await resolveZoneId(token, APEX_HOST, process.env.CF_ZONE_ID);

  // Pull ONLY status-404 hits on the apex over the retained window. The bound
  // is exact (min=max=404): a `>= 404` filter would also sweep in 5xx — e.g.
  // the intermittent shard 504s on LIVE /en /de /fr pages — and feeding those
  // into the 404 reconciler would emit bridge/redirect pages for working pages.
  const rows = await fetchErrorPaths(token, zoneId, {
    hours: opts.hours,
    minStatus: 404,
    maxStatus: 404,
    host: APEX_HOST,
    limit: opts.limit,
  });

  // Normalize → candidate set (dedup, trailing-slash-stripped to match the
  // accumulator's convention used by the GSC producers).
  const candidates = new Set();
  let skipped = 0;
  let lowCount = 0;
  for (const r of rows) {
    if (r.count < opts.minCount) { lowCount++; continue; }
    const norm = r.path.replace(/\/+$/, '');
    if (isCandidate(norm)) candidates.add(norm);
    else skipped++;
  }

  console.log(
    `📊 Cloudflare 404 sweep: ${rows.length} distinct 404 paths → ` +
      `${candidates.size} content candidates ` +
      `(${skipped} asset/infra, ${lowCount} below min-count=${opts.minCount} skipped).`,
  );

  const compat = readJsonSafe(COMPAT_PATH, { paths: [] });
  const compatSet = new Set(Array.isArray(compat.paths) ? compat.paths : []);
  const before = compatSet.size;
  for (const p of candidates) compatSet.add(p);
  const added = compatSet.size - before;

  console.log(`🔎 ${added} new path(s) not already in compat (had ${before}).`);

  if (opts.dryRun) {
    console.log('🧪 --dry-run: no write.');
    return;
  }
  if (added === 0) {
    console.log('✅ No new paths — compat unchanged.');
    return;
  }

  const updated = {
    ...compat,
    paths: [...compatSet].sort(),
    source: (compat.source || 'gsc-export').includes('cloudflare')
      ? compat.source
      : `${compat.source || 'gsc-export'}+cloudflare`,
    lastUpdated: new Date().toISOString().slice(0, 10),
  };

  // Floor-guard (shared helper): the compat file is a ~390k-path accumulator;
  // a degraded empty read must never overwrite it. Adding paths only grows the
  // set, so this fires only if the on-disk read silently collapsed.
  const prevCount = readJsonSafe(COMPAT_PATH, { paths: [] }).paths?.length ?? 0;
  assertCompatFloor(prevCount, updated.paths.length, {
    floor: COMPAT_PATHS_SANITY_FLOOR,
    label: COMPAT_PATH,
  });

  fs.writeFileSync(COMPAT_PATH, JSON.stringify(updated, null, 2) + '\n');
  console.log(`✅ Wrote ${COMPAT_PATH} (${updated.paths.length} total paths, +${added}).`);
  console.log('   Run prune-404-compat-paths.ts next to drop non-resolving paths before commit.');
}

main().catch((err) => {
  console.error(`❌ ${err?.message || err}`);
  process.exit(1);
});
