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
/**
 * Desktop side-rail layout, mirrored from the ASYNC entry sheet (`index.css`
 * `main:not(.seo-static-content)…max-width` + the Tailwind `xlw:grid-cols-…`
 * utilities) into this SYNCHRONOUS first-paint block.
 *
 * Why (CLS fix): the rail grid wrapping `<main>` on static SEO landings
 * (htmlTemplate `buildSimplePage`) and SPA content pages (App.tsx) is styled
 * purely by the async Tailwind sheet, which `media="print"`-swaps in ~500ms
 * AFTER first paint. So `<main>` repaints from full-width block → centred grid
 * column and the whole page below jumps — live-measured dominant desktop shift
 * 0.47 (CF Web Analytics desktop CLS p75 0.22→0.65 on 2026-06-22, right after
 * #2584/#2592/#2635 shipped the rails). Reserving the IDENTICAL grid here puts
 * the final layout in place at first paint so the async sheet changes nothing →
 * no shift. `min-height:600px` on the gutters reserves the half-page creative's
 * space so a tall rail beside short content (e.g. the search-index page) no
 * longer pushes the footer down when the ad lands (secondary ~0.22 shift).
 *
 * Stable hooks (`ft-rail-grid` static wrapper, `ft-rail-grid-spa` SPA wrapper —
 * `display:contents` below the breakpoint to mirror its Tailwind `contents`
 * class, `ft-rail-aside` gutters) are added alongside the existing Tailwind
 * classes so this targets the wrappers without depending on the async sheet.
 * Pure space reservation — no ad added/removed (AGENTS.md §7). The job-detail
 * rails (JobBoard.tsx) keep their own xl/xlw markup and are NOT hooked here:
 * job-detail content is always taller than the 600px rail, so the row never
 * grows when the ad lands, and the live CLS breakdown put it under ~0.01.
 */
export const RAIL_RESERVE_CSS =
  '.ft-rail-aside{display:none}' +
  '.ft-rail-aside-x{display:none}' +
  '.ft-rail-grid-spa{display:contents}' +
  '@media(min-width:1280px) and (max-width:1399.98px){' +
  '.ft-rail-grid-x{display:grid;grid-template-columns:180px 1fr 180px;gap:1rem}' +
  '.ft-rail-aside-x{display:block}' +
  '}' +
  '@media(min-width:1400px){' +
  'main:not(.seo-static-content):not(.cluster-seo-prose){max-width:calc(100vw - 360px)}' +
  '.ft-rail-grid{display:grid;grid-template-columns:300px minmax(0,1fr) 300px;gap:1rem;margin-inline:auto;max-width:1768px}' +
  '.ft-rail-grid-spa{display:grid;grid-template-columns:160px minmax(0,1fr) 160px;gap:1rem}' +
  '.ft-rail-grid-x{display:grid;grid-template-columns:300px minmax(0,1fr) 300px;gap:1rem}' +
  '.ft-rail-aside,.ft-rail-aside-x{display:flex;flex-direction:column;min-height:600px}' +
  '}' +
  '@media(min-width:1800px){main:not(.seo-static-content):not(.cluster-seo-prose){max-width:calc(100vw - 420px)}}';

/**
 * Static SEO landing layout, mirrored from the ASYNC `seo-static.css`
 * (`main.seo-static-content{display:grid;…;gap:12px}`) into this SYNCHRONOUS
 * first-paint block.
 *
 * Why (CLS fix): on every `main.seo-static-content` page (the
 * `/cerca-lavoro-*` canton/category landings et al.) the static body's own
 * grid is styled PURELY by `seo-static.css`, which `media="print"`-swaps in
 * ~400ms AFTER first paint. Until it lands the `<main>` renders as default
 * `display:block`, so its ~8 sections stack with collapsing margins; when the
 * async sheet promotes it to `display:grid` with an explicit `gap:12px` (no
 * margin-collapse), every section below the first is pushed down and the whole
 * column reflows — live-measured dominant DESKTOP shift 0.70 on
 * `/cerca-lavoro-ticino/{infermieri,case-anziani}/` (PerformanceObserver
 * buffered layout-shift, source `main.seo-static-content`, 2026-06-22; matches
 * the CF Web Analytics desktop CLS p75 0.65–0.81 cluster on these paths). This
 * is the "handoff static→SPA" residual left after #2649 reserved the RAIL grid.
 *
 * Reserving the IDENTICAL geometry here puts the final layout in place at first
 * paint so the async sheet changes nothing → no shift. Every value mirrors the
 * live resolved computed style and its async source, so removing any would
 * REINTRODUCE a shift:
 *   - `display:grid` + `grid-template-columns:minmax(0,1fr)` + `gap:12px` +
 *     `max-width:1120px` + `margin:0 auto` ← `seo-static.css`'s
 *     `main.seo-static-content{…}` rule (the dominant block→grid reflow).
 *   - `padding` BLOCK `32px … 56px` ← the `.s-Ziv1Xn` scoped class ALSO on this
 *     `<main>` (`seo-static.css`: `.s-Ziv1Xn{padding:32px 20px 56px}`); without
 *     it the async sheet pushes content down ~32px (top) at swap — the
 *     secondary shift seen at ~2.7s in the live trace.
 *   - padding INLINE `clamp(16px,4vw,32px)` ← `index.css`'s
 *     `main.seo-static-content{padding-inline:clamp(…)}` (overrides `.s-Ziv1Xn`'s
 *     20px at higher specificity), so the text-wrap width is identical at first
 *     paint and no horizontal re-wrap grows the column.
 * Pure space reservation — no ad, content or markup added/removed
 * (AGENTS.md §7); the in-flow `<ins>` ad slots are grid children in BOTH the
 * before and after state, so monetization is untouched. The `:not(...)` rail
 * rule in {@link RAIL_RESERVE_CSS} excludes this selector, so they never fight.
 */
export const SEO_STATIC_GRID_RESERVE_CSS =
  'main.seo-static-content{max-width:1120px;margin:0 auto;padding:32px clamp(16px,4vw,32px) 56px;display:grid;grid-template-columns:minmax(0,1fr);gap:12px}' +
  'main.seo-static-content>*{min-width:0;width:100%}';

export const CRITICAL_CSS =
  '@font-face{font-family:Inter;font-style:normal;font-weight:400 700;font-display:swap;src:url(/fonts/inter-latin.woff2) format("woff2");size-adjust:100%;ascent-override:90%;descent-override:22%;line-gap-override:0%;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}*,::after,::before{box-sizing:border-box;border:0 solid #e5e7eb}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased;line-height:1.5}.bg-surface-alt{background-color:#f8fafc}.dark .dark\\:bg-surface-inverted,.dark.bg-surface-inverted{background-color:#020617}.text-heading{color:var(--color-heading,#0f172a)}.dark .dark\\:text-heading{color:#f1f5f9}body{min-height:100vh}' +
  RAIL_RESERVE_CSS +
  SEO_STATIC_GRID_RESERVE_CSS;
