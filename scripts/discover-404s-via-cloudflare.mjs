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
 * Windowed sweep (not a single query): a single httpRequestsAdaptiveGroups
 * query caps at 10k rows ordered by count_DESC, so a plain 23h-in-one-call
 * sweep silently truncates the long tail of real content 404s past the
 * 10,000 hottest paths — every single day, forever (confirmed via 8
 * consecutive days of workflow run logs all saturating at exactly 10,000
 * rows, while the same window swept with sweepErrorPathsWindowed surfaces
 * 4-6x more distinct paths). Uses the shared helper
 * (scripts/lib/cf-analytics.mjs, also used by build-cf-hot-404s.mjs, AGENTS.md
 * #6) that sums per-path counts across many narrow contiguous windows instead
 * of one capped query.
 *
 * Usage:
 *   node scripts/load-rc-env.mjs && node scripts/discover-404s-via-cloudflare.mjs
 *   node scripts/discover-404s-via-cloudflare.mjs --dry-run
 *   node scripts/discover-404s-via-cloudflare.mjs --windows=48 --window-hours=1
 *   node scripts/discover-404s-via-cloudflare.mjs --hours=23   # legacy alias,
 *     reinterpreted as total lookback (windowCount = ceil(hours/windowHours))
 *
 * Environment (required): CF_API_TOKEN (Zone→Analytics→Read). Optional:
 *   CF_ZONE_ID, CF_ZONE_NAME (defaults to frontaliereticino.ch).
 *   CF_SWEEP_WINDOW_HOURS, CF_SWEEP_WINDOWS (same knobs as
 *   build-cf-hot-404s.mjs, kept consistent across both consumers).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCompatFloor, COMPAT_PATHS_SANITY_FLOOR } from './lib/compat-paths-floor-guard.mjs';
import { readCompatPaths, writeCompatPaths, COMPAT_SHARD_DIR } from './lib/compat-paths-store.mjs';
import { sweepErrorPathsWindowed, resolveZoneId, DEFAULT_ZONE_NAME } from './lib/cf-analytics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// Sharded accumulator (issue #2988): logical {paths} spread across
// COMPAT_SHARD_DIR/part-*.json. Use the store helpers, never a single file.
const COMPAT_PATH = COMPAT_SHARD_DIR;

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
  //
  // windowHours/windowCount mirror build-cf-hot-404s.mjs's knobs (same shared
  // sweepErrorPathsWindowed helper + same env vars) so both CF sweeps default
  // to the same ~48h/1h-window coverage instead of drifting independently.
  const opts = {
    dryRun: false,
    windowHours: Number(process.env.CF_SWEEP_WINDOW_HOURS || 1),
    windowCount: Number(process.env.CF_SWEEP_WINDOWS || 48),
    minCount: 2,
  };
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'dry-run') opts.dryRun = true;
    else if (key === 'window-hours') opts.windowHours = Number(val);
    else if (key === 'windows') opts.windowCount = Number(val);
    // Legacy alias: --hours used to size the (single, capped) query window.
    // Reinterpreted as total lookback hours at the current windowHours
    // granularity, so old invocations keep working with the same intent
    // (sweep "the last N hours") instead of silently being ignored.
    else if (key === 'hours') opts.windowCount = Math.max(1, Math.ceil(Number(val) / opts.windowHours));
    else if (key === 'min-count') opts.minCount = Number(val);
  }
  return opts;
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
  //
  // Windowed, not a single capped query (see file header): a lone query tops
  // out at 10k rows and silently drops the long tail of real content 404s
  // past that. sweepErrorPathsWindowed sums per-path counts across
  // opts.windowCount narrow windows so paths outside any one window's top-10k
  // still surface.
  const { rows, windowsOk } = await sweepErrorPathsWindowed(token, zoneId, {
    windowHours: opts.windowHours,
    windowCount: opts.windowCount,
    minStatus: 404,
    maxStatus: 404,
    host: APEX_HOST,
  });
  console.log(
    `🛰️  Swept ${windowsOk}/${opts.windowCount} × ${opts.windowHours}h windows → ${rows.length} distinct 404 paths.`,
  );

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

  const compat = readCompatPaths(ROOT);
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

  // Floor-guard (shared helper): the compat accumulator is a ~390k-path set;
  // a degraded empty read must never overwrite it. Adding paths only grows the
  // set, so this fires only if the on-disk read silently collapsed.
  const prevCount = readCompatPaths(ROOT).paths?.length ?? 0;
  assertCompatFloor(prevCount, updated.paths.length, {
    floor: COMPAT_PATHS_SANITY_FLOOR,
    label: COMPAT_PATH,
  });

  writeCompatPaths(updated, ROOT);
  console.log(`✅ Wrote ${COMPAT_PATH} (${updated.paths.length} total paths, +${added}).`);
  console.log('   Run prune-404-compat-paths.ts next to drop non-resolving paths before commit.');
}

main().catch((err) => {
  console.error(`❌ ${err?.message || err}`);
  process.exit(1);
});
