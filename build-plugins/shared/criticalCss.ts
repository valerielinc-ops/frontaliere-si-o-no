import { BASE_URL, SEO_STATIC_CSS_FILENAME, readPublicAsset } from '../constants';
import { deriveSeoStaticFirstPaintReserve } from './seoStaticFirstPaintReserve';

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

/**
 * Theme tokens the {@link TAILWIND_UTILITY_RESERVE_CSS} rules below resolve
 * against, mirrored from the ASYNC `index.css` `@layer theme` `:root` block.
 *
 * Without them the reserve is INERT, not merely approximate: Tailwind v4
 * utilities are emitted as `calc(var(--spacing)*3)` /
 * `var(--text-sm)`, and a `var()` with no fallback and no definition makes the
 * whole declaration invalid-at-computed-value-time — i.e. the browser drops it.
 * So every token referenced by a reserved utility has to be declared here for
 * the reserve to do anything at first paint.
 *
 * Values are copied verbatim from the built sheet (Tailwind v4.1.18 defaults;
 * `index.css`'s own `@theme` block only overrides the font stacks). They live in
 * `@layer base` with the utilities — see {@link TAILWIND_UTILITY_RESERVE_CSS}
 * for why the layer matters.
 */
export const TAILWIND_THEME_TOKENS_RESERVE_CSS =
  ':root{--aspect-video:16/9;--container-2xl:42rem;--container-3xl:48rem;--container-4xl:56rem;--container-5xl:64rem;--container-6xl:72rem;--container-7xl:80rem;--font-display:"Space Grotesk",ui-sans-serif,system-ui,-apple-system,sans-serif;--font-weight-bold:700;--font-weight-light:300;--font-weight-medium:500;--font-weight-normal:400;--font-weight-semibold:600;--leading-relaxed:1.625;--leading-snug:1.375;--leading-tight:1.25;--spacing:.25rem;--text-2xl:1.5rem;--text-2xl--line-height:calc(2/1.5);--text-3xl:1.875rem;--text-3xl--line-height:1.2;--text-4xl:2.25rem;--text-4xl--line-height:calc(2.5/2.25);--text-5xl:3rem;--text-5xl--line-height:1;--text-7xl:4.5rem;--text-7xl--line-height:1;--text-8xl:6rem;--text-8xl--line-height:1;--text-9xl:8rem;--text-9xl--line-height:1;--text-base:1rem;--text-base--line-height:1.5;--text-lg:1.125rem;--text-lg--line-height:calc(1.75/1.125);--text-sm:.875rem;--text-sm--line-height:calc(1.25/.875);--text-xl:1.25rem;--text-xl--line-height:calc(1.75/1.25);--text-xs:.75rem;--text-xs--line-height:calc(1/.75);--tracking-tight:-.025em;--tracking-wide:.025em;--tracking-wider:.05em}';

/**
 * Tailwind PREFLIGHT subset, mirrored from the ASYNC `index.css` `@layer base`
 * into this SYNCHRONOUS first-paint block.
 *
 * Why (CLS fix, issue #5001 point 3): every reserve above this line pins a
 * CONTAINER (the rail grid, `main.seo-static-content`, the hero/stat-tile and
 * article-shell wrappers). None of them pins the UA defaults that Tailwind
 * resets, so until `index.css` `media="print"`-swaps in (~250-400ms) every raw
 * element inside those containers still carries its user-agent box:
 *   - `*{margin:0;padding:0}` missing → `<p>` keeps `margin:1em 0`, `<h1>`
 *     `margin:.67em 0`, `<ul>/<ol>` `padding-left:40px`, `<dd>`
 *     `margin-left:40px`, `<figure>` `margin:1em 40px`;
 *   - `h1..h6{font-size:inherit;font-weight:inherit}` missing → every heading
 *     paints at its UA size/weight and then snaps to the utility/`seo-static.css`
 *     value;
 *   - `ol,ul,menu{list-style:none}` missing → every list item paints with a
 *     marker and re-flows when the marker goes;
 *   - `img,svg,…{display:block}` + `img,video{max-width:100%;height:auto}`
 *     missing → the article hero `<img class="w-full h-auto">` paints at its
 *     intrinsic 1200px width as an inline box on a text baseline.
 * Measured on the local A/B harness (production HTML, only critical.css
 * differing), buffered `layout-shift` attribution at 1350px:
 * `/vivere-in-ticino/comuni-di-frontiera/albiolo/` desktop CLS 0.421,
 * `/articoli-frontaliere/lamal-vs-cmi-frontaliere/` 0.524 — dominated by exactly
 * these per-element resets cascading into the container height.
 *
 * Only the LAYOUT half of preflight is mirrored (box metrics, font metrics,
 * list markers, replaced-element display). Colour/appearance resets stay out:
 * they are paint, not layout, and every byte here is render-blocking.
 *
 * In `@layer base` — same reason as the `*,::after,::before` reset already in
 * {@link CRITICAL_CSS}: unlayered it would outrank `index.css`'s own
 * `@layer utilities` FOREVER, not just until the sheet lands.
 */
