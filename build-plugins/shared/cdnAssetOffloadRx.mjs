/**
 * Single source of truth for the deploy "Guard B" SAME-ORIGIN /assets/ matcher.
 *
 * Two consumers historically carried a HAND-COPIED 1:1 port of this pattern, and
 * if they ever drift the deploy ships a 404 (an offloaded /assets/ ref that the
 * Drop step deleted from the artifact but the page still points at same-origin →
 * dead boot script / CSS → broken page → AdSense + crawlability loss):
 *
 *   1. `scripts/offload-generated-images-cdn.mjs` — JS `RegExp` (ASSETS_SAME_ORIGIN_RX)
 *      records every content *.html with a surviving same-origin /assets/ ref and
 *      writes the verdict to `$RUNNER_TEMP/assets-same-origin.marker`.
 *   2. `.github/workflows/deploy.yml` "Drop dist/assets" step — a bash ERE
 *      (`ASSET_RX`) used (a) to belt-grep the three top-level dirs walk() skips
 *      and (b) as the fail-safe full-tree grep when the marker is absent.
 *
 * The ALPHABET of file extensions (js|mjs|css|woff2?|…|json) is the part that
 * silently drifts on copy-paste. Keeping it here makes that impossible by
 * construction (AGENTS.md #6 — a regex duplicated literally in ≥2 files must be
 * extracted into ONE shared module, not copy-pasted). Same `.mjs` rationale as
 * `viteAssetHashRx.mjs` / `ejpMarker.mjs`: raw-`node` consumers (the offload
 * script under plain Node, and the workflow via `node -e`/`node -p`) import the
 * value directly without Vite/tsx.
 *
 * IMPORTANT: this file is the gate's delete authority. Changing the alphabet here
 * changes BOTH the marker producer and the workflow grep at once — which is the
 * whole point (no divergence), but it means edits here are deploy-critical.
 */

/**
 * Extension alphabet of an offloadable bundler/boot asset — every extension that
 * lives under dist/assets (Vite JS/CSS chunks, fonts, the images Vite fingerprints,
 * inline JSON). ERE-safe (no `?:`, no escapes that differ between JS and bash);
 * the only metachar is `?` (quantifier on `woff2`), valid identically in JS and ERE.
 */
export const ASSET_EXT_ALTERNATION =
  'js|mjs|css|woff2?|ttf|otf|eot|png|jpe?g|webp|avif|gif|svg|ico|json';

/**
 * Bash ERE (extended regex) source string for the SAME-ORIGIN /assets/ matcher.
 * Consumed by the deploy workflow via `node -p`. Matches a quote/paren/`(`-delimited
 * `/assets/<file>.<ext>` where the host is OUR origin (leading `/`, optionally
 * absolute-rooted via `/?`). NOT anchored — used with `grep -E`.
 */
export const ASSETS_SAME_ORIGIN_ERE =
  `["'(]/?assets/[^"'() ]*\\.(${ASSET_EXT_ALTERNATION})`;

/**
 * JS RegExp form of {@link ASSETS_SAME_ORIGIN_ERE}: ERE `(...)` → JS non-capturing
 * `(?:...)` (we only need a boolean `.test`), and the literal `/` are escaped for a
 * regex literal-equivalent. Stateless (non-global) so `.test()` is callable repeatedly.
 */
export const ASSETS_SAME_ORIGIN_RX = new RegExp(
  `["'(]\\/?assets\\/[^"'() ]*\\.(?:${ASSET_EXT_ALTERNATION})`,
);
