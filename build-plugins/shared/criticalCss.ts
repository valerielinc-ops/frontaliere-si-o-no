import { BASE_URL } from '../constants';

/**
 * Single source of truth for the first-paint CRITICAL CSS served to every
 * static SEO page as `/assets/critical.css` (written by
 * `staticScriptsPlugin.ts` from {@link CRITICAL_CSS} at build time) and
 * linked via the render-BLOCKING {@link CRITICAL_CSS_LINK} — NOT the
 * `media="print"` async-swap trick used for `seo-static.css`/the entry sheet.
 *
 * Why it must stay render-blocking (unchanged from when it was an inline
 * `<style>` block, PR #1587): it carries the `@font-face` declaration (with
 * font-metric overrides for CLS prevention), the global `*,::after,::before`
 * border-box reset, the `body{}` rules and every CLS-reservation block below
 * — all of it must be in effect BEFORE the async Tailwind stylesheet
 * (`media="print"` swap) arrives, or the swap itself causes the reflow this
 * file exists to prevent.
 *
 * Why externalizing it (issue: move inline styles/scripts to CDN-served
 * files, 2026-07) does not reintroduce the #1587 regression: #1587 was about
 * making the block ASYNC (media=print-swapped, i.e. arriving AFTER first
 * paint) — that's a correctness bug, not a bytes-on-the-wire one. A
 * synchronous same-origin `<link rel="stylesheet">`, discovered by the HTML
 * parser near the top of `<head>`, still blocks first paint exactly like the
 * inline block did; the only change is one extra same-origin request
 * (HTTP/2, no new connection) instead of the bytes already sitting in the
 * document. That's the part with no offline proof — full local SEO builds
 * OOM (AGENTS.md), so this trade is shipped as an explicitly UNVALIDATED
 * perf claim with a stated revert trigger (see the PR). `/assets/critical.css`
 * is root-relative/same-origin like every other file `staticScriptsPlugin.ts`
 * emits (`early-boot.js`, `gtag-init.js`, …).
 *
 * NOTE this file DOES end up on `cdn.frontaliereticino.ch` in practice:
 * `deploy-it-pages-prep.sh` stages the whole `dist/assets` directory
 * (bundler chunks AND every `staticScriptsPlugin.ts`-written file alike) to
 * the CDN, so static pages link `https://cdn.…/assets/critical.css`. That
 * broke the `@font-face src: url(/fonts/…)` below: a root-relative CSS
 * `url()` resolves against the STYLESHEET's own origin, not the document's —
 * so once served cross-origin it pointed at `cdn.…/fonts/…`, which 404s
 * (fonts are deliberately same-origin-only, see `vite.config.ts`
 * `renderBuiltUrl`'s `type !== 'asset'` branch). ~13k wasted font 404s/day
 * confirmed live 2026-07-03. Fixed by making the font `url()`s absolute to
 * {@link BASE_URL} so resolution is origin-independent.
 *
 * Heading font (`Space Grotesk`, issue #2659): article/OG cold-loads showed a
 * dominant ~0.32 layout shift (live PerformanceObserver, 2026-06-23) because
 * this block carried ONLY the Inter @font-face — the `<h1>/<h2>/<h3>` were
 * painted in the `ui-sans-serif/system-ui` fallback at first paint, then the
 * async entry sheet's `Space Grotesk` @font-face landed ~700ms later and the
 * heading metrics changed (real SG metrics ascent 98.4% / descent 29.2% differ
 * from the fallback box), reflowing the whole article column. Fix: declare the
 * `Space Grotesk` @font-face + `h1,h2,h3{font-family:"Space Grotesk",…}` HERE so
 * it is known at first paint, with `font-display:optional` (the font is also
 * `<link rel=preload>`-ed in both shells, so on most cold-loads it is ready
 * within the ~100ms `optional` window and headings paint in SG with NO swap; on
 * the rare slow load it is not, so the fallback is kept for the page lifetime —
 * either way the swap reflow is eliminated by construction). The `size-adjust/
 * ascent-override/descent-override` overrides keep SG's box matched to the
 * fallback box (same calibrated 90%/22% as Inter, same fallback stack) so the
 * optional-fallback case stays visually stable too.
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
 *     `margin:0 auto` ← `seo-static.css`'s `main.seo-static-content{…}` rule
 *     (the dominant block→grid reflow); `max-width:min(100%,1120px)` ← the
 *     authoritative async `index.css:254 main.seo-static-content` rule. Reserve
 *     and source are kept byte-identical here (was `1120px` — equivalent used
 *     width for an in-flow block, but the literal `min(100%,1120px)` mirror is
 *     drift-proof and matches `index.css` exactly; #2747 item 3).
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
  'main.seo-static-content{max-width:min(100%,1120px);margin:0 auto;padding:32px clamp(16px,4vw,32px) 56px;display:grid;grid-template-columns:minmax(0,1fr);gap:12px}' +
  'main.seo-static-content>*{min-width:0;width:100%}';

/**
 * Static SEO HERO layout, mirrored from the ASYNC `seo-static.css` into this
 * SYNCHRONOUS first-paint block. The SECOND-order CLS residual that surfaced
 * once {@link SEO_STATIC_GRID_RESERVE_CSS} removed the dominant page-grid
 * reflow (PR #2740/#2748).
 *
 * Why (CLS fix): the hero rendered by `seoContentTokens.ts` (`renderStatGrid`,
 * breadcrumb, stat tiles, primary CTA) is laid out PURELY by `seo-static.css`,
 * which `media="print"`-swaps in ~400ms after first paint. The stat-tile
 * container `.s-XENO3U` is the dominant offender: until the async sheet lands
 * it renders as default `display:block`, so the 3–4 tiles STACK vertically
 * (tall column); promotion to `display:grid` (auto-fit, 180px min) flows them
 * into a single short row and everything below — the content `<section>` and
 * the CTA — jumps up. Live desktop shift 0.39 at ~515ms (PerformanceObserver
 * buffered, sources `header`, `.s-XENO3U`, `section`, `a.s-cta`) on
 * `/cerca-lavoro-ticino/infermieri/`, the new top shift after #2740 cut the
 * page-grid 0.70 to ~0.17.
 *
 * Reserved values mirror the async rules VERBATIM (all hooks are STABLE atomic
 * class names hard-coded by `seoContentTokens.ts` + `jobsSeoPagesPlugin.ts`,
 * not per-build hashes):
 *   - `.s-XENO3U` stat grid, `.s-cta` CTA flex, breadcrumb `.s-bcr` margin, the
 *     hero wrapper `.s-sy52lX` margin — the structural collapse.
 *   - tile box (`.s-tbase/.s-tacc/.s-tok/.s-twrn/.s-tdng`) `padding:18px` +
 *     `border:1px` and the tile `.s-tlbl`/`.s-tval` font metrics — so each
 *     tile's height (hence the grid row height) is identical at first paint.
 *
 * The TI city/canton job hubs `/cerca-lavoro-{canton}/{city}/` — the DOMINANT
 * page type on the `/cerca-lavoro-*` surface — render a PARALLEL, independently
 * hard-coded stat-grid system (`jobsSeoPagesPlugin.ts`: `<header class="s-S_0cal">`
 * + `<section class="s-S6PRaY">` with `.s-CGuDZg`/`.s-3kP_AL`/`.s-0kclVO` tiles,
 * `.s-9UotdJ` values, `.s-JFi4vt`/`.s-z4q8yI`/`.s-AnMfGC` labels) that does NOT
 * reuse `renderStatGrid`/`.s-XENO3U`, so the reserve above never touched it and
 * the SAME block→grid collapse still fired there. We mirror that system too:
 *   - `.s-S6PRaY` grid (`minmax(220px)`, `margin:0 0 18px`) — the collapse.
 *   - its tile box + value/label metrics, grouped with the `.s-t*` twins where
 *     layout-identical (`.s-9UotdJ`==`.s-tval`; `.s-JFi4vt`/`.s-z4q8yI`==`.s-tlbl`).
 *   - the official-competitions hub variant (`#official-competitions` editorial
 *     page) emits a THIRD tile shape in the same `.s-S6PRaY` grid (issue #2770
 *     item 2 audit): `.s-Fy0wEh` box (layout-identical to `.s-0kclVO` —
 *     `padding:18px`/`border-radius:22px`), `.s-aoTYtA` label (==`.s-AnMfGC`) and
 *     `.s-ahW6q9` value (its OWN metrics — `font-size:15px`, NOT the `.s-9UotdJ`
 *     28px — because the value is a `concorsi.ti.ch` link, not a count). The link
 *     itself (`.s-U9K6Vf`) is colour-only → paint, not layout → not reserved.
 *   - the city-hub `<header>` is `.s-S_0cal sx-hero`; its async padding+margin
 *     live on `.sx-hero` (reserved below), NOT `.s-S_0cal` (whose margin loses
 *     the cascade to `.sx-hero` — see the `.sx-hero` note).
 *
 * Borders use `transparent` (the async sheet paints the real colour — paint,
 * not layout). Pure space reservation (AGENTS.md §7): no ad/content/markup
 * change; the CTA/tiles are the same boxes before and after.
 */