export const TAILWIND_PREFLIGHT_RESERVE_CSS =
  '*,:after,:before,::backdrop{box-sizing:border-box;margin:0;padding:0}' +
  'hr{height:0;border-top-width:1px}' +
  'h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit}' +
  'b,strong{font-weight:bolder}' +
  'small{font-size:80%}' +
  'sub,sup{vertical-align:baseline;font-size:75%;line-height:0;position:relative}' +
  'sub{bottom:-.25em}' +
  'sup{top:-.5em}' +
  'summary{display:list-item}' +
  'ol,ul,menu{list-style:none}' +
  'img,svg,video,canvas,audio,iframe,embed,object{vertical-align:middle;display:block}' +
  'img,video{max-width:100%;height:auto}';

/**
 * Tailwind UTILITY subset, mirrored from the ASYNC `index.css`
 * `@layer utilities`/`@layer components` into this SYNCHRONOUS first-paint
 * block.
 *
 * Why (CLS fix, issue #5001 point 3): `AGENTS.md → Static SEO Pages` mandates
 * "Body styling HTML statico: Tailwind utilities only". That makes the whole
 * static SEO surface depend on `index.css` for its layout — and `index.css` is
 * loaded NON-render-blocking (the `media="print"` swap in
 * `htmlTemplate.asyncCssHeadBlock`). Every `.s-*` reserve above this line was
 * written for the plugins that emit hashed atomic classes; the families that
 * follow the AGENTS rule literally and emit raw utilities had NOTHING reserved.
 * The dominant desktop shift on those pages is the block→grid/flex collapse the
 * swap performs: measured on
 * `/vivere-in-ticino/comuni-di-frontiera/albiolo/` (1350px), a single shift of
 * 0.4206 at 252ms whose sources are `dl.mt-5.grid.sm:grid-cols-2.lg:grid-cols-4`
 * (400px tall stacked block → 154px 4-column grid), `header.p-5.sm:p-7`
 * (padding 0 → 28px) and the `div.mx-auto.max-w-6xl.px-4.sm:px-6.lg:px-8`
 * wrapper (padding-inline 0 → 32px, so the whole column re-wraps).
 *
 * Scope: the utilities that the static SEO bodies ACTUALLY use, derived by
 * scanning the `<body>` of one live page per `sitemap.xml` child sitemap (76
 * pages with `main.seo-static-content`, 2026-08-07) and keeping every
 * `index.css` rule whose selector is exactly one of those classes. Only
 * layout-affecting declarations are kept (box metrics, display/flex/grid, font
 * metrics, list-style, border WIDTH, `scrollbar-width`/`-webkit-line-clamp` —
 * both change the box); colours, backgrounds, radii, shadows and transitions
 * are paint and stay out. `var(--tw-*)` runtime overrides are resolved to their
 * fallback because those custom properties do not exist at first paint.
 *
 * In `@layer base`, NOT unlayered — this is what makes the copy safe to keep:
 * `index.css`'s own `@layer utilities` sorts after `base`, so the moment the
 * async sheet lands the authoritative rule wins and a stale value here can only
 * ever affect the pre-swap frame. A hand-copied Tailwind value that drifts is
 * therefore a first-paint approximation, never a permanent wrong layout.
 * (Layer order is fixed by first appearance: critical.css declares `base`
 * first, so the merged order is `base` → `properties` → `theme` → `components`
 * → `utilities`.)
 *
 * Pure space reservation (AGENTS.md §7): no ad, content or markup is added or
 * removed — the in-flow `<ins>` slots are the same boxes before and after.
 */
