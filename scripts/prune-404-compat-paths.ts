/**
 * Prune non-resolving entries from the sharded data/seo-404-compat store
 * (data/seo-404-compat/part-*.json, see scripts/lib/compat-paths-store.mjs;
 * split from the old single seo-404-compat-paths.json in issue #2988).
 *
 * Invariant (tests/search-console-compat.test.ts "covers the committed live
 * 404 export paths"): EVERY path in the store must resolve to a non-null target
 * via resolveSearchConsoleCompatTarget. Automated data-refresh workflows
 * (sync-gsc-orphans, discover-404s) append raw GSC orphan / 404-sweep paths
 * directly to main; any path the resolver can't map → committed-snapshot test
 * red → main red → drain frozen (observed 2026-06-02: bot commit froze the
 * autonomous loop ~83min, no PR accountable).
 *
 * Run this BEFORE committing the store in those workflows: it drops the
 * non-resolving paths so the commit is always test-clean (main stays green) and
 * the resolving paths still ship. Idempotent; exits 0 even with nothing to do.
 */
import { readCompatPaths, writeCompatPaths } from './lib/compat-paths-store.mjs';

// Sharded accumulator (issue #2988): the logical {paths} set lives across
// data/seo-404-compat/part-*.json. Read/write only via the store helpers.
const ROOT = process.cwd();

// Strict (fail-closed) mode. The graceful default below self-skips (exit 0)
// when the resolver/dataset isn't available, which is correct for general
// data-refresh workflows that prune BEFORE pushing. But the in-rebase JSON
// 3-way merge in git-commit-data.sh runs AFTER that gate and re-introduces
// upstream paths; if the resolver were unavailable there, a silent skip would
// let a non-resolving path survive into the committed merge → main red (the
// exact outage this guard prevents). Callers in that path set
// PRUNE_404_STRICT=1 so unavailability becomes a hard failure (exit 1, abort
// the push) instead of a silent no-op. Reuses the single resolvability source
// rather than duplicating resolver wiring.
const STRICT = process.env.PRUNE_404_STRICT === '1';

async function main(): Promise<void> {
  // Dynamic import, kept defensive: the resolver now only statically imports the
  // committed data/canton-url-slugs.json (since #2041 it no longer pulls in the
  // CI-assembled data/jobs.json — per-canton job paths canonicalize to the canton
  // in the URL, not via the slug→canton index). If the import fails for any
  // reason we CANNOT validate resolvability — skip gracefully (exit 0) rather than
  // crash, so the step is safe to add to any data-refresh workflow. In STRICT
  // mode the same unavailability is fatal (the caller cannot tolerate an
  // unvalidated file).
  let resolveSearchConsoleCompatTarget: (p: string) => unknown | null;
  try {
    ({ resolveSearchConsoleCompatTarget } = await import('../build-plugins/searchConsoleCompat'));
  } catch (err) {
    const msg = `[prune-404-compat] resolver unavailable (import failed)`;
    if (STRICT) {
      console.error(
        `${msg} — STRICT mode: refusing to leave the data/seo-404-compat store unvalidated. ${
          (err as Error)?.message ?? ''
        }`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`${msg} — skipping. ${(err as Error)?.message ?? ''}`);
    return;
  }

  const data = readCompatPaths(ROOT) as { paths?: unknown; [k: string]: unknown };
  if (!Array.isArray(data.paths)) {
    console.log('[prune-404-compat] no `paths` — nothing to do.');
    return;
  }

  const before: string[] = data.paths.filter((p): p is string => typeof p === 'string');
  const seen = new Set<string>();
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const p of before) {
    if (seen.has(p)) continue; // also de-dup (raw appends can repeat)
    seen.add(p);
    if (resolveSearchConsoleCompatTarget(p) !== null) kept.push(p);
    else dropped.push(p);
  }

  const removed = before.length - kept.length;
  if (removed === 0) {
    console.log(`[prune-404-compat] ${kept.length} paths, all resolve — no change.`);
    return;
  }

  writeCompatPaths({ ...data, paths: kept }, ROOT);
  console.log(
    `[prune-404-compat] pruned ${removed} non-resolving/duplicate path(s) ` +
      `(${before.length} → ${kept.length}). Sample dropped: ${dropped.slice(0, 5).join(', ') || '(dups only)'}`,
  );
}

main().catch((err) => {
  console.error('[prune-404-compat] unexpected error:', err);
  process.exitCode = 1;
});
