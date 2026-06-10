/**
 * Single source of truth for the first-paint CRITICAL CSS inlined as a
 * `<style>` block by the SEO static-page emitters (`staticPagesPlugin` and
 * `ogPagesPlugin`).
 *
 * Why this lives here (and is NOT externalized into `seo-static.css`):
 * this block is render-blocking-by-design — it carries the `@font-face`
 * declaration (with font-metric overrides for CLS prevention), the global
 * `*,::after,::before` border-box reset and the `body{}` rules that must paint
 * BEFORE the async Tailwind stylesheet (`media="print"` swap) arrives. Moving
 * it into the shared sheet would make it render-blocking and globalize the
 * resets onto every page that links the sheet — a site-wide FCP/LCP/CWV
 * regression. PR #1587 deliberately left it inline for exactly this reason; see
 * that PR body. So it stays an inline block, but the STRING is defined once.
 *
 * Why a shared constant (issue #1586): the two plugins each held a
 * hand-copied, near-identical `criticalCSS` literal that had already DRIFTED:
 *   - ogPagesPlugin was missing the `size-adjust/ascent-override/
 *     descent-override/line-gap-override` font-metric overrides that
 *     `index.html` (the authoritative critical-CSS source) and
 *     staticPagesPlugin both carry → article/OG pages got NO font-metric CLS
 *     stabilization.
 *   - the two `.text-heading` rules disagreed (`var(--color-heading)` vs the
 *     hard-coded `#0f172a`).
 * A literal duplicated verbatim across ≥2 files is the "drift between twin
 * files" class the reviewer flags (AGENTS.md §6). Defining it once makes that
 * drift impossible by construction; edit the CSS HERE and both emitters move
 * together.
 *
 * Reconciliation note (`.text-heading`): the unified value is
 * `var(--color-heading,#0f172a)`. `--color-heading` is defined in the async
 * Tailwind theme layer (not in this inline block), so at first paint — before
 * the async sheet lands — it would be undefined. The `,#0f172a` fallback is the
 * EXACT colour the old ogPages hard-code painted (it is also the resolved
 * light-mode value of `--color-heading`, `--_heading: #0f172a`), so first paint
 * is stable on both page types and the token still wins once the sheet loads.
 * Dark mode is handled by the separate `.dark .dark\:text-heading{color:#f1f5f9}`
 * rule already in the block.
 *
 * Keep this byte-for-byte in sync with the inline critical CSS in `index.html`
 * (the SPA shell) — they are the same first-paint contract.
 */
export const CRITICAL_CSS =
  '@font-face{font-family:Inter;font-style:normal;font-weight:400 700;font-display:swap;src:url(/fonts/inter-latin.woff2) format("woff2");size-adjust:100%;ascent-override:90%;descent-override:22%;line-gap-override:0%;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}*,::after,::before{box-sizing:border-box;border:0 solid #e5e7eb}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased;line-height:1.5}.bg-surface-alt{background-color:#f8fafc}.dark .dark\\:bg-surface-inverted,.dark.bg-surface-inverted{background-color:#020617}.text-heading{color:var(--color-heading,#0f172a)}.dark .dark\\:text-heading{color:#f1f5f9}body{min-height:100vh}';
