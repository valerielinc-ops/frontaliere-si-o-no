#!/usr/bin/env node
/**
 * report-orphan-reconciliation.mjs — does `sync-gsc-orphans` actually reconcile
 * anything, or is it just green?
 *
 * WHY THIS EXISTS (issue #4248)
 * -----------------------------
 * From 2026-07-17 the workflow failed on every run because the push carried two
 * blobs over GitHub's hard 100 MB limit (GH001). The failure was loud — a red
 * badge, a recurrence comment on #4248 every few hours — but what it COST was
 * invisible: the pipeline still ran, still discovered orphans, still computed
 * every soft-landing path, and then threw all of it away when `git push` was
 * rejected. `main` never learned about a single new orphan for three weeks, so
 * every URL Search Console reported as a 404 kept 404-ing.
 *
 * The dangerous shape of the fix is therefore not "still red" — it is "green
 * again, reconciling nothing", which no badge anywhere would show. This report
 * exists to make that state impossible to miss, by measuring the one thing the
 * red badge never did: how much of what this run computed is actually reaching
 * `main`.
 *
 * WHAT IT MEASURES
 * ----------------
 * Run it AFTER the pipeline has written its data and BEFORE the commit step, so
 * the working tree holds "what we just computed" and `HEAD` holds "what the site
 * currently serves". The gap between the two is the backlog:
 *
 *   pendingSlugs        orphan slugs whose soft-landing path this run computed
 *                       but `main` does not have yet
 *   pendingImpressions  Search Console impressions those URLs are getting —
 *                       i.e. traffic landing on a 404 right now
 *
 * A healthy run: `pending*` is small (only the orphans discovered since the last
 * run) and the history shows it staying small. A run after the push has been
 * broken: `pending*` is enormous, because nothing has landed since it broke.
 * A green workflow that reconciles nothing would show `pendingSlugs` growing
 * run after run while the job stays green — the exact silent failure this file
 * is here to catch.
 *
 * Rows are appended to `data/orphan-reconciliation-history.json`, which is
 * committed by the same push. That is deliberate: the file can only grow a new
 * row when the push actually succeeds, so the history is simultaneously the
 * measure AND the proof the workflow is landing its work.
 *
 * Usage:
 *   node scripts/report-orphan-reconciliation.mjs            # write history row
 *   node scripts/report-orphan-reconciliation.mjs --dry-run  # report only
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readAllKnownJobSlugs,
  knownSlugsShardIndex,
  KNOWN_SLUGS_SHARD_DIR,
} from './lib/all-known-job-slugs-store.mjs';
import { readOrphanEnriched } from './lib/orphan-enriched-store.mjs';
import { shardFileName } from './lib/shard-file-naming.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const HISTORY_FILE = 'data/orphan-reconciliation-history.json';

/** Keep the series long enough to see a trend, short enough to stay a small diff. */
export const HISTORY_MAX_ROWS = 180;

