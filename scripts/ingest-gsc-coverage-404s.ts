#!/usr/bin/env tsx
/**
 * ingest-gsc-coverage-404s.ts
 *
 * Closes the discovery gap between Google Search Console's "Not found (404)"
 * Coverage report and the on-site 404-recovery pipeline.
 *
 * WHY THIS EXISTS
 * ---------------
 * GSC reports a cohort of URLs as `Non trovata (404)` (export: the
 * `Coverage-Drilldown/Tabella.csv` files under `download/`). These never
 * entered the recovery pipeline because:
 *   - `scripts/cf-status-report.mjs` (Cloudflare 404 collector) is REPORT-ONLY
 *     — it never writes any path list.
 *   - `scripts/discover-404s-via-inspection.mjs` only inspects URLs it ALREADY
 *     knows (tracking + previous slugs + existing compat paths), rotated and
 *     age-gated — it cannot discover a slug that is in none of those.
 *   - `scripts/sync-gsc-orphans.mjs` pulls GSC *Search Analytics*, which only
 *     returns URLs with >=1 impression; Coverage 404s typically have 0.
 * So a URL Google crawls and 404s on, but that has no search impressions and
 * is in no tracking file, is invisible to every existing job. The Coverage CSV
 * export IS that missing input — this script ingests it.
 *
 * WHAT IT DOES
 * ------------
 * 1. Reads every `Tabella.csv` under `download/frontaliereticino.ch-Coverage-*`
 *    (or a single file via `--csv <path>`).
 * 2. Normalises each URL to a path and resolves it through the shared
 *    `resolveSearchConsoleCompatTarget()` (the single source of truth for how a
 *    404 path maps to a canonical landing). Only source-backed mappings enter
 *    the bridge set; ambiguous/unknown paths remain in the `unresolved`
 *    diagnostic list — we never add junk that would itself 404.
 * 3. Writes the resolvable set to `data/gsc-coverage-404s.json` (BOUNDED — only
 *    the URLs Google actually reports as 404, a small slow-growing list). The
 *    `cfHot404BridgePlugin` reads this file as a second source (beside
 *    `data/cf-hot-404s.json`) and bridges every entry to its canonical landing
 *    — INCLUDING non-TI canton job paths that jobsSeoPagesPlugin's TI-only
 *    compat merge does not cover — under a hard emit cap + existsSync gap-fill.
 *    It stays bounded on purpose: bridging the full ~680k
 *    `seo-404-compat-paths.json` accumulator instead exploded the SSG build and
 *    OOM'd it (PR #2000, reverted #2031).
 * 4. With `--also-compat`, additionally merges the resolvable set into
 *    `data/seo-404-compat-paths.json` (the accumulator), so TI job paths get
 *    rich soft-landings via jobsSeoPagesPlugin instead of a thin bridge. Off by
 *    default to avoid rewriting the ~38 MB accumulator on every ingest (the
 *    discovery pipeline already feeds it). Guarded by the shared floor-guard so
 *    a degraded read can never truncate the accumulator.
 *
 * USAGE
 *   npx tsx scripts/ingest-gsc-coverage-404s.ts               # ingest all CSVs → coverage file
 *   npx tsx scripts/ingest-gsc-coverage-404s.ts --dry-run     # report only
 *   npx tsx scripts/ingest-gsc-coverage-404s.ts --csv path/to/Tabella.csv
 *   npx tsx scripts/ingest-gsc-coverage-404s.ts --also-compat # also merge into the accumulator
 *
 * Idempotent: re-running with the same input is a no-op (union + dedup).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  resolveSearchConsoleCompatTarget,
  type JobSlugCanonicalIndex,
  type SearchConsoleCompatResolution,
} from '../build-plugins/searchConsoleCompat';
import { readAllKnownJobSlugs } from './lib/all-known-job-slugs-store.mjs';
import { assertCompatFloor, COMPAT_PATHS_SANITY_FLOOR } from './lib/compat-paths-floor-guard.mjs';
import { readCompatPathsStrict, writeCompatPaths } from './lib/compat-paths-store.mjs';
import { gscOrphanPathKey, isAllowedGscOrphanUrl } from './lib/gsc-orphan-snapshot.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(__filename, '..', '..');
const DOWNLOADS_DIR = path.join(ROOT, 'download');
const COVERAGE_OUT = path.join(ROOT, 'data', 'gsc-coverage-404s.json');
// Sharded accumulator (issue #2988): use the store, never a single file.
const COMPAT_PATH = path.join(ROOT, 'data', 'seo-404-compat');

const DRY_RUN = process.argv.includes('--dry-run');
const ALSO_COMPAT = process.argv.includes('--also-compat');
const csvFlagIdx = process.argv.indexOf('--csv');
const CSV_OVERRIDE = csvFlagIdx >= 0 ? process.argv[csvFlagIdx + 1] : null;

// Bounded by construction: this is "URLs Google reports as 404", not the
// discovery accumulator. A GSC Coverage export caps at ~1000 rows; even
// accumulating many exports the realistic ceiling is low tens of thousands.
// A jump past this means a malformed export (e.g. an all-URLs sitemap) leaked
// in — abort rather than bloat the SSG bridge set toward cfHot's MAX_EMIT cap.
const COVERAGE_SANITY_CEILING = 50_000;

export type GscCoverageUnknownReason =
  | 'outside-gsc-property'
  | 'invalid-path'
  | 'ambiguous-routing'
  | 'no-demonstrated-destination'
  | 'unsafe-destination';

export type GscCoveragePathClassification =
  | {
      kind: 'compat' | 'redirect';
      path: string;
      canonicalPath: string;
      resolution: SearchConsoleCompatResolution;
    }
  | {
      kind: 'unknown';
      path: string | null;
      reason: GscCoverageUnknownReason;
    };

function normalizePath(input: string): string {
  const clean = `/${String(input || '').trim().replace(/^\/+/, '')}`.replace(/\/+/g, '/');
  if (clean === '/') return clean;
  return clean.replace(/\/$/, '');
}

function findCsvFiles(): { file: string; basename: string }[] {
  if (CSV_OVERRIDE) {
    if (!fs.existsSync(CSV_OVERRIDE)) {
      console.error(`[ingest-gsc-coverage] --csv file not found: ${CSV_OVERRIDE}`);
      process.exit(1);
    }
    return [{ file: CSV_OVERRIDE, basename: path.basename(path.dirname(CSV_OVERRIDE)) }];
  }
  if (!fs.existsSync(DOWNLOADS_DIR)) return [];
  const out: { file: string; basename: string }[] = [];
  for (const entry of fs.readdirSync(DOWNLOADS_DIR)) {
    if (!entry.startsWith('frontaliereticino.ch-Coverage-')) continue;
    const csv = path.join(DOWNLOADS_DIR, entry, 'Tabella.csv');
    if (fs.existsSync(csv)) out.push({ file: csv, basename: entry });
  }
  return out;
}

/** Rows in the GSC export, excluding the header. */
function csvDataRowCount(file: string): number {
  return fs.readFileSync(file, 'utf-8').split(/\r?\n/).slice(1).filter((l) => l.trim()).length;
}

