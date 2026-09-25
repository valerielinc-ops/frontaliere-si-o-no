# SEO pages uniform layout — design spec

**Date**: 2026-04-24
**Scope**: Fix concrete bugs and design inconsistencies reported on `/prezzi-diesel/oggi/` and uniform the visual/layout standard across all SEO build-plugin pages.

## Problem statement

On `/prezzi-diesel/oggi/` and sibling pages users reported:

1. Delta vs ieri always shows `0,000 CHF` (bug: yesterday snapshot missing; history population broken).
2. 7-day average always shows `2,149 CHF` (stale; only 2 of last 7 days present).
3. No visual trend chart — only a tabular listing.
4. Station `<li>` cards use inline CSS that visibly shows `padding:20px 24px;padding:14px 16px` (duplicate property — second wins, layout wrong). Cards also lack logos and are not clickable.
5. "Scopri di più" section has the same duplicated-padding bug (`renderDiscoverMore` concatenates `padding:20px 24px;${CARD_STYLE}` where `CARD_STYLE` starts with `padding:14px 16px`).
6. Footer SEO "Aziende che assumono / Risorse aggiornate" sections look misaligned relative to the page (they use a narrower grid than the main content).
7. Main page content appears left-aligned instead of centered at large viewport widths.
8. Parity with `/prezzi-benzina/oggi/` is unverified.

## Affected plugins (17)

annualReport, borderWaitMap, borderWaitPages, careerLandings, comparisonsHub, costOfLivingLandings, faqHub, frSalaireNetLanding, **fuelDailyPages**, healthPremiumsLanding, **jobMarketSnapshot**, marketReport, nursingLandings, orphanQueryLanding, professionLandings, **weeklyEmployers**, jobsSeoPages.

## Architecture — what stays, what changes

**Stays**: `buildSeoPageHtml` / `seoPageShell.ts` / `hubChrome.ts`. Design tokens live in `build-plugins/shared/seoContentTokens.ts` and resolve to CSS custom properties from `index.css`. Pages are emitted as static HTML with `main.seo-static-content` outside of `#root` so React hydration doesn't overwrite.

**Changes**:

### F1 — Token fixes + page centering (foundational)

- **Fix `renderDiscoverMore`**: remove the duplicate-`padding` concatenation in `seoContentTokens.ts` (`margin:32px 0 0;padding:20px 24px;${CARD_STYLE}` → keep `padding` of `CARD_STYLE` or override cleanly).
- **Introduce `SECTION_STYLE`** token: a section wrapper equivalent to `CARD_STYLE` but without `padding` collision for callers that want a larger inset. Add one `renderSeoSection({ heading, innerHtml, ariaLabel })` helper.
- **Add `.seo-static-content` centering** in `index.css`: `max-width: min(100%, 1120px); margin-inline: auto; padding-inline: clamp(16px, 4vw, 32px);`. Currently the class is defined but without `max-width` centering for wide viewports.
- **Audit inline `<section>` / `<nav>` blocks** in plugins for hardcoded `margin`/`padding` that collide with tokens. Convert stragglers.

### F2 — Diesel data bugs

- **Repair `data/fuel-prices-history/` population**: `scripts/snapshot-fuel-history.mjs` should run daily. Inspect the workflow. If history is reliably missing, the plugin should gracefully degrade (use the N days that exist, clearly label "base dati in costruzione" instead of showing stale `2,149` as if real).
- **Fix `computeDeltaVsYesterday`** in `fuelDailyData.ts`: confirm the function reads `YYYY-MM-DD.json` for `now - 1 day` and diffs against current snapshot by station slug. Right-now output of 0 suggests: (a) file missing → return `null`/sentinel so UI can say "dato non disponibile"; (b) file present but not matched → fix slug matching.
- **Fix the 7-day avg**: compute across all files in `data/fuel-prices-history/` within the last 7 days of `YYYY-MM-DD` filenames. Fall back gracefully if <2 files available.
- **Add inline SVG sparkline/line-chart** (no JS, SEO-crawlable) for the last 7 days of the zone average. Use `--color-chart-*` semantic tokens (already defined in `index.css` per the last commit). Aria-label with period + delta.
- Apply all fixes to **benzina** pages too (same plugin, `FUEL_TYPES = ['diesel', 'benzina']`).

