/**
 * Prune non-resolving entries from data/seo-404-compat-paths.json.
 *
 * Invariant (tests/search-console-compat.test.ts "covers the committed live
 * 404 export paths"): EVERY path in the file must resolve to a non-null target
 * via resolveSearchConsoleCompatTarget. Automated data-refresh workflows
 * (sync-gsc-orphans, discover-404s) append raw GSC orphan / 404-sweep paths
 * directly to main; any path the resolver can't map → committed-snapshot test
 * red → main red → drain frozen (observed 2026-06-02: bot commit froze the
 * autonomous loop ~83min, no PR accountable).
 *
 * Run this BEFORE committing the file in those workflows: it drops the
 * non-resolving paths so the commit is always test-clean (main stays green) and
 * the resolving paths still ship. Idempotent; exits 0 even with nothing to do.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(process.cwd(), 'data', 'seo-404-compat-paths.json');

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
  // Dynamic import: the resolver statically pulls in data/jobs.json (via
  // slugCantonIndex). If that dataset isn't assembled in this job, we CANNOT
  // validate resolvability — skip gracefully (exit 0) rather than crash, so the
  // step is safe to add to any data-refresh workflow. Workflows that want the
  // prune to actually run must assemble jobs first. In STRICT mode the same
  // unavailability is fatal (the caller cannot tolerate an unvalidated file).
  let resolveSearchConsoleCompatTarget: (p: string) => unknown | null;
  try {
    ({ resolveSearchConsoleCompatTarget } = await import('../build-plugins/searchConsoleCompat'));
  } catch (err) {
    const msg = `[prune-404-compat] resolver unavailable (likely data/jobs.json not assembled)`;
    if (STRICT) {
      console.error(
        `${msg} — STRICT mode: refusing to leave data/seo-404-compat-paths.json unvalidated. ${
          (err as Error)?.message ?? ''
        }`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`${msg} — skipping. ${(err as Error)?.message ?? ''}`);
    return;
  }

  let raw: string;
  try {
    raw = readFileSync(FILE, 'utf-8');
  } catch {
    console.log('[prune-404-compat] file not found — nothing to do.');
    return;
  }

  const data = JSON.parse(raw) as { paths?: unknown; [k: string]: unknown };
  if (!Array.isArray(data.paths)) {
    console.log('[prune-404-compat] no `paths` array — nothing to do.');
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

  data.paths = kept;
  writeFileSync(FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  console.log(
    `[prune-404-compat] pruned ${removed} non-resolving/duplicate path(s) ` +
      `(${before.length} → ${kept.length}). Sample dropped: ${dropped.slice(0, 5).join(', ') || '(dups only)'}`,
  );
}

main().catch((err) => {
  console.error('[prune-404-compat] unexpected error:', err);
  process.exitCode = 1;
});