function parseCsvUrls(file: string): string[] {
  const text = fs.readFileSync(file, 'utf-8');
  const out: string[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    // First field is the URL. Tolerate a quoted field ("https://…",…) — GSC
    // exports the URL unquoted today, but a future quoting/escaping change must
    // not silently drop every row (caught loudly by the zero-yield guard in main).
    const url = (line.split(',')[0] ?? '').trim().replace(/^"|"$/g, '');
    if (!url || !/^https?:\/\//i.test(url)) continue;
    try { new URL(url); } catch { continue; }
    out.push(url);
  }
  return out;
}

function parseCoveragePath(input: string):
  | { path: string }
  | { path: null; reason: 'outside-gsc-property' | 'invalid-path' } {
  const value = String(input || '').trim();
  if (!value) return { path: null, reason: 'invalid-path' };

  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { path: null, reason: 'invalid-path' };
    }
    if (!isAllowedGscOrphanUrl(value)) return { path: null, reason: 'outside-gsc-property' };
    try {
      return { path: normalizePath(gscOrphanPathKey(url.pathname)) };
    } catch {
      return { path: null, reason: 'invalid-path' };
    }
  }

  if (!value.startsWith('/')) return { path: null, reason: 'invalid-path' };
  try {
    return { path: normalizePath(gscOrphanPathKey(value)) };
  } catch {
    return { path: null, reason: 'invalid-path' };
  }
}

function safeCanonicalPath(input: string): string | null {
  try {
    return gscOrphanPathKey(input);
  } catch {
    return null;
  }
}

