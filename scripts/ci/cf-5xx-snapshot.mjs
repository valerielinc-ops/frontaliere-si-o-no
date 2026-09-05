#!/usr/bin/env node
/**
 * cf-5xx-snapshot.mjs — persist a classified daily 5xx snapshot, so this zone's error
 * history outlives Cloudflare's retention.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────────────
 * The free plan keeps httpRequestsAdaptiveGroups for ~3 days, and cf-5xx-monitor.yml ran
 * with `contents: read` — it filed issues and kept nothing. Three consequences, all hit
 * for real on 2026-08-05 while trying to judge whether a mitigation had worked:
 *
 *   1. No baseline. "Is this better than last week?" was unanswerable, because last week
 *      no longer existed. An observational closure criterion ("no new 5xx across two
 *      deploy windows") cannot be evaluated against data that expires before the window.
 *   2. No surface split. Every 5xx carried one label, so a CDN-only mitigation looked like
 *      it covered apex 503s it could never touch (see cf-error-surface.mjs).
 *   3. No way to see WHY. Without originResponseStatus/cacheStatus, "R2 is flaky" and
 *      "R2 answered 502" and "there was no cached copy to fall back on" are the same row.
 *
 * This script closes all three: one JSON line per run, appended to
 * data/cf-5xx-history.jsonl, carrying hourly buckets, the origin/cache breakdown, and the
 * per-surface split. Small enough to keep unpruned (a few kB/day), which matters — the
 * whole point is the long baseline.
 *
 * ─── Reading it back ────────────────────────────────────────────────────────────────
 *   node scripts/ci/cf-5xx-snapshot.mjs --report          # trend across all snapshots
 *   node scripts/ci/cf-5xx-snapshot.mjs --report --json   # same, machine-readable
 *
 * ─── Auth ───────────────────────────────────────────────────────────────────────────
 * CF_API_TOKEN (Zone -> Analytics -> Read), from Firebase Remote Config via
 * scripts/load-rc-env.mjs — same mechanism as cf-status-report.mjs. CF_ZONE_ID optional.
 *
 * PROCEED-SAFE, like the other CF tooling: this is a recorder, not a gate. Any API/parse
 * fault prints a warning and exits 0 rather than failing the workflow that carries it — a
 * missing sample is a hole in a chart, a red workflow is noise that gets muted.
 *
 * Env:
 *   CF_API_TOKEN             required for collection (not for --report)
 *   CF_ZONE_ID               optional, else resolved from the zone name
 *   CF_5XX_HISTORY_FILE      optional, default data/cf-5xx-history.jsonl
 *                        (in CI richiede CF_5XX_HISTORY_FILE_ALLOW_CI=1)
 *   CF_5XX_SNAPSHOT_HOURS    optional, default 23
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOutputPath } from '../lib/resolve-output-path.mjs';
import {
  resolveZoneId,
  fetchErrorDiagnostics,
  fetchErrorPaths,
  DEFAULT_ZONE_NAME,
} from '../lib/cf-analytics.mjs';
import {
  classifySurface,
  isSynthesizedByEdge,
  couldServeStaleHaveHelped,
  CACHE_HAD_COPY,
} from '../lib/cf-error-surface.mjs';
import { intFromEnv } from '../lib/int-from-env.mjs';

const DEFAULT_HISTORY_FILE = 'data/cf-5xx-history.jsonl';
/** Top offending URLs kept per snapshot. Enough to spot a pattern, small enough to keep forever. */
const TOP_PATHS = 15;

// ── Pure helpers (exported for tests) ────────────────────────────────────────────────

/**
 * Fold the hourly diagnostic rows into the shape worth keeping.
 *
 * `byHour` is the part that answers the deploy-window question: a flat total per hour, which
 * can be overlaid on workflow run times after the fact without re-querying anything.
 *
 * @param {Array<{hour:string,edgeStatus:number,originStatus:number|null,cacheStatus:string|null,host:string,count:number}>} rows
 */