### F3 — Entity card helper (logos + clickable)

- **Add `renderEntityCard`** in `seoContentTokens.ts`:
  - Props: `{ href, logoUrl?, logoAlt?, title, subtitle?, metric?, metricTone? }`.
  - Renders a clickable `<a>` wrapper with `display:flex;align-items:center;gap:12px;padding:14px 16px;border:1px solid var(--color-edge);border-radius:14px;background:var(--color-surface);text-decoration:none`.
  - Hover/focus use `outline` + `transform:translateY(-1px)` via CSS class `.seo-entity-card` added to `index.css`.
  - Logo: `<img src loading="lazy" width="40" height="40" alt>` falling back to a monochrome icon (building/fuel) when no logo.
- **Apply**: fuel stations in `fuelDailyPagesPlugin` (station detail + zone listings), companies in `weeklyEmployersPlugin`, top sectors in `jobMarketSnapshotPlugin`.
- **Logo source**: reuse `build-plugins/shared/brandCanonicalMap.ts` or add a simple slug-based URL (`/images/brands/{slug}.png`) — defer actual image generation to a follow-up if assets are missing, fall back to icon.

### F4 — Uniformity audit + benzina parity

- Visit every plugin's first emitted HTML via `dist/` inspection (or a quick build) and confirm:
  - No duplicate CSS property emission.
  - All use `main.seo-static-content` → centered.
  - All "Correlati" blocks use the same token-based layout (`renderRelatedLinksBlock` or matching structure).
  - All entity lists use `renderEntityCard`.
  - Benzina pages mirror diesel (chart, delta, cards).
- Quick Playwright snapshot-diff of `/prezzi-diesel/oggi/` vs `/prezzi-benzina/oggi/` to catch any remaining divergence.

## Non-goals

- No new data sources. No new pages. No feature-flag changes.
- No dark-mode token renames (existing tokens are sufficient).
- No i18n additions beyond what exists (label text already present via `FUEL_TYPE_LABEL`).

## Acceptance criteria

- `/prezzi-diesel/oggi/` shows delta vs ieri that is either a real number or a "dato non disponibile" fallback, never a misleading `0,000`.
- 7-day average is computed from actual snapshot data; when <2 days are available, the UI shows an honest message.
- `/prezzi-diesel/oggi/` contains an inline `<svg>` chart with `role="img"` and `aria-label`.
- All 17 SEO plugins render centered at viewport ≥1024px.
- Zero duplicate CSS properties in any emitted `<section>`/`<nav>`/`<li>` style attribute.
- Station/company entries render as clickable cards with (where available) a logo.
- `/prezzi-benzina/oggi/` is visually identical in structure to `/prezzi-diesel/oggi/`.
- `npx tsc --noEmit`, `npx vite build`, `npx vitest run` all exit 0.
- GitHub Actions deploy succeeds; live site curl returns expected markup.

## Execution plan (orchestrator)

1. Write + commit this spec to main.
2. Launch F1 + F2 in parallel worktrees (independent file sets).
3. On completion: QA each, merge into main.
4. Launch F3 (depends on F1's new tokens being on main).
5. On completion: QA, merge.
6. Launch F4.
7. On completion: QA, merge.
8. Full build + tests + prepush on main.
9. Push to remote.
10. Watch `deploy.yml` workflow via `gh run watch`.
11. Curl live URLs and verify markup.
12. Cleanup: delete any stale local branches, verify stash empty.

## Agent constraints

All agents:
- Skip `npm run build`, `npx vitest run`, pre-push hooks during iteration.
- Use `git commit --no-verify` (user has explicitly authorized).
- Do NOT push to remote; just commit in their worktree.
- Stay scoped to their phase files.
- Report: branch name, final commit hash, files touched, any blocker.
