/**
 * Single source of truth for the SPA entry bundle's bare filenames.
 *
 * These are STABLE, not content-hashed — `vite.config.ts` pins them via
 * `entryFileNames` (JS) and the `index.css` source basename flowing through
 * `assetFileNames` (CSS, see the rationale next to both). Being stable means
 * the filenames are known at config-authoring time, not just after the
 * build finishes — so consumers that need "the SPA entry filename" can
 * import these constants directly instead of re-discovering them at build
 * time by polling and regex-parsing the generated `dist/index.html`.
 *
 * Structural fix for the spa-bundle-resolver ENOENT race (#4745 and its
 * three predecessors #4638/#4738/#4746): the poll-based resolver was
 * designed for a content-hashed world where the entry filename could only
 * be learned by reading Vite's generated HTML. That world ended when the
 * entry names were stabilized (see vite.config.ts `entryFileNames`), but
 * the runtime discovery mechanism was never removed — so every consumer
 * kept racing a `dist/index.html` write that (per repeated CI evidence)
 * doesn't reliably exist yet when heavy content-generation plugins reach
 * their `closeBundle` poll, no matter how the timeout or plugin order is
 * tuned. Importing the filename directly removes the race instead of
 * chasing it. Detail: docs/AGENTS-HISTORY.md#spa-bundle-resolver-static-filenames.
 */
export const SPA_ENTRY_JS_FILENAME = 'index-entry.js';
export const SPA_ENTRY_CSS_FILENAME = 'index.css';
