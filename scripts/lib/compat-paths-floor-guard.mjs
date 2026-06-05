/**
 * Shared floor-guard for the `data/seo-404-compat-paths.json` accumulator
 * (the 404→301 redirect engine, ~300-650k path).
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

/**
 * Throw if writing `nextCount` paths would catastrophically truncate an
 * existing accumulator of `prevCount` paths.
 *
 * @param {number} prevCount  paths currently on disk (read pre-write)
 * @param {number} nextCount  paths about to be written
 * @param {object} [opts]
 * @param {number} [opts.floor=COMPAT_PATHS_SANITY_FLOOR]  sanity floor
 * @param {string} [opts.label='seo-404-compat-paths.json'] file label for the message
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
        `while the existing file has ${prev} → catastrophic truncation avoided. ` +
        `The initial read of the accumulator likely failed (empty fallback). ` +
        `NOT overwriting. Investigate (corrupt file / mid-write race) and restore if needed.`
    );
  }
}