export const TAILWIND_UTILITY_RESERVE_CSS =
  '.jc-card{border-style:solid;border-width:1px;min-height:72px;padding:calc(var(--spacing)*3)}' +
  '.jc-link{display:block}' +
  '.jc-row{align-items:flex-start;gap:calc(var(--spacing)*3);display:flex}' +
  '.jc-logoslot{height:calc(var(--spacing)*10);width:calc(var(--spacing)*10);border-style:solid;border-width:1px;flex-shrink:0;justify-content:center;align-items:center;display:flex;overflow:hidden}' +
  '.jc-logoimg{height:calc(var(--spacing)*7);width:calc(var(--spacing)*7)}' +
  '.jc-meta{min-width:calc(var(--spacing)*0);flex:1}' +
  '.jc-title{font-family:var(--font-display);font-size:var(--text-sm);line-height:var(--leading-tight);font-weight:var(--font-weight-bold)}' +
  '.jc-sub{margin-top:calc(var(--spacing)*.5);-webkit-line-clamp:2;font-size:var(--text-xs);line-height:var(--text-xs--line-height);-webkit-box-orient:vertical;display:-webkit-box;overflow:hidden}' +
  '.jc-salary{margin-top:calc(var(--spacing)*1);align-items:center;gap:calc(var(--spacing)*1);font-size:var(--text-xs);line-height:var(--text-xs--line-height);font-weight:var(--font-weight-semibold);display:inline-flex}' +
  '.jc-chips{margin-top:calc(var(--spacing)*2);align-items:center;gap:calc(var(--spacing)*2);font-size:var(--text-xs);line-height:var(--text-xs--line-height);flex-wrap:wrap;display:flex}' +
  '.jc-chip{align-items:center;gap:calc(var(--spacing)*1);display:inline-flex}' +
  '.jc-chip-pill{padding-inline:calc(var(--spacing)*1.5);padding-block:calc(var(--spacing)*.5)}' +
  '.jc-newbadge{margin-left:calc(var(--spacing)*1.5);align-items:center;gap:calc(var(--spacing)*.5);padding-inline:calc(var(--spacing)*1.5);padding-block:calc(var(--spacing)*.5);font-size:var(--text-xs);line-height:var(--text-xs--line-height);font-weight:var(--font-weight-bold);letter-spacing:var(--tracking-wide);text-transform:uppercase;display:inline-flex}' +
  '.ec-card{border-style:solid;border-width:1px;padding:calc(var(--spacing)*3)}' +
  '.ec-link{display:block}' +
  '.ec-row{align-items:center;gap:calc(var(--spacing)*3);display:flex}' +
  '.ec-logoslot{border-style:solid;border-width:1px;flex-shrink:0;justify-content:center;align-items:center;display:flex;overflow:hidden}' +
  '.ec-logoimg{height:calc(var(--spacing)*7);width:calc(var(--spacing)*7)}' +
  '.ec-title{font-family:var(--font-display);font-size:var(--text-sm);line-height:var(--leading-tight);font-weight:var(--font-weight-bold)}' +
  '.ec-sub{margin-top:calc(var(--spacing)*1);font-size:var(--text-xs);line-height:var(--leading-snug)}' +
  '.ec-meta{min-width:calc(var(--spacing)*0);flex:1}' +
  '.ec-cmpct{align-items:center;gap:calc(var(--spacing)*2.5);border-style:solid;border-width:1px;display:flex;padding:calc(var(--spacing)*3)}' +
  '.sr-only{white-space:nowrap;border-width:0;width:1px;height:1px;margin:-1px;padding:0;position:absolute;overflow:hidden}' +
  '.absolute{position:absolute}' +
  '.relative{position:relative}' +
  '.static{position:static}' +
  '.inset-y-0{inset-block:calc(var(--spacing)*0)}' +
  '.-top-4{top:calc(var(--spacing)*-4)}' +
  '.top-0{top:calc(var(--spacing)*0)}' +
  '.top-2{top:calc(var(--spacing)*2)}' +
  '.-right-4{right:calc(var(--spacing)*-4)}' +
  '.right-0{right:calc(var(--spacing)*0)}' +
  '.bottom-0{bottom:calc(var(--spacing)*0)}' +
  '.left-2{left:calc(var(--spacing)*2)}' +
  '.m-0{margin:calc(var(--spacing)*0)}' +
  '.-mx-1{margin-inline:calc(var(--spacing)*-1)}' +
  '.mx-2{margin-inline:calc(var(--spacing)*2)}' +
  '.mx-auto{margin-inline:auto}' +
  '.my-1{margin-block:calc(var(--spacing)*1)}' +
  '.my-2{margin-block:calc(var(--spacing)*2)}' +
  '.my-2\\.5{margin-block:calc(var(--spacing)*2.5)}' +
  '.my-3{margin-block:calc(var(--spacing)*3)}' +
  '.my-4{margin-block:calc(var(--spacing)*4)}' +
  '.my-6{margin-block:calc(var(--spacing)*6)}' +
  '.my-8{margin-block:calc(var(--spacing)*8)}' +
  '.my-10{margin-block:calc(var(--spacing)*10)}' +
  '.-mt-2{margin-top:calc(var(--spacing)*-2)}' +
  '.mt-0\\.5{margin-top:calc(var(--spacing)*.5)}' +
  '.mt-1{margin-top:calc(var(--spacing)*1)}' +
  '.mt-1\\.5{margin-top:calc(var(--spacing)*1.5)}' +
  '.mt-2{margin-top:calc(var(--spacing)*2)}' +
  '.mt-3{margin-top:calc(var(--spacing)*3)}' +
  '.mt-4{margin-top:calc(var(--spacing)*4)}' +
  '.mt-5{margin-top:calc(var(--spacing)*5)}' +
  '.mt-6{margin-top:calc(var(--spacing)*6)}' +
  '.mt-8{margin-top:calc(var(--spacing)*8)}' +
  '.mt-10{margin-top:calc(var(--spacing)*10)}' +
  '.mb-1{margin-bottom:calc(var(--spacing)*1)}' +
  '.mb-1\\.5{margin-bottom:calc(var(--spacing)*1.5)}' +
  '.mb-2{margin-bottom:calc(var(--spacing)*2)}' +
  '.mb-2\\.5{margin-bottom:calc(var(--spacing)*2.5)}' +
  '.mb-3{margin-bottom:calc(var(--spacing)*3)}' +
  '.mb-4{margin-bottom:calc(var(--spacing)*4)}' +
  '.mb-5{margin-bottom:calc(var(--spacing)*5)}' +
  '.mb-6{margin-bottom:calc(var(--spacing)*6)}' +
  '.mb-7{margin-bottom:calc(var(--spacing)*7)}' +
  '.ml-2{margin-left:calc(var(--spacing)*2)}' +
  '.ml-5{margin-left:calc(var(--spacing)*5)}' +
  '.line-clamp-2{-webkit-line-clamp:2;-webkit-box-orient:vertical;display:-webkit-box;overflow:hidden}' +
  '.block{display:block}' +
  '.flex{display:flex}' +
  '.grid{display:grid}' +
  '.hidden{display:none}' +
  '.inline{display:inline}' +
  '.inline-block{display:inline-block}' +
  '.inline-flex{display:inline-flex}' +
  '.aspect-video{aspect-ratio:var(--aspect-video)}' +
  '.h-1\\.5{height:calc(var(--spacing)*1.5)}' +
  '.h-2{height:calc(var(--spacing)*2)}' +
  '.h-2\\.5{height:calc(var(--spacing)*2.5)}' +
  '.h-3{height:calc(var(--spacing)*3)}' +
  '.h-3\\.5{height:calc(var(--spacing)*3.5)}' +
  '.h-9{height:calc(var(--spacing)*9)}' +
  '.h-12{height:calc(var(--spacing)*12)}' +
  '.h-auto{height:auto}' +
  '.h-full{height:100%}' +
  '.min-h-\\[44px\\]{min-height:44px}' +
  '.w-1\\.5{width:calc(var(--spacing)*1.5)}' +
  '.w-2\\.5{width:calc(var(--spacing)*2.5)}' +
  '.w-3{width:calc(var(--spacing)*3)}' +
  '.w-3\\.5{width:calc(var(--spacing)*3.5)}' +
  '.w-8{width:calc(var(--spacing)*8)}' +
  '.w-9{width:calc(var(--spacing)*9)}' +
  '.w-12{width:calc(var(--spacing)*12)}' +
  '.w-\\[68px\\]{width:68px}' +
  '.w-full{width:100%}' +
  '.max-w-2xl{max-width:var(--container-2xl)}' +
  '.max-w-3xl{max-width:var(--container-3xl)}' +
  '.max-w-4xl{max-width:var(--container-4xl)}' +
  '.max-w-5xl{max-width:var(--container-5xl)}' +
  '.max-w-6xl{max-width:var(--container-6xl)}' +
  '.max-w-7xl{max-width:var(--container-7xl)}' +
  '.max-w-\\[820px\\]{max-width:820px}' +
  '.max-w-prose{max-width:65ch}' +
  '.min-w-0{min-width:calc(var(--spacing)*0)}' +
  '.min-w-\\[420px\\]{min-width:420px}' +
  '.flex-1{flex:1}' +
  '.flex-shrink-0{flex-shrink:0}' +
  '.shrink-0{flex-shrink:0}' +
  '.flex-grow{flex-grow:1}' +
  '.list-disc{list-style-type:disc}' +
  '.list-none{list-style-type:none}' +
  '.grid-cols-1{grid-template-columns:repeat(1,minmax(0,1fr))}' +
  '.grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}' +
  '.grid-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}' +
  '.grid-cols-\\[68px_32px_1fr_88px\\]{grid-template-columns:68px 32px 1fr 88px}' +
  '.flex-col{flex-direction:column}' +
  '.flex-wrap{flex-wrap:wrap}' +
  '.items-baseline{align-items:baseline}' +
  '.items-center{align-items:center}' +
  '.justify-between{justify-content:space-between}' +
  '.justify-center{justify-content:center}' +
  '.gap-0\\.5{gap:calc(var(--spacing)*.5)}' +
  '.gap-1{gap:calc(var(--spacing)*1)}' +
  '.gap-1\\.5{gap:calc(var(--spacing)*1.5)}' +
  '.gap-2{gap:calc(var(--spacing)*2)}' +
  '.gap-2\\.5{gap:calc(var(--spacing)*2.5)}' +
  '.gap-3{gap:calc(var(--spacing)*3)}' +
  '.gap-4{gap:calc(var(--spacing)*4)}' +
  '.gap-5{gap:calc(var(--spacing)*5)}' +
  '.gap-6{gap:calc(var(--spacing)*6)}' +
  '.gap-x-3{column-gap:calc(var(--spacing)*3)}' +
  '.gap-y-1{row-gap:calc(var(--spacing)*1)}' +
  '.truncate{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}' +
  '.overflow-hidden{overflow:hidden}' +
  '.overflow-x-auto{overflow-x:auto}' +
  '.overflow-x-hidden{overflow-x:hidden}' +
  '.border{border-style:solid;border-width:1px}' +
  '.border-t{border-top-width:1px}' +
  '.border-b{border-bottom-width:1px}' +
  '.p-0{padding:calc(var(--spacing)*0)}' +
  '.p-2{padding:calc(var(--spacing)*2)}' +
  '.p-3{padding:calc(var(--spacing)*3)}' +
  '.p-4{padding:calc(var(--spacing)*4)}' +
  '.p-5{padding:calc(var(--spacing)*5)}' +
  '.p-6{padding:calc(var(--spacing)*6)}' +
  '.px-1{padding-inline:calc(var(--spacing)*1)}' +
  '.px-2\\.5{padding-inline:calc(var(--spacing)*2.5)}' +
  '.px-3{padding-inline:calc(var(--spacing)*3)}' +
  '.px-3\\.5{padding-inline:calc(var(--spacing)*3.5)}' +
  '.px-4{padding-inline:calc(var(--spacing)*4)}' +
  '.px-5{padding-inline:calc(var(--spacing)*5)}' +
  '.py-0\\.5{padding-block:calc(var(--spacing)*.5)}' +
  '.py-1{padding-block:calc(var(--spacing)*1)}' +
  '.py-1\\.5{padding-block:calc(var(--spacing)*1.5)}' +
  '.py-2{padding-block:calc(var(--spacing)*2)}' +
  '.py-2\\.5{padding-block:calc(var(--spacing)*2.5)}' +
  '.py-3{padding-block:calc(var(--spacing)*3)}' +
  '.py-3\\.5{padding-block:calc(var(--spacing)*3.5)}' +
  '.py-4{padding-block:calc(var(--spacing)*4)}' +
  '.py-6{padding-block:calc(var(--spacing)*6)}' +
  '.pt-2{padding-top:calc(var(--spacing)*2)}' +
  '.pt-6{padding-top:calc(var(--spacing)*6)}' +
  '.pr-3{padding-right:calc(var(--spacing)*3)}' +
  '.pr-8{padding-right:calc(var(--spacing)*8)}' +
  '.pb-1{padding-bottom:calc(var(--spacing)*1)}' +
  '.pb-3{padding-bottom:calc(var(--spacing)*3)}' +
  '.pb-14{padding-bottom:calc(var(--spacing)*14)}' +
  '.pl-3{padding-left:calc(var(--spacing)*3)}' +
  '.pl-5{padding-left:calc(var(--spacing)*5)}' +
  '.text-center{text-align:center}' +
  '.text-left{text-align:left}' +
  '.text-right{text-align:right}' +
  '.font-display{font-family:var(--font-display)}' +
  '.text-2xl{font-size:var(--text-2xl);line-height:var(--text-2xl--line-height)}' +
  '.text-3xl{font-size:var(--text-3xl);line-height:var(--text-3xl--line-height)}' +
  '.text-4xl{font-size:var(--text-4xl);line-height:var(--text-4xl--line-height)}' +
  '.text-7xl{font-size:var(--text-7xl);line-height:var(--text-7xl--line-height)}' +
  '.text-8xl{font-size:var(--text-8xl);line-height:var(--text-8xl--line-height)}' +
  '.text-base{font-size:var(--text-base);line-height:var(--text-base--line-height)}' +
  '.text-lg{font-size:var(--text-lg);line-height:var(--text-lg--line-height)}' +
  '.text-sm{font-size:var(--text-sm);line-height:var(--text-sm--line-height)}' +
  '.text-xl{font-size:var(--text-xl);line-height:var(--text-xl--line-height)}' +
  '.text-xs{font-size:var(--text-xs);line-height:var(--text-xs--line-height)}' +
  '.text-\\[11px\\]{font-size:11px}' +
  '.text-\\[13px\\]{font-size:13px}' +
  '.text-\\[15px\\]{font-size:15px}' +
  '.text-\\[26px\\]{font-size:26px}' +
  '.leading-5{line-height:calc(var(--spacing)*5)}' +
  '.leading-6{line-height:calc(var(--spacing)*6)}' +
  '.leading-7{line-height:calc(var(--spacing)*7)}' +
  '.leading-none{line-height:1}' +
  '.leading-relaxed{line-height:var(--leading-relaxed)}' +
  '.leading-snug{line-height:var(--leading-snug)}' +
  '.leading-tight{line-height:var(--leading-tight)}' +
  '.font-bold{font-weight:var(--font-weight-bold)}' +
  '.font-light{font-weight:var(--font-weight-light)}' +
  '.font-medium{font-weight:var(--font-weight-medium)}' +
  '.font-normal{font-weight:var(--font-weight-normal)}' +
  '.font-semibold{font-weight:var(--font-weight-semibold)}' +
  '.tracking-tight{letter-spacing:var(--tracking-tight)}' +
  '.tracking-wide{letter-spacing:var(--tracking-wide)}' +
  '.tracking-wider{letter-spacing:var(--tracking-wider)}' +
  '.whitespace-nowrap{white-space:nowrap}' +
  '.uppercase{text-transform:uppercase}' +
  '.scrollbar-hide{-ms-overflow-style:none;scrollbar-width:none}' +
  '.scrollbar-hide::-webkit-scrollbar{display:none}' +
  '@media(min-width:40rem){' +
    '.jc-card{padding:calc(var(--spacing)*4)}' +
    '.jc-logoslot{height:calc(var(--spacing)*14);width:calc(var(--spacing)*14)}' +
    '.jc-logoimg{height:calc(var(--spacing)*10);width:calc(var(--spacing)*10)}' +
    '.jc-title{font-size:var(--text-base);line-height:var(--text-base--line-height)}' +
    '.jc-sub{font-size:var(--text-sm);line-height:var(--text-sm--line-height)}' +
    '.jc-salary{font-size:var(--text-sm);line-height:var(--text-sm--line-height)}' +
    '.jc-chips{margin-top:calc(var(--spacing)*3);gap:calc(var(--spacing)*1.5)}' +
    '.jc-newbadge{margin-left:calc(var(--spacing)*2)}' +
    '.ec-card{padding:calc(var(--spacing)*4)}' +
    '.ec-logoimg{height:calc(var(--spacing)*9);width:calc(var(--spacing)*9)}' +
    '.ec-title{font-size:var(--text-base);line-height:var(--text-base--line-height)}' +
    '.ec-sub{font-size:var(--text-sm);line-height:var(--text-sm--line-height)}' +
    '.sm\\:col-span-2{grid-column:span 2/span 2}' +
    '.sm\\:h-10{height:calc(var(--spacing)*10)}' +
    '.sm\\:h-14{height:calc(var(--spacing)*14)}' +
    '.sm\\:w-10{width:calc(var(--spacing)*10)}' +
    '.sm\\:w-14{width:calc(var(--spacing)*14)}' +
    '.sm\\:grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}' +
    '.sm\\:grid-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}' +
    '.sm\\:grid-cols-4{grid-template-columns:repeat(4,minmax(0,1fr))}' +
    '.sm\\:flex-row{flex-direction:row}' +
    '.sm\\:items-start{align-items:flex-start}' +
    '.sm\\:justify-between{justify-content:space-between}' +
    '.sm\\:gap-4{gap:calc(var(--spacing)*4)}' +
    '.sm\\:gap-8{gap:calc(var(--spacing)*8)}' +
    '.sm\\:p-6{padding:calc(var(--spacing)*6)}' +
    '.sm\\:p-7{padding:calc(var(--spacing)*7)}' +
    '.sm\\:p-8{padding:calc(var(--spacing)*8)}' +
    '.sm\\:p-10{padding:calc(var(--spacing)*10)}' +
    '.sm\\:px-6{padding-inline:calc(var(--spacing)*6)}' +
    '.sm\\:text-2xl{font-size:var(--text-2xl);line-height:var(--text-2xl--line-height)}' +
    '.sm\\:text-3xl{font-size:var(--text-3xl);line-height:var(--text-3xl--line-height)}' +
    '.sm\\:text-4xl{font-size:var(--text-4xl);line-height:var(--text-4xl--line-height)}' +
    '.sm\\:text-5xl{font-size:var(--text-5xl);line-height:var(--text-5xl--line-height)}' +
    '.sm\\:text-8xl{font-size:var(--text-8xl);line-height:var(--text-8xl--line-height)}' +
    '.sm\\:text-9xl{font-size:var(--text-9xl);line-height:var(--text-9xl--line-height)}' +
    '.sm\\:text-lg{font-size:var(--text-lg);line-height:var(--text-lg--line-height)}' +
    '.sm\\:text-xl{font-size:var(--text-xl);line-height:var(--text-xl--line-height)}' +
  '}' +
  '@media(min-width:1400px){' +
    '.xlw\\:mx-auto{margin-inline:auto}' +
    '.xlw\\:flex{display:flex}' +
    '.xlw\\:grid{display:grid}' +
    '.xlw\\:max-w-\\[1768px\\]{max-width:1768px}' +
    '.xlw\\:flex-col{flex-direction:column}' +
    '.xlw\\:gap-4{gap:calc(var(--spacing)*4)}' +
  '}' +
  '@media(min-width:48rem){' +
    '.md\\:static{position:static}' +
    '.md\\:line-clamp-2{-webkit-line-clamp:2;-webkit-box-orient:vertical;display:-webkit-box;overflow:hidden}' +
    '.md\\:grid{display:grid}' +
    '.md\\:hidden{display:none}' +
    '.md\\:h-\\[18px\\]{height:18px}' +
    '.md\\:min-h-0{min-height:calc(var(--spacing)*0)}' +
    '.md\\:w-\\[18px\\]{width:18px}' +
    '.md\\:w-full{width:100%}' +
    '.md\\:shrink{flex-shrink:1}' +
    '.md\\:grid-cols-8{grid-template-columns:repeat(8,minmax(0,1fr))}' +
    '.md\\:flex-col{flex-direction:column}' +
    '.md\\:gap-0\\.5{gap:calc(var(--spacing)*.5)}' +
    '.md\\:overflow-x-visible{overflow-x:visible}' +
    '.md\\:px-1{padding-inline:calc(var(--spacing)*1)}' +
    '.md\\:py-1\\.5{padding-block:calc(var(--spacing)*1.5)}' +
    '.md\\:py-3{padding-block:calc(var(--spacing)*3)}' +
    '.md\\:pr-0{padding-right:calc(var(--spacing)*0)}' +
    '.md\\:whitespace-normal{white-space:normal}' +
  '}' +
  '@media(min-width:64rem){' +
    '.lg\\:col-span-3{grid-column:span 3/span 3}' +
    '.lg\\:grid-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}' +
    '.lg\\:grid-cols-4{grid-template-columns:repeat(4,minmax(0,1fr))}' +
    '.lg\\:grid-cols-\\[0\\.85fr_1\\.15fr\\]{grid-template-columns:.85fr 1.15fr}' +
    '.lg\\:grid-cols-\\[1\\.1fr_0\\.9fr\\]{grid-template-columns:1.1fr .9fr}' +
    '.lg\\:px-8{padding-inline:calc(var(--spacing)*8)}' +
  '}';

