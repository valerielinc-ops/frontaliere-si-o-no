/**
 * Deterministic SPA bundle resolver shared by every SEO plugin that emits
 * static HTML which must hydrate into the React SPA.
 *
 * Structural fix (#4745 and predecessors #4638/#4738/#4746)
 * -----------------------------------------------------------
 * This used to poll `dist/index.html` and regex-extract the entry JS/CSS
 * filenames out of its content, because those filenames used to be
 * content-hashed and were only knowable after Vite finished writing the
 * HTML. Three rounds of raising/reordering that poll (3s → 30s → 120s,
 * then "prewarm as the very first closeBundle handler") all re-failed
 * within days, because the poll target — Vite's own generated
 * `dist/index.html` — kept not existing yet at poll time, for reasons that
 * outlasted every timeout/ordering fix.
 *
 * `vite.config.ts` stabilized the entry filenames (`entryFileNames` for
 * JS, `assetFileNames` for the CSS import in `index.tsx`) so they are
 * FIXED strings known at config-authoring time — no build artifact needs
 * to be read to know them. `build-plugins/shared/spaEntryFilenames.ts` is
 * the single source of truth Vite's own config reads from; this resolver
 * just re-exports that fact.
 *
 * 2026-07-26 follow-up: a first version of this fix still gated the
 * return value on `fs.existsSync(dist/assets/<file>)`, on the theory that
 * plain Rollup assets (unlike the specially-templated `dist/index.html`)
 * are reliably present by closeBundle time. That theory was false: this
 * build's Rollup write phase does not reliably finish within closeBundle
 * either, and this resolver's own hard `throw` on that race took down
 * every locale's deploy for 20+ hours (see incident detail in
 * docs/AGENTS-HISTORY.md#spa-bundle-resolver-static-filenames). Callers
 * only need the filename *string* to embed in generated HTML — they don't
 * need the file to physically exist yet, since Rollup guarantees it
 * exists by the time the `vite build` process exits, well after any page
 * referencing it was written. So this function no longer touches disk at
 * all; actual presence is verified once, after the whole build process
 * exits, by `scripts/verify-spa-entry-assets.mjs`.
 */
import { SPA_ENTRY_JS_FILENAME, SPA_ENTRY_CSS_FILENAME } from './shared/spaEntryFilenames';

export interface SpaBundleInfo {
  /** Bare filename, no `/assets/` prefix. e.g. `index-entry.js`. */
  readonly entryJs: string;
  /** Bare filename, no `/assets/` prefix. e.g. `index.css`. */
  readonly entryCss: string;
  /** Always true — filenames are fixed by config, not runtime-discovered. */
  readonly hasSpaBundle: true;
}

const STABLE_INFO: SpaBundleInfo = {
  entryJs: SPA_ENTRY_JS_FILENAME,
  entryCss: SPA_ENTRY_CSS_FILENAME,
  hasSpaBundle: true,
};

/**
 * Returns the SPA entry-bundle filenames. Pure constant lookup — no disk
 * I/O, no cache invalidation needed since the value never changes within
 * (or across) a build. `distDir` is accepted for call-site compatibility
 * with the many existing consumers, though it no longer affects the
 * result.
 */
export function resolveSpaBundle(_distDir: string): SpaBundleInfo {
  return STABLE_INFO;
}