export function summarizeDiagnostics(rows) {
  const byHour = {};
  const byStatus = {};
  const byHost = {};
  const byCacheStatus = {};
  const byHostStatusCache = {};
  let total = 0;
  let synthesized = 0;
  let rescuable = 0; // on a serve_stale surface AND a cached copy existed

  for (const r of rows || []) {
    const n = Number(r?.count) || 0;
    if (n <= 0) continue;
    total += n;
    byHour[r.hour] = (byHour[r.hour] || 0) + n;
    byStatus[r.edgeStatus] = (byStatus[r.edgeStatus] || 0) + n;
    byHost[r.host] = (byHost[r.host] || 0) + n;
    const cache = r.cacheStatus == null ? 'unknown' : String(r.cacheStatus);
    byCacheStatus[cache] = (byCacheStatus[cache] || 0) + n;
    // The CROSS-TAB, not a fourth marginal. The three above answer "how many 5xx", "on which
    // host" and "with which cache outcome" separately — and separately they cannot answer the
    // one question that actually decides the next move: *which surface* had a servable copy.
    // That gap cost a live GraphQL query to resolve by hand on 2026-08-06, and it is the
    // question the reopened #5082 turns on: 175 of 443 5xx carried `cache=hit`, all of them on
    // the apex rules where serve_stale is NOT configured, while every CDN 5xx (where it IS
    // configured) carried `cache=none`. Cardinality stays trivial — a handful of hosts times a
    // handful of statuses times a handful of cache outcomes.
    const xtab = `${r.host}|${r.edgeStatus}|${cache}`;
    byHostStatusCache[xtab] = (byHostStatusCache[xtab] || 0) + n;
    if (isSynthesizedByEdge(r)) synthesized += n;
    // Host alone is enough to know whether the surface has serve_stale: only the CDN does.
    if (couldServeStaleHaveHelped({ surface: classifySurface({ host: r.host }), cacheStatus: r.cacheStatus })) {
      rescuable += n;
    }
  }

  return {
    total,
    // Share of 5xx that Cloudflare invented because the origin said nothing at all. A drop
    // here means the origin got healthier; a drop in `total` alone might just be less traffic.
    synthesized,
    // Of the 5xx on a serve_stale surface, how many had a cached copy that could have been
    // served instead. If this stays ~0 while 5xx persist, serve_stale is not the lever.
    staleRescuable: rescuable,
    byHour,
    byStatus,
    byHost,
    byCacheStatus,
    // Keyed "<host>|<edgeStatus>|<cacheStatus>". Kept alongside the marginals rather than
    // replacing them so the single history line written before this existed stays readable.
    byHostStatusCache,
  };
}

/**
 * Split the path-level rows by surface, and keep the worst offenders.
 *
 * The path query is what makes the apex split possible at all — the hourly one has no path,
 * so it can only say "apex", never "shard vs Pages".
 *
 * @param {Array<{status:number,host:string,path:string,count:number}>} rows
 */
export function summarizeSurfaces(rows) {
  const bySurface = {};
  const flat = [];
  for (const r of rows || []) {
    const n = Number(r?.count) || 0;
    if (n <= 0) continue;
    const surface = classifySurface({ host: r.host, path: r.path });
    const bucket = (bySurface[surface] ||= { total: 0, byStatus: {} });
    bucket.total += n;
    bucket.byStatus[r.status] = (bucket.byStatus[r.status] || 0) + n;
    flat.push({ surface, status: r.status, url: `${r.host}${r.path}`, count: n });
  }
  flat.sort((a, b) => b.count - a.count);
  return { bySurface, topPaths: flat.slice(0, TOP_PATHS) };
}

/**
 * Build the record that gets appended. Kept flat and self-describing: whoever reads this in
 * six months has no access to the code that wrote it, only the line.
 */
export function buildSnapshot({ diagnostics, paths, windowHours, until, zoneName }) {
  const diag = summarizeDiagnostics(diagnostics);
  const surf = summarizeSurfaces(paths);
  return {
    ts: new Date(until).toISOString(),
    windowHours,
    zone: zoneName,
    total5xx: diag.total,
    synthesized5xx: diag.synthesized,
    staleRescuable5xx: diag.staleRescuable,
    byStatus: diag.byStatus,
    byHost: diag.byHost,
    byCacheStatus: diag.byCacheStatus,
    byHostStatusCache: diag.byHostStatusCache,
    byHour: diag.byHour,
    bySurface: surf.bySurface,
    topPaths: surf.topPaths,
  };
}

/** Append one snapshot line. Creates the file and its directory on first run. */
export function appendSnapshot(file, record) {
  const dir = path.dirname(file);
  if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/**
 * Read the history back.
 *
 * A malformed line is SKIPPED, not fatal: this file is append-only and grows forever, and a
 * single truncated write (a runner killed mid-append) must not make every future report
 * unreadable.
 */
export function loadHistory(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip: see docblock */
    }
  }
  return out;
}