/**
 * `seo-static.css` LAYOUT subset, DERIVED from that ASYNC sheet at build time
 * (`deriveSeoStaticFirstPaintReserve`) instead of hand-copied — the
 * generalisation of {@link SEO_STATIC_HERO_RESERVE_CSS} /
 * {@link SEO_SEARCH_HUB_RESERVE_CSS} / {@link SEO_ARTICLE_SHELL_RESERVE_CSS},
 * which each pinned one family's `.s-*` classes and left the rest of the sheet
 * (~1000 layout-bearing rules, ~40 static families) unreserved.
 *
 * Why (CLS fix, issue #5001 point 3): `seo-static.css` is the second
 * `media="print"`-swapped sheet on every static SEO page, and it owns the box of
 * every family the three blocks above do not cover. Measured residual with the
 * Tailwind reserve in place but this block absent (local A/B harness on the
 * production HTML, only critical.css differing, desktop 1350px):
 * `/articoli-frontaliere/lamal-vs-cmi-frontaliere/` 0.061 (the whole
 * `.ft-blog-article` prose column — padding, section margins, heading metrics),
 * `/lavoro-argovia-infermiere/` 0.054 (`.cl-fun`),
 * `/cerca-lavoro-ticino/ricerca/` 0.414 (`.s-USY9TF`/`.s-MwMbiH` city blocks).
 * With it: 0.0002 / 0.0019 / 0.0000 — the hub number is with JS off, because its
 * remaining full-page 0.106 is the SPA removing the static `nav.seo-hub-subnav`
 * at hydration (~935ms), which no stylesheet can reserve.
 *
 * It also covers the BODY FONT, which no per-family block could: the sheet sets
 * `body{font-family:"Manrope",…}`, overriding the metric-matched Inter stack
 * declared at the top of {@link CRITICAL_CSS}. Manrope is never loaded (no
 * `@font-face` anywhere, no webfont link on any sampled page), so the swap
 * re-metrics EVERY text node from Inter to the generic `sans-serif` — visible in
 * the trace as a per-element `dw`/`dh` on essentially the whole document.
 * Mirroring the declaration makes first paint agree with the end state; ALIGNING
 * the two stacks instead would change what the page finally looks like, which is
 * a typography decision, not a reserve — left to the owner (see the PR).
 *
 * Why deriving is what makes this safe to keep: see the module header of
 * `./seoStaticFirstPaintReserve`. Short version — unlayered like the sheet
 * itself and emitted BEFORE it, so `seo-static.css` always wins on equal
 * specificity once it lands, and the projection cannot drift from its source
 * because it IS its source.
 *
 * Pure space reservation (AGENTS.md §7).
 */