/**
 * Build the resolver's localized-slug index from the authoritative registry.
 * The registry is keyed by its canonical slug, while GSC paths carry the
 * localized slug as their final segment (which can differ by locale).
 */
export function buildJobSlugCanonicalIndex(
  tracking: unknown,
): JobSlugCanonicalIndex | undefined {
  const slugCanonical = new Map<string, Partial<Record<'it' | 'en' | 'de' | 'fr', string>>>();
  if (!tracking || typeof tracking !== 'object') return undefined;

  for (const entry of Object.values(tracking as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const localizedPath = (entry as Record<string, unknown>)[locale];
      if (typeof localizedPath !== 'string' || !localizedPath) continue;
      const localizedSlug = localizedPath.replace(/\/+$/, '').split('/').pop();
      if (localizedSlug && !slugCanonical.has(localizedSlug)) {
        slugCanonical.set(localizedSlug, entry as Partial<Record<'it' | 'en' | 'de' | 'fr', string>>);
      }
    }
  }

  return slugCanonical.size > 0 ? slugCanonical : undefined;
}

function loadJobSlugCanonicalIndex(rootDir: string): JobSlugCanonicalIndex | undefined {
  try {
    return buildJobSlugCanonicalIndex(readAllKnownJobSlugs(rootDir));
  } catch {
    // A missing or unreadable ledger must preserve the resolver's conservative
    // listing fallback; it must never turn an unverified route into a target.
    return undefined;
  }
}

/**
 * Classify a Coverage URL before it can enter either compatibility store.
 *
 * The normal resolver intentionally has conservative section/job fallbacks for
 * bridge consumers that can verify the emitted target on disk. Ingestion has
 * no dist snapshot, so it asks for source-backed mappings only: explicit
 * aliases, emitted registries, known route families, or a supplied job
 * identity. A path-shaped fallback is therefore retained as `unknown` instead
 * of becoming an invented redirect.
 */
export function classifyUnresolvedCoveragePath(
  input: string,
  slugIndex?: JobSlugCanonicalIndex,
): GscCoveragePathClassification {
  const parsed = parseCoveragePath(input);
  if ('reason' in parsed) return { kind: 'unknown', path: null, reason: parsed.reason };

  const pathKey = parsed.path;
  const resolution = resolveSearchConsoleCompatTarget(pathKey, slugIndex, { sourceBackedOnly: true });
  if (!resolution) {
    // Keep the distinction observable: a normal resolver match that strict
    // mode rejects is ambiguous, while a null normal match is simply unknown.
    const routeShapedCandidate = resolveSearchConsoleCompatTarget(pathKey, slugIndex);
    return {
      kind: 'unknown',
      path: pathKey,
      reason: routeShapedCandidate ? 'ambiguous-routing' : 'no-demonstrated-destination',
    };
  }

  const canonicalPath = safeCanonicalPath(resolution.canonicalPath);
  if (!canonicalPath) {
    return { kind: 'unknown', path: pathKey, reason: 'unsafe-destination' };
  }

  const canonicalKey = normalizePath(canonicalPath);
  return {
    kind: canonicalKey === pathKey ? 'compat' : 'redirect',
    path: pathKey,
    canonicalPath,
    resolution,
  };
}

function readPaths(file: string): string[] {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(j?.paths) ? j.paths.map((p: unknown) => String(p)) : [];
  } catch {
    return [];
  }
}

