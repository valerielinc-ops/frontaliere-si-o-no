/**
 * Cross-plugin registry for emitted per-canton sector landing pages.
 *
 * `jobsSeoPagesPlugin` emits a crawlable, self-canonical landing at
 * `/{section}/{sectorSlug}/` (e.g. `/cerca-lavoro-appenzello/infermieri/`) for
 * every non-TI canton × curated sector (`SECTOR_HUB_KEYS`) pair that clears its
 * job-count gate (canton ≥ MIN_JOBS_FOR_CANTON_PAGE AND ≥ 3 jobs matching the
 * sector). Whether a given pair clears that gate depends on the live job
 * dataset, so it cannot be re-derived without drift.
 *
 * `seoHubsPlugin.emitThinCantonHubs` renders the canton `settori` hub and needs
 * to link each sector chip at a *crawlable* target — NOT a `?q=` keyword-search
 * URL. `robots.txt` disallows `/*?q=*`, so an internal `<a>` pointing at one is
 * a "disallowed outlink" (SearchAtlas / GSC), and `rel="nofollow"` is not an
 * option (banned on internal links by `tests/no-internal-nofollow.test.tsx`).
 * This registry lets the hub deep-link the canonical sector page exactly when
 * one was emitted (no 404), and fall back to the canton job-board root
 * otherwise.
 *
 * Both plugins run sequentially in the same Node process during the build
 * (`closeBundle`), jobsSeoPagesPlugin first, so module-scoped state is
 * sufficient — no filesystem sidecar needed. Mirrors `cantonNoindexRegistry`.
 *
 * Under FAST_BUILD (per-canton sector emit skipped) the registry stays empty
 * and every chip falls back to the canton root — still crawlable, never `?q=`.
 */

const emittedSectorPages = new Set<string>();

const keyOf = (cantonKey: string, sectorKey: string): string => `${cantonKey}::${sectorKey}`;

/** Called by jobsSeoPagesPlugin after it emits the `/{section}/{sectorSlug}/` page. */
export function markCantonSectorPage(cantonKey: string, sectorKey: string): void {
  emittedSectorPages.add(keyOf(cantonKey, sectorKey));
}

/** Called by seoHubsPlugin before linking a sector chip on the canton `settori` hub. */
export function hasCantonSectorPage(cantonKey: string, sectorKey: string): boolean {
  return emittedSectorPages.has(keyOf(cantonKey, sectorKey));
}

/** Test/diagnostic helper — never mutate from production code. */
export function _resetCantonSectorPageRegistry(): void {
  emittedSectorPages.clear();
}

/** Test/diagnostic helper — never mutate from production code. */
export function _getCantonSectorPageSnapshot(): readonly string[] {
  return [...emittedSectorPages];
}