export const SEO_STATIC_SHEET_RESERVE_CSS = deriveSeoStaticFirstPaintReserve(
  readPublicAsset(SEO_STATIC_CSS_FILENAME),
);

/**
 * `*,::after,::before{border:0 solid #e5e7eb}` below is wrapped in
 * `@layer base` (matching the identical reset's layer in the ASYNC
 * `index.css`) — NOT unlayered like the rest of this file's reserve blocks.
 * Per CSS Cascade Layers, an unlayered author rule always wins over ANY
 * layered rule regardless of specificity or source order, PERMANENTLY (not
 * just until the async sheet loads). Left unlayered, this reset defeated
 * every Tailwind `.border`/`.border-*` utility on every static SEO page
 * sitewide — e.g. `border:1px solid var(--color-edge)` from `.border`/
 * `.border-edge` in `index.css`'s `@layer utilities` computed to
 * `border-width:0` forever, confirmed live via CDP
 * `CSS.getMatchedStylesForNode` (2026-07-28). `@layer base` still beats
 * UA-origin defaults (layers only rank within the same origin) and still
 * loses to `index.css`'s own `@layer utilities`, so the intended "neutral
 * baseline until Tailwind lands" behaviour is preserved — it just stops
 * outranking Tailwind permanently. The rest of this file's classes
 * (`.s-*` reserves) stay unlayered on purpose: they compete on raw
 * source-order against `seo-static.css`, which is itself entirely
 * unlayered by design.
 */