function git(args, rootDir) {
  // stderr is discarded on purpose: `git show HEAD:<shard>` legitimately fails
  // with "exists on disk, but not in 'HEAD'" for a shard that has never been
  // committed, which the caller handles as "it held nothing at HEAD". Letting
  // that inherit would print 32 `fatal:` lines into a healthy CI log.
  return execFileSync('git', args, {
    cwd: rootDir,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 64,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Slugs the canonical registry holds AT `HEAD` — i.e. what the deployed site can
 * actually emit a soft landing for.
 *
 * Only the shards that DIFFER from `HEAD` are read out of git. That is exact,
 * not an approximation: a slug's shard is a pure function of the slug
 * (`knownSlugsShardIndex`), so if a shard is byte-identical to `HEAD` then its
 * membership on disk and on `main` are the same set by definition. In a healthy
 * steady state only a handful of shards move, so this reads a few MB instead of
 * the whole ~95 MB registry.
 *
 * Returns `null` when git is unavailable (a plain export, a shallow tree with no
 * HEAD): the caller then reports totals without the backlog columns rather than
 * inventing a number.
 */
export function registrySlugsMissingOnHead(onDisk, rootDir = ROOT) {
  let status;
  try {
    // `git status --porcelain`, NOT `git diff HEAD`: diff only knows about
    // TRACKED paths, so a shard file that has never been committed (a fresh
    // clone, or the migration commit that creates the shard dir in the first
    // place) would be reported as "unchanged" and its slugs counted as already
    // on main. That is the precise shape of silent under-reporting this whole
    // report exists to prevent, so it must not live inside the report itself.
    status = git(
      ['status', '--porcelain', '--untracked-files=all', '--', KNOWN_SLUGS_SHARD_DIR],
      rootDir,
    )
      .split('\n')
      .filter(Boolean);
  } catch {
    return null;
  }

  const changedIdx = new Set();
  for (const line of status) {
    // Covers ` M path`, `?? path`, `A  path` and the `R  old -> new` form —
    // every shard index named on the line is treated as moved.
    for (const m of line.matchAll(/part-(\d+)\.json/g)) changedIdx.add(Number(m[1]));
  }

  // For every changed shard, the set of slugs it held at HEAD.
  const headSlugsByShard = new Map();
  for (const i of changedIdx) {
    const set = new Set();
    try {
      const blob = git(['show', `HEAD:${KNOWN_SLUGS_SHARD_DIR}/${shardFileName(i)}`], rootDir);
      const j = JSON.parse(blob);
      for (const k of Object.keys(j?.slugs ?? {})) set.add(k);
    } catch {
      // Shard is new at HEAD (never committed) — it held nothing.
    }
    headSlugsByShard.set(i, set);
  }

  return (slug) => {
    const idx = knownSlugsShardIndex(slug);
    // Unchanged shard: on-disk membership IS the committed membership.
    if (!changedIdx.has(idx)) return !onDisk.has(slug);
    return !headSlugsByShard.get(idx).has(slug);
  };
}

/** Aggregate the enriched ledger down to one row per slug. */
export function summarizeLedger(records) {
  const bySlug = new Map();
  for (const r of records) {
    if (!r?.slug) continue;
    const cur = bySlug.get(r.slug) ?? { impressions: 0, clicks: 0 };
    // Per-locale records each carry their own GSC signal; the slug's exposure
    // is their sum, which is what a single soft-landing page recovers.
    cur.impressions += Number(r.totalImpressions) || 0;
    cur.clicks += Number(r.totalClicks) || 0;
    bySlug.set(r.slug, cur);
  }
  return bySlug;
}

export function buildReport(rootDir = ROOT) {
  const ledger = readOrphanEnriched(rootDir);
  const bySlug = summarizeLedger(ledger);
  const registry = new Set(Object.keys(readAllKnownJobSlugs(rootDir)));

  let impressions = 0;
  let clicks = 0;
  for (const m of bySlug.values()) {
    impressions += m.impressions;
    clicks += m.clicks;
  }

  const report = {
    at: new Date().toISOString(),
    orphanRecords: ledger.length,
    orphanSlugs: bySlug.size,
    orphanImpressions: impressions,
    orphanClicks: clicks,
    registrySlugs: registry.size,
  };

  const isMissingOnHead = registrySlugsMissingOnHead(registry, rootDir);
  if (isMissingOnHead) {
    let pendingSlugs = 0;
    let pendingImpressions = 0;
    let pendingClicks = 0;
    for (const [slug, m] of bySlug) {
      if (!isMissingOnHead(slug)) continue;
      pendingSlugs++;
      pendingImpressions += m.impressions;
      pendingClicks += m.clicks;
    }
    report.pendingSlugs = pendingSlugs;
    report.pendingImpressions = pendingImpressions;
    report.pendingClicks = pendingClicks;
  }

  return report;
}

/** Append `row`, keeping the series capped. Exported for the test. */
export function appendHistory(row, rootDir = ROOT) {
  const file = path.resolve(rootDir, HISTORY_FILE);
  let doc = { version: 1, generatedAt: row.at, entries: [] };
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (Array.isArray(prev?.entries)) doc = { ...prev, entries: prev.entries };
  } catch {
    /* first run — start the series */
  }
  doc.version = 1;
  doc.generatedAt = row.at;
  doc.entries = [...doc.entries, row].slice(-HISTORY_MAX_ROWS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
  return doc;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const r = buildReport(ROOT);

  const pending =
    r.pendingSlugs === undefined
      ? '  (backlog vs HEAD unavailable — no git context)'
      : `  ⏳ not yet on main: ${r.pendingSlugs} slugs / ${r.pendingImpressions} impressions / ${r.pendingClicks} clicks`;

  console.log('\n📊 Orphan reconciliation');
  console.log(`  📇 ledger: ${r.orphanRecords} records, ${r.orphanSlugs} slugs`);
  console.log(`  🔎 GSC exposure: ${r.orphanImpressions} impressions, ${r.orphanClicks} clicks`);
  console.log(`  🗂️  canonical registry: ${r.registrySlugs} slugs`);
  console.log(pending);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      '### Orphan reconciliation',
      '',
      '| metric | value |',
      '| --- | ---: |',
      `| orphan records | ${r.orphanRecords} |`,
      `| orphan slugs | ${r.orphanSlugs} |`,
      `| GSC impressions on orphans | ${r.orphanImpressions} |`,
      `| canonical registry slugs | ${r.registrySlugs} |`,
    ];
    if (r.pendingSlugs !== undefined) {
      lines.push(
        `| **slugs not yet on main** | **${r.pendingSlugs}** |`,
        `| **impressions still landing on a 404** | **${r.pendingImpressions}** |`,
      );
    }
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n\n`);
    } catch {
      /* summary is best-effort telemetry, never a reason to fail the job */
    }
  }

  if (!dryRun) {
    appendHistory(r, ROOT);
    console.log(`  💾 ${HISTORY_FILE} (+1 row)`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
