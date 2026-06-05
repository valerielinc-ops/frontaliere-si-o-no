/**
 * Single source of truth for the Vite/Rollup content-hash CHARACTER CLASS.
 *
 * Vite 6 / Rollup 4 emit base64url content hashes — the alphabet is
 * `[A-Za-z0-9_-]` (NOT just `[A-Za-z0-9]`): roughly 1 in 5 hashes contains a
 * `-` or `_`. A quote-strict `[a-zA-Z0-9]` class silently fails to match those
 * filenames, which then slip through any janitor / extractor that relies on the
 * regex (the orphan never gets grouped → never pruned → CDN keeps growing).
 *
 * This constant is the ONE definition of that alphabet. It is consumed by:
 *   - `scripts/ci/prune-cdn-assets.mjs` (generic `<name>-<hash>.<ext>` matcher)
 *   - `build-plugins/shared/spaBundleRx.ts` (the SPA `index-<hash>` extractor)
 * Keeping it here makes drift between those copies impossible by construction
 * (AGENTS.md #6 — a regex/char-class duplicated literally in ≥2 files must be
 * extracted into one shared module, not copy-pasted).
 *
 * `.mjs` (not `.ts`) so raw-`node` CI scripts (run without Vite/tsx, e.g.
 * `node scripts/ci/prune-cdn-assets.mjs`) can import the value directly; the
 * `.ts` shim `viteAssetHashRx.ts` re-exports it for TypeScript build-plugin
 * consumers (same pattern as `ejpMarker.mjs` / `ejpMarker.ts`).
 */

/** Character class (without delimiters) of a Vite/Rollup base64url content hash. */
export const VITE_HASH_CHARS = 'A-Za-z0-9_-';

/** Default content-hash length Vite emits (`build.rollupOptions` default = 8). */
export const VITE_HASH_LEN = 8;

/**
 * Generic content-hashed asset matcher: `<chunk-name>-<hash>.<js|css>`.
 *
 * The leading `(.+)` is greedy but backtracks so the hash group captures
 * EXACTLY {VITE_HASH_LEN} trailing chars even when the chunk NAME itself
 * contains `-` (e.g. `vendor-react-a1b2c3d4.js` → name `vendor-react`,
 * hash `a1b2c3d4`). Anchored end-to-end so only true asset filenames match.
 */
export const VITE_ASSET_RX = new RegExp(
  `^(.+)-([${VITE_HASH_CHARS}]{${VITE_HASH_LEN}})\\.(js|css)$`,
);
