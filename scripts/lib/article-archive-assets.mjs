/**
 * The two constants the article-hub asset probe needs, in a module with no
 * side effects so a test can import them.
 *
 * `scripts/check-article-hub-landings.mjs` calls `main()` at module scope —
 * importing it from a test would fire sixteen HTTP requests — so anything that
 * wants to be asserted on lives here instead.
 */

/**
 * Per-locale trailing "all" slug for the article archives (`/tutti/`, `/all/`,
 * `/alle/`, `/tous/`).
 *
 * Restated rather than imported: the authority is `ARCHIVE_ALL_SLUG` in
 * `packages/articles/engine/articleHubPagesPlugin.ts`, which is TypeScript,
 * and the watchdog runs the probe under bare `node` with no `npm ci` (nine
 * HTTP requests do not justify installing 1.4 GB). `tests/article-hub-archive-assets.test.ts`
 * pins the two tables together so the restatement cannot drift.
 */
export const ARCHIVE_ALL_SLUG = { it: 'tutti', en: 'all', de: 'alle', fr: 'tous' };

/**
 * A same-origin reference to a build asset — `src="/assets/…"` or
 * `href="/assets/…"`.
 *
 * NOTHING on the serving path hosts `/assets`: measured 2026-08-07,
 * `https://frontaliereticino.ch/assets/index-entry.js` → 404. Article-hub
 * pages carry those paths as PLAIN TEXT (`articleHubPagesPlugin` emits
 * `src="/assets/${entryJs}"`; Rollup never sees them as asset references), and
 * a single CDN-offload pass is what turns them into cdn.frontaliereticino.ch
 * URLs. A page that misses that pass ships with no CSS, no SPA bundle and no
 * AdSense loader — while still answering 200, which is why every reachability
 * check in this repo stayed green through it (issue #5270).
 *
 * The `="` anchor is load-bearing: a HEALTHY page still contains
 * `link[media="print"][href*="/assets/"]` inside the inline print-stylesheet
 * swap. That is a CSS selector, not a resource reference, and `href*=` does
 * not match `href="`. The trailing `[^"]` is the second guard — it also
 * rejects a bare `"/assets/"` with nothing after it.
 */
export const SAME_ORIGIN_ASSET_RX = /(?:src|href)="\/assets\/[^"]/g;

/** How many same-origin asset references `html` still carries. */
export function countSameOriginAssetRefs(html) {
  return (String(html).match(SAME_ORIGIN_ASSET_RX) ?? []).length;
}