export const SEO_STATIC_HERO_RESERVE_CSS =
  '.s-XENO3U{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:0 0 24px}' +
  '.s-S6PRaY{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 18px}' +
  '.s-tbase,.s-tacc,.s-tok,.s-twrn,.s-tdng,.s-CGuDZg,.s-3kP_AL{padding:18px;border:1px solid transparent;border-radius:14px}' +
  '.s-0kclVO,.s-Fy0wEh{padding:18px;border:1px solid transparent;border-radius:22px}' +
  '.s-tlbl,.s-JFi4vt,.s-z4q8yI{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em}' +
  '.s-AnMfGC,.s-aoTYtA{font-size:12px;font-weight:700;text-transform:uppercase}' +
  '.s-tval,.s-9UotdJ{margin-top:8px;font-size:28px;font-weight:800;line-height:1.1}' +
  '.s-ahW6q9{margin-top:8px;font-size:15px;font-weight:800}' +
  '.s-bcr{margin:0 0 14px;font-size:13px}' +
  // font-weight:700 reserved so CTA glyph width (hence any adjacent inline
  // element) is stable; mobile mirrors the async ≤639px full-width swap.
  '.s-cta{display:inline-flex;align-items:center;gap:6px;padding:12px 20px;font-weight:700}' +
  // hero <header> wrappers. `.sx-hero` (renderLandingHero + city/canton hub
  // `<header class="s-S_0cal sx-hero">`) applies async-only padding
  // (`20px 16px`→`24px 22px`@≥640) + `margin:0 0 20px` — verified live on
  // /cerca-lavoro-argovia/bozberg/ (24px 22px, margin 20px desktop). At first
  // paint padding is 0, so the swap expands the header ~48px and pushes the
  // stat-grid/section/CTA down (review #2749 🔴); reserving it also keeps the
  // header inner width constant so auto-fit can't recompute a column count.
  // The async `.sx-hero{margin:0 0 20px}` (later in the sheet) WINS the cascade
  // over `.s-S_0cal{margin-bottom:28px}`, so the final city-hub header margin is
  // 20px — reserve `.sx-hero` (NOT `.s-S_0cal`, which would first-paint at 28px
  // and shift 8px). The other header variant `.s-sy52lX` (profession/recency
  // landings, e.g. /cerca-lavoro-ticino/infermieri/) has padding 0 (verified
  // live) — reserve its 24px margin only.
  '.sx-hero{padding:20px 16px;margin:0 0 20px}' +
  '@media(min-width:640px){.sx-hero{padding:24px 22px}}' +
  '.s-sy52lX{margin-bottom:24px}' +
  // city-hub hero TYPOGRAPHY (jobsSeoPagesPlugin hardcoded classes): H1, kicker
  // and intro paragraphs are async-only → at first paint the H1 falls to UA
  // defaults (≈2em / line-height 1.5 / ~0.67em margin) and the kicker/intro lose
  // their box/width, shifting the stat-grid below. Mirror the resolved metrics
  // (live-measured on /cerca-lavoro-argovia/bozberg/: H1 font 51.2px=3.2rem,
  // line-height 1.15, margin-bottom 14px). The LANDING hero (renderLandingHero /
  // infermieri etc.) styles its H1 INLINE (`<h1 style="font-size:clamp(...)">`)
  // so it is already first-paint-stable and needs no class reserve here.
  '.s-P0Hs0W{margin:0 0 14px;font-size:clamp(2rem,5vw,3.2rem);line-height:1.15}' +
  '.sx-kick{display:inline-flex;align-items:center;gap:6px;border:1px solid transparent;border-radius:999px;padding:4px 12px;font-weight:600;margin:0 0 8px}' +
  '.s-zNiFzy{margin:0 0 8px;font-size:13px;font-weight:700}' +
  '.s-wU5Nrr{margin:0 0 14px;font-size:18px;line-height:1.6;max-width:860px}' +
  '.s-rDKEKn{margin:0;line-height:1.7;max-width:860px}' +
  '@media(max-width:639px){.s-cta{display:flex;width:100%;justify-content:center}}';

