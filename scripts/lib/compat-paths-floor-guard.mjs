/**
 * Shared floor-guard for the `data/seo-404-compat` accumulator (the 404→301
 * redirect engine, ~1M paths; sharded across part-*.json since issue #2988,
 * formerly the single seo-404-compat-paths.json). Operates on path COUNTS, so
 * it is storage-shape-agnostic — callers pass prev/next totals.
 *
 * Why this exists (2026-06-04, #404-truncation; #1353): the compat file is an
 * ACCUMULATOR written by MULTIPLE jobs:
 *   - scripts/discover-404s-via-inspection.mjs (full rewrite from a Set)
 *   - scripts/sync-gsc-orphans.mjs (feeds back orphan paths)
 *   - scripts/lib/resolve-404-compat-conflict.mjs (in-place rebase 3-way merge)
 * Each reads via a `readJsonSafe` that returns an EMPTY fallback (`{paths:[]}`)
 * on a corrupt/parse-fail/mid-write file. If that read silently degrades to
 * empty, the writer recomputes a tiny `paths` array and OVERWRITES the 657k
 * good paths with a few thousand → 404→301 resolver down in prod (observed:
 * commit 06546ba truncated 657594→0, main red, floor-test 150000 violated).
 *
 * Duplicating this guard inline in ≥2 files invites drift (AGENTS.md #6), so it
 * lives here once and every compat writer calls it before its `writeFileSync`.
 *
 * SEMANTICS (mirror of the original inline guard at
 * discover-404s-via-inspection.mjs ~L323-333): the guard fires ONLY when the
 * write would SHRINK an already-large file below the floor —
 *   nextCount < floor && prevCount >= floor
 * A genuinely-small file (prevCount < floor, e.g. first-ever bootstrap) is NOT
 * blocked, so a fresh/legitimately-small accumulator can still grow.
 */

export const COMPAT_PATHS_SANITY_FLOOR = 150_000;
export const COMPAT_PATHS_MAX_AUTO_PRUNE_COUNT = 50_000;
export const COMPAT_PATHS_MAX_AUTO_PRUNE_RATIO = 0.10;

/**
 * Throw if writing `nextCount` paths would catastrophically truncate an
 * existing accumulator of `prevCount` paths.
 *
 * @param {number} prevCount  paths currently on disk (read pre-write)
 * @param {number} nextCount  paths about to be written
 * @param {object} [opts]
 * @param {number} [opts.floor=COMPAT_PATHS_SANITY_FLOOR]  sanity floor
 * @param {string} [opts.label='seo-404-compat-paths.json'] accumulator label for the message
 * @throws {Error} when nextCount < floor && prevCount >= floor
 */
export function assertCompatFloor(prevCount, nextCount, opts = {}) {
  const floor = opts.floor ?? COMPAT_PATHS_SANITY_FLOOR;
  const label = opts.label ?? 'seo-404-compat-paths.json';
  const prev = Number(prevCount) || 0;
  const next = Number(nextCount) || 0;
  if (next < floor && prev >= floor) {
    throw new Error(
      `❌ ABORT write to ${label}: ${next} path < floor ${floor} ` +
        `while the existing accumulator has ${prev} → catastrophic truncation avoided. ` +
        `The source read may be incomplete or the update may have removed a large cohort. ` +
        `NOT overwriting. Investigate the input, resolver, or writer and restore if needed.`
    );
  }
}

/**
 * Guard a destructive prune of the large compatibility accumulator.
 *
 * The historical floor catches a complete/truncating read failure, but alone
 * allows a resolver regression to drop a large cohort while leaving the store
 * above 150k. Automatic pruning is therefore limited to 50k paths and 10% of
 * the existing store. A reviewed, intentional large cleanup can explicitly
 * bypass both guards with `allowLargePrune: true`.
 *
 * @param {number} prevCount paths currently on disk
 * @param {number} nextCount paths about to be written
 * @param {object} [opts]
 * @param {string} [opts.label='seo-404-compat-paths.json'] accumulator label
 * @param {boolean} [opts.allowLargePrune=false] explicit reviewed override
 * @throws {Error} when an automatic prune exceeds either safety limit
 */
export function assertCompatPruneSafety(prevCount, nextCount, opts = {}) {
  if (opts.allowLargePrune === true) return;

  const label = opts.label ?? 'seo-404-compat-paths.json';
  assertCompatFloor(prevCount, nextCount, { ...opts, label });

  const prev = Number(prevCount) || 0;
  const next = Number(nextCount) || 0;
  if (prev < COMPAT_PATHS_SANITY_FLOOR) return;

  const removed = Math.max(0, prev - next);
  const removalRatio = removed / prev;
  if (removed > COMPAT_PATHS_MAX_AUTO_PRUNE_COUNT || removalRatio > COMPAT_PATHS_MAX_AUTO_PRUNE_RATIO) {
    throw new Error(
      `❌ ABORT prune of ${label}: ${removed} of ${prev} paths would be removed ` +
        `(${(removalRatio * 100).toFixed(1)}%). Automatic pruning is limited to ` +
        `${COMPAT_PATHS_MAX_AUTO_PRUNE_COUNT} paths and ` +
        `${COMPAT_PATHS_MAX_AUTO_PRUNE_RATIO * 100}% of a large accumulator. ` +
        `Review the dropped paths and resolver; only then rerun with ` +
        `PRUNE_404_ALLOW_LARGE_PRUNE=1 to authorize this cleanup.`,
    );
  }
}