/** Human-readable trend across snapshots — the thing you actually want when triaging. */
export function renderReport(history) {
  if (!history.length) return 'Nessuno snapshot ancora registrato.';
  const lines = [];
  lines.push(`Snapshot registrati: ${history.length}  (dal ${history[0].ts} al ${history[history.length - 1].ts})`);
  lines.push('');
  lines.push('  data                 tot   sint.  salvab.  per superficie');
  for (const s of history.slice(-30)) {
    const surfaces = Object.entries(s.bySurface || {})
      .sort((a, b) => b[1].total - a[1].total)
      .map(([k, v]) => `${k}=${v.total}`)
      .join(' ');
    lines.push(
      `  ${String(s.ts).slice(0, 16).padEnd(18)} ${String(s.total5xx).padStart(5)} ${String(s.synthesized5xx).padStart(6)} ${String(s.staleRescuable5xx).padStart(8)}  ${surfaces}`,
    );
  }
  const last = history[history.length - 1];
  // The line that answers "would serve_stale have helped, and WHERE" at a glance. A 5xx with a
  // cache outcome that implies a servable copy, on a surface without serve_stale, is the
  // population worth acting on — see the reopened #5082.
  if (last?.byHostStatusCache && Object.keys(last.byHostStatusCache).length) {
    lines.push('');
    lines.push('Ultimo snapshot, incrocio host x status x cache (una copia servibile esisteva?):');
    const rows = Object.entries(last.byHostStatusCache).sort((a, b) => b[1] - a[1]);
    for (const [key, n] of rows.slice(0, 12)) {
      const [host, status, cache] = key.split('|');
      const servable = CACHE_HAD_COPY.has(cache);
      lines.push(`  ${host.padEnd(28)} ${status}  ${cache.padEnd(11)} ${String(n).padStart(5)}${servable ? '   <- copia servibile' : ''}`);
    }
  }
  if (last?.byHour && Object.keys(last.byHour).length) {
    lines.push('');
    lines.push('Ultimo snapshot, 5xx per ora (confronta con gli orari dei run di deploy.yml):');
    for (const [h, n] of Object.entries(last.byHour).sort()) {
      lines.push(`  ${h}  ${'#'.repeat(Math.min(60, n))} ${n}`);
    }
  }
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = new Set(process.argv.slice(2));
  // Stessa classe di GSC_ORPHAN_CLUSTERS_OUT (issue #7291): default tracciato,
  // override d'ambiente altrimenti invisibile.
  const historyFile = resolveOutputPath({
    label: 'cf-5xx-snapshot',
    envVar: 'CF_5XX_HISTORY_FILE',
    canonicalPath: DEFAULT_HISTORY_FILE,
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
  });

  if (args.has('--report')) {
    const history = loadHistory(historyFile);
    console.log(args.has('--json') ? JSON.stringify(history, null, 2) : renderReport(history));
    return;
  }

  const token = process.env.CF_API_TOKEN;
  if (!token) {
    console.warn('⚠️  CF_API_TOKEN assente — snapshot saltato (nessun errore: è un registratore, non un gate).');
    return;
  }
  const hours = intFromEnv('CF_5XX_SNAPSHOT_HOURS', 23);
  const until = new Date();

  const zoneId = await resolveZoneId(token, DEFAULT_ZONE_NAME, process.env.CF_ZONE_ID);
  const [diagnostics, paths] = await Promise.all([
    fetchErrorDiagnostics(token, zoneId, { hours, until }),
    fetchErrorPaths(token, zoneId, { hours, until, minStatus: 500 }),
  ]);

  const record = buildSnapshot({ diagnostics, paths, windowHours: hours, until, zoneName: DEFAULT_ZONE_NAME });
  appendSnapshot(historyFile, record);

  console.log(`✅ snapshot registrato in ${historyFile}`);
  console.log(`   5xx totali: ${record.total5xx}  (sintetizzati dall'edge: ${record.synthesized5xx})`);
  console.log(`   con copia in cache servibile da serve_stale: ${record.staleRescuable5xx}`);
  for (const [surface, v] of Object.entries(record.bySurface).sort((a, b) => b[1].total - a[1].total)) {
    console.log(`   ${surface.padEnd(14)} ${v.total}`);
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('cf-5xx-snapshot.mjs');
if (invokedDirectly) {
  main().catch((err) => {
    // PROCEED-SAFE: see docblock.
    console.warn(`⚠️  snapshot 5xx fallito (non fatale): ${err?.message || err}`);
  });
}