/**
 * First-paint reservation for the SPA sticky-nav header height inside an
 * otherwise-empty `#root`.
 *
 * On staticOverlay pages emitted via `buildSimplePage(seoContentOutsideRoot)`,
 * `#root` is empty at first paint and the SEO content (rail grid /
 * `main.seo-static-content`) is a body-sibling BELOW it. When React mounts, the
 * sticky nav header (`<nav>`'s inner `h-14 md:h-20`) fills `#root` and pushes the
 * sibling content down by the header height — live-measured rail-grid `24→99`
 * (+75px) at ~944ms on /cerca-lavoro-argovia/bozberg/ (~0.08 CLS), the residual
 * after the hero reserves landed (#2740/#2749). htmlTemplate emits a
 * `<div class="ft-hdr-reserve">` spacer as the sole child of `#root`; pinning its
 * height here makes `#root` already the header's height at first paint, so the
 * content below starts where it ends up. `h-14`=56px (<md) / `md:h-20`=80px
 * (≥768px) — matched exactly so neither breakpoint over/under-reserves.
 *
 * NOTE: this is the `#root`-height-floor fix WITHOUT touching `#root` itself —
 * the gate `criticalCssRootHeight.test.ts` forbids any `#root{min-height}` in
 * this block (the #1586/#2162 empty-band regression), so the height lives on the
 * inner spacer class instead. `createRoot().render()` replaces #root's children,
 * so the spacer is gone post-mount and the real header (same height) shows with
 * no shift.
 */