function main(): void {
  const csvs = findCsvFiles();
  if (csvs.length === 0) {
    console.log('[ingest-gsc-coverage] No Coverage CSV files found — nothing to do.');
    return;
  }

  const seen = new Set<string>();
  const byKind: Record<string, number> = {};
  let totalRows = 0;
  let rawDataRows = 0;
  const unresolved: Array<Extract<GscCoveragePathClassification, { kind: 'unknown' }>> = [];
  const byClassification: Record<string, number> = {};
  const slugIndex = loadJobSlugCanonicalIndex(ROOT);

  for (const { file, basename } of csvs) {
    rawDataRows += csvDataRowCount(file);
    const urls = parseCsvUrls(file);
    let resolved = 0;
    for (const url of urls) {
      totalRows++;
      const classification = classifyUnresolvedCoveragePath(url, slugIndex);
      byClassification[classification.kind] = (byClassification[classification.kind] || 0) + 1;
      if (classification.kind === 'unknown') { unresolved.push(classification); continue; }
      byKind[classification.resolution.kind] = (byKind[classification.resolution.kind] || 0) + 1;
      seen.add(classification.path);
      resolved++;
    }
    console.log(`[ingest-gsc-coverage] ${basename}: ${urls.length} URL rows (${csvDataRowCount(file)} data rows) → ${resolved} source-backed`);
  }

  // Loud-fail on a silent format break: data rows present but nothing parsed as
  // a URL means the URL column moved or the quoting changed — never write an
  // empty/degraded coverage file on top of a working one.
  if (rawDataRows > 0 && totalRows === 0) {
    throw new Error(
      `[ingest-gsc-coverage] ${rawDataRows} data rows but 0 parsed as URLs — ` +
        `CSV format likely changed (URL column moved / quoting). Aborting, not overwriting.`,
    );
  }

  console.log(
    `[ingest-gsc-coverage] ${totalRows} total rows | ${seen.size} resolvable unique | ` +
      `${unresolved.length} unknown (left as 404)`,
  );
  console.log(`[ingest-gsc-coverage] kinds: ${JSON.stringify(byKind)}`);
  console.log(`[ingest-gsc-coverage] classifications: ${JSON.stringify(byClassification)}`);
  if (unresolved.length > 0) {
    console.log('[ingest-gsc-coverage] sample unknown:');
    for (const u of unresolved.slice(0, 10)) console.log(`  ${u.path ?? '(not a local path)'} [${u.reason}]`);
  }

  // Merge into the bounded coverage file.
  const prevCoverage = readPaths(COVERAGE_OUT);
  const coverageUnion = Array.from(new Set([...prevCoverage.map(normalizePath), ...seen])).sort();
  if (coverageUnion.length > COVERAGE_SANITY_CEILING) {
    throw new Error(
      `[ingest-gsc-coverage] refusing to write ${coverageUnion.length} coverage paths ` +
        `(> ceiling ${COVERAGE_SANITY_CEILING}). Malformed CSV export?`,
    );
  }

  console.log(
    `[ingest-gsc-coverage] coverage file: ${prevCoverage.length} → ${coverageUnion.length} ` +
      `(+${coverageUnion.length - prevCoverage.length})`,
  );

  // Optionally merge into the accumulator (floor-guarded).
  let prevCompat: string[] = [];
  let compatUnion: string[] = [];
  if (ALSO_COMPAT) {
    prevCompat = readCompatPathsStrict(ROOT).paths.map((p) => String(p));
    // Use coverageUnion (full accumulated coverage set) not just `seen` (current CSV batch):
    // on subsequent runs without new CSVs the existing 999 coverage paths would otherwise
    // be silently skipped, leaving TI paths without rich soft-landings.
    compatUnion = Array.from(new Set([...prevCompat.map(normalizePath), ...coverageUnion])).sort();
    assertCompatFloor(prevCompat.length, compatUnion.length, { floor: COMPAT_PATHS_SANITY_FLOOR });
    console.log(
      `[ingest-gsc-coverage] compat accumulator: ${prevCompat.length} → ${compatUnion.length} ` +
        `(+${compatUnion.length - prevCompat.length})`,
    );
  }

  if (DRY_RUN) {
    console.log('[ingest-gsc-coverage] --dry-run: no files written.');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(
    COVERAGE_OUT,
    JSON.stringify(
      {
        paths: coverageUnion,
        unresolved,
        source: 'gsc-coverage-drilldown',
        lastUpdated: today,
      },
      null,
      2,
    ) + '\n',
  );
  let wrote = 'data/gsc-coverage-404s.json';
  if (ALSO_COMPAT) {
    // Preserve any extra metadata keys on the compat store (source/lastUpdated).
    const existing = readCompatPathsStrict(ROOT);
    const { paths: _ignored, ...compatMeta } = existing as Record<string, unknown> & { paths?: unknown };
    if (!compatMeta.source) compatMeta.source = 'gsc-export+url-inspection';
    writeCompatPaths({ ...compatMeta, paths: compatUnion, lastUpdated: today }, ROOT);
    wrote += ' + data/seo-404-compat/';
  }
  console.log(`[ingest-gsc-coverage] wrote ${wrote}`);
}

if (process.argv[1] && (() => {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})()) {
  main();
}
