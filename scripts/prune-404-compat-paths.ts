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
 * Run this BEFORE committing the store in those workflows: it drops
 * non-resolving paths while preserving resolving paths. It fails closed on
 * large global losses and when a route family of at least 2 URLs disappears
 * or loses over 25%. After reviewing an intentional cleanup, opt in with
 * PRUNE_404_ALLOW_LARGE_PRUNE=1. Idempotent; exits 0 when nothing changes.
 */
import { readCompatPathsStrict, writeCompatPaths } from './lib/compat-paths-store.mjs';
import {
  assertCompatPruneFamilySafety,
  assertCompatPruneSafety,
  compatPathFamily,
} from './lib/compat-paths-floor-guard.mjs';

// Sharded accumulator (issue #2988): the logical {paths} set lives across
// data/seo-404-compat/part-*.json. Read/write only via the store helpers.
const ROOT = process.cwd();

// Fail closed by default so a future caller cannot silently skip validation.
// Publishing workflows keep PRUNE_404_STRICT=1 as an explicit contract; only a
// caller that will not publish this snapshot may opt out with PRUNE_404_STRICT=0.
// This also protects the in-rebase JSON 3-way merge in git-commit-data.sh, which
// can re-introduce upstream paths after an earlier prune. Reuses the single
// resolvability source rather than duplicating resolver wiring.
const STRICT = process.env.PRUNE_404_STRICT !== '0';
const ALLOW_LARGE_PRUNE = process.env.PRUNE_404_ALLOW_LARGE_PRUNE === '1';

async function main(): Promise<void> {
  // Dynamic import, kept defensive: the resolver now only statically imports the
  // committed data/canton-url-slugs.json (since #2041 it no longer pulls in the
  // CI-assembled data/jobs.json — per-canton job paths canonicalize to the canton
  // in the URL, not via the slug→canton index). If the import fails for any
  // reason we CANNOT validate resolvability. By default this is fatal; the
  // relaxed skip requires an explicit opt-out and is only safe for callers that
  // will not publish an unvalidated snapshot.
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

  const data = readCompatPathsStrict(ROOT) as { paths?: unknown; [k: string]: unknown };
  if (!Array.isArray(data.paths)) {
    console.log('[prune-404-compat] no `paths` — nothing to do.');
    return;
  }

  const before: string[] = data.paths.filter((p): p is string => typeof p === 'string');
  const seen = new Set<string>();
  const kept: string[] = [];
  const dropped: string[] = [];
  const familyTotals = new Map<string, number>();
  const familyDropped = new Map<string, number>();
  for (const p of before) {
    if (seen.has(p)) continue; // also de-dup (raw appends can repeat)
    seen.add(p);
    const family = compatPathFamily(p);
    familyTotals.set(family, (familyTotals.get(family) ?? 0) + 1);
    if (resolveSearchConsoleCompatTarget(p) !== null) {
      kept.push(p);
    } else {
      dropped.push(p);
      familyDropped.set(family, (familyDropped.get(family) ?? 0) + 1);
    }
  }

  const removed = before.length - kept.length;
  if (removed === 0) {
    console.log(`[prune-404-compat] ${kept.length} paths, all resolve — no change.`);
    return;
  }

  // A resolver regression can make a large cohort look non-resolving while
  // leaving the accumulator above its historical floor. The strict read,
  // global limits, and per-route-family guard prevent partial-input writes and
  // localized false deletions that are small in the global total.
  if (ALLOW_LARGE_PRUNE) {
    console.warn('[prune-404-compat] PRUNE_404_ALLOW_LARGE_PRUNE=1 — prune safety guards are explicitly bypassed.');
  }
  assertCompatPruneSafety(before.length, kept.length, {
    label: 'seo-404-compat prune',
    allowLargePrune: ALLOW_LARGE_PRUNE,
  });
  assertCompatPruneFamilySafety(familyTotals, familyDropped, {
    label: 'seo-404-compat prune',
    allowLargePrune: ALLOW_LARGE_PRUNE,
  });

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