export const ROOT_HEADER_RESERVE_CSS =
  '.ft-hdr-reserve{height:56px}' +
  '@media(min-width:768px){.ft-hdr-reserve{height:80px}}';

/**
 * Search-index hub layout, mirrored from the ASYNC `seo-static.css` into this
 * SYNCHRONOUS first-paint block. This is the THIRD static-content page family —
 * the `relatedSearchClustersPlugin` curated hub at `/cerca-lavoro-ticino/ricerca/`
 * (+ `/…/ricerca/page-N/` and en/search · de/suche · fr/recherche) plus the
 * `ricerca-{slug}` cluster landings — which {@link SEO_STATIC_HERO_RESERVE_CSS}
 * (scoped to the `seoContentTokens`/`jobsSeoPagesPlugin` `.s-XENO3U`/`.s-S6PRaY`
 * stat-grid hubs) never touched.
 *
 * Why (CLS fix, issue #2729): `/ricerca/` is path #1 by volume and CLS degrades
 * AdSense RPM. After #2776 made the bare hub `staticOverlay` (killing the SPA
 * teardown footer-bounce) and #2740 reserved the `main.seo-static-content`
 * page-grid, the dominant RESIDUAL is the inner `<article class="s-haN35X">`
 * subtree: its padding, the header/section margins and the H1/lede/H2 typography
 * are ALL async-only. Until `seo-static.css` `media="print"`-swaps in (~1.4s,
 * cold load), the article has padding 0, the sections have no bottom margin and
 * the headings fall to UA-default metrics → a compact column; when the sheet
 * lands the article gains `padding:24px 16px 56px`, every section gains its
 * `margin:0 0 22px`/`12px` and the headings grow → the whole 3.5k-px column
 * reflows downward — live-measured cumulative desktop shift 0.886 at ~1.27s
 * (PerformanceObserver buffered, sources `article.s-haN35X`,
 * `section.s-USY9TF`, `div.ft-rail-grid`, 1440px, 2026-06-23; warm load where
 * the sheet is cached is already 0.074). Mirroring the resolved geometry here
 * makes first paint == final layout so the swap moves nothing.
 *
 * Reserved values mirror the async `seo-static.css` rules VERBATIM (all hooks
 * are STABLE atomic hash classes hard-coded by `relatedSearchClustersPlugin.ts`,
 * not per-build hashes): article wrapper `.s-haN35X`; header `.s-S1RSUf` margin;
 * H1 `.s-JvjD5-`, lede `.s-zd3YWl`, datestamp `.s-Znu67P` and section-heading
 * `.s-sOn5-B` typography (the font-metric reflow); the city-section `.s-h0CoDf`
 * and city-block `.s-USY9TF` bottom margins (the per-section vertical stack that
 * accumulates the bulk of the shift). Breadcrumb `.s-bcr` is already reserved in
 * {@link SEO_STATIC_HERO_RESERVE_CSS}. Pure space reservation (AGENTS.md §7): no
 * ad/content/markup added or removed; the in-flow `<ins>` slots are the same
 * boxes before and after, so monetization is untouched.
 */