export const CRITICAL_CSS =
  `@font-face{font-family:Inter;font-style:normal;font-weight:400 700;font-display:swap;src:url(${BASE_URL}/fonts/inter-latin.woff2) format("woff2");size-adjust:100%;ascent-override:90%;descent-override:22%;line-gap-override:0%;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}@font-face{font-family:"Space Grotesk";font-style:normal;font-weight:300 700;font-display:optional;src:url(${BASE_URL}/fonts/space-grotesk-latin.woff2) format("woff2");size-adjust:100%;ascent-override:90%;descent-override:22%;line-gap-override:0%;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}@layer base{*,::after,::before{box-sizing:border-box;border:0 solid #e5e7eb}}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased;line-height:1.5}h1,h2,h3{font-family:"Space Grotesk",ui-sans-serif,system-ui,-apple-system,sans-serif}.bg-surface-alt{background-color:#f8fafc}.dark .dark\\:bg-surface-inverted,.dark.bg-surface-inverted{background-color:#020617}.text-heading{color:var(--color-heading,#0f172a)}.dark .dark\\:text-heading{color:#f1f5f9}body{min-height:100vh}` +
  RAIL_RESERVE_CSS +
  SEO_STATIC_GRID_RESERVE_CSS +
  SEO_STATIC_HERO_RESERVE_CSS +
  SEO_SEARCH_HUB_RESERVE_CSS +
  SEO_ARTICLE_SHELL_RESERVE_CSS +
  ROOT_HEADER_RESERVE_CSS +
  // Layered half: mirrors of `index.css` (Tailwind). `@layer base` keeps them
  // strictly BELOW `index.css`'s own `@layer utilities`, so once the async
  // sheet lands the authoritative rule wins and these can only ever govern the
  // pre-swap frame.
  `@layer base{${TAILWIND_THEME_TOKENS_RESERVE_CSS}${TAILWIND_PREFLIGHT_RESERVE_CSS}${TAILWIND_UTILITY_RESERVE_CSS}}` +
  // Unlayered half: a mirror of `seo-static.css`, which is itself unlayered —
  // emitted here FIRST so the real sheet wins on equal specificity when it
  // lands. Kept last so it also supersedes the older hand-written `.s-*`
  // reserves above wherever the two describe the same selector.
  SEO_STATIC_SHEET_RESERVE_CSS;

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