export const SEO_SEARCH_HUB_RESERVE_CSS =
  '.s-haN35X{max-width:1100px;margin:0 auto;padding:24px 16px 56px}' +
  '.s-S1RSUf{margin-bottom:18px}' +
  '.s-JvjD5-{margin:0 0 10px;font-size:clamp(1.6rem,4vw,2.4rem);line-height:1.18}' +
  '.s-zd3YWl{margin:0;font-size:16px;line-height:1.55;max-width:820px}' +
  '.s-Znu67P{margin:6px 0 0;font-size:13px}' +
  '.s-sOn5-B{margin:0 0 12px;font-size:22px}' +
  '.s-h0CoDf{margin:0 0 12px}' +
  '.s-USY9TF{margin:0 0 22px}';

/**
 * Generic SEO "article shell" layout, mirrored from the ASYNC `seo-static.css`
 * into this SYNCHRONOUS first-paint block. Unlike {@link SEO_STATIC_HERO_RESERVE_CSS}
 * (stat-tile heroes) and {@link SEO_SEARCH_HUB_RESERVE_CSS} (one hub family),
 * this reserve targets a set of hashed utility classes (`.s-xzWvwM` article
 * wrapper, `.s-ziawP1` section spacer, `.s-nzJw8o` auto-fit card grid, `.s-card`
 * FAQ `<details>`, …) that are SHARED — by construction, the class hash is a
 * content hash of the resolved Tailwind utility list, so identical classes
 * always resolve to the identical rule — across a large slice of the SEO
 * feature-plugin surface (grep confirmed 2026-07-16, issue #4302): border-wait,
 * fuel-daily, health-premiums, weekly-employers, job-market-snapshot,
 * job-recency, career/nursing/profession landings, cost-of-living, orphan-query,
 * annual/market report and more — none of it was in this file, so ALL of those
 * page families still had the same "async sheet lands ~400-1400ms after first
 * paint, block→padded-card/grid layout snaps into place" reflow that
 * {@link SEO_SEARCH_HUB_RESERVE_CSS}'s header already documents for
 * `/ricerca/` (cumulative desktop shift 0.886) — matching the disproportionate
 * field CLS on `/traffico-dogane/chiasso-brogeda/oggi/` (p75 0.82, #4302) despite
 * that page having correctly-sized webcam/SVG-chart widgets (ruled out
 * separately). Per AGENTS.md §6 (fix the whole sibling-pattern class in one PR):
 * since critical CSS is ONE shared file consumed by every SEO plugin via
 * `buildSeoPageHtml`, reserving these classes here fixes every consumer at
 * once — no per-plugin edits needed.
 *
 * Values mirror the async `seo-static.css` rule VERBATIM for every
 * layout-affecting property (display, grid-template-columns, gap, margin,
 * padding, font-size, line-height, font-weight, list-style). Border colours
 * and backgrounds are PAINT, not layout, so they are replaced with
 * `transparent`/omitted (border WIDTH is kept — it is part of the box in the
 * `border-box` reset already active) — same convention as
 * {@link SEO_STATIC_HERO_RESERVE_CSS}.
 */
export const SEO_ARTICLE_SHELL_RESERVE_CSS =
  '.s-xzWvwM{min-width:0;max-width:1100px;margin:0 auto;padding:32px 20px 56px}' +
  '.s-Nv0GaD{margin-bottom:22px}' +
  '.s-ziawP1{margin:0 0 24px}' +
  '.s-nzJw8o{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px}' +
  '.s-Zv0TZw{padding:18px;border-radius:18px;border:1px solid transparent}' +
  '.s-k7sbVR{display:inline-block;margin-left:8px;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600;border:1px solid transparent;vertical-align:middle}' +
  '.s-iUCmjg{margin-top:8px;font-size:14px;font-weight:700;line-height:1.4}' +
  '.s-QHHL-d{font-size:12px;font-weight:700;text-transform:uppercase}' +
  '.s-54GADM{margin-top:8px;font-size:14px;font-weight:700}' +
  '.s-rUEUjv{margin:0 0 18px;padding:14px 18px;border-radius:12px;border:1px solid transparent;font-size:14px;line-height:1.5}' +
  '.s-KZc0LQ{margin:0 0 28px}' +
  '.s-6B_yvh,.s-fwhUlc,.s-GlcYCp{margin:0 0 28px;padding:18px 22px;border-radius:14px;border:1px solid transparent}' +
  '.s-Y-l-tN{list-style:none;margin:0;padding:0;font-size:14px;line-height:1.5}' +
  '.s-IHVixW{padding:8px 0;border-bottom:1px solid transparent}' +
  '.s-jM-wmV{margin:12px 0 0;font-size:14px;line-height:1.55}' +
  '.s-Wnl1Ux{margin:0 0 24px;padding:14px 18px;border-radius:12px;font-size:14px;line-height:1.5}' +
  '.s-GCEyQg{margin:32px 0 0;padding:24px 22px;border-radius:16px;border:1px solid transparent}' +
  '.s-yOfiVn{margin:0;line-height:1.7;max-width:72ch;font-size:15px}' +
  '.s-sC82IX{margin-top:32px}' +
  '.s-card{padding:14px 16px;border:1px solid transparent;border-radius:14px}' +
  '.s-OCic8j{margin:10px 0 0;line-height:1.6}';

export const CRITICAL_CSS =
  `@font-face{font-family:Inter;font-style:normal;font-weight:400 700;font-display:swap;src:url(${BASE_URL}/fonts/inter-latin.woff2) format("woff2");size-adjust:100%;ascent-override:90%;descent-override:22%;line-gap-override:0%;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}@font-face{font-family:"Space Grotesk";font-style:normal;font-weight:300 700;font-display:optional;src:url(${BASE_URL}/fonts/space-grotesk-latin.woff2) format("woff2");size-adjust:100%;ascent-override:90%;descent-override:22%;line-gap-override:0%;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}*,::after,::before{box-sizing:border-box;border:0 solid #e5e7eb}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased;line-height:1.5}h1,h2,h3{font-family:"Space Grotesk",ui-sans-serif,system-ui,-apple-system,sans-serif}.bg-surface-alt{background-color:#f8fafc}.dark .dark\\:bg-surface-inverted,.dark.bg-surface-inverted{background-color:#020617}.text-heading{color:var(--color-heading,#0f172a)}.dark .dark\\:text-heading{color:#f1f5f9}body{min-height:100vh}` +
  RAIL_RESERVE_CSS +
  SEO_STATIC_GRID_RESERVE_CSS +
  SEO_STATIC_HERO_RESERVE_CSS +
  SEO_SEARCH_HUB_RESERVE_CSS +
  SEO_ARTICLE_SHELL_RESERVE_CSS +
  ROOT_HEADER_RESERVE_CSS;

/**
 * Filename `staticScriptsPlugin.ts` writes {@link CRITICAL_CSS} to under
 * `dist/assets/` — STABLE (no content hash), like every other file that
 * plugin emits, so it revalidates via the `/assets/*` `max-age=600` header
 * instead of a rename on every content change.
 */
export const CRITICAL_CSS_FILENAME = 'critical.css';

/**
 * Render-blocking `<link>` for {@link CRITICAL_CSS_FILENAME} — deliberately
 * NOT the `media="print"` async-swap `asyncCssLink()` (`htmlTemplate.ts`)
 * uses for `seo-static.css`/the entry sheet, because this stylesheet must
 * still be in effect at first paint (see the file header comment).
 */
export const CRITICAL_CSS_LINK =
  `<link rel="stylesheet" href="/assets/${CRITICAL_CSS_FILENAME}" data-clarity-unmask="true">`;
