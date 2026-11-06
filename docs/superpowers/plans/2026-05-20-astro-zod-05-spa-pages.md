# Sub-Plan 05: SPA Decomposition — App.tsx → Astro Pages + React Islands

> **For agentic workers:** This is a STUB. Expand to bite-sized TDD tasks before executing. This is the LONGEST POLE in the migration.

**Goal:** Decompose the single-file React SPA (`App.tsx` ~2,700 lines, all state local) into Astro pages hosting React islands. Replace `services/router.ts` hand-rolled routing with Astro file-based routing. Preserve every behavior: locale-aware slugs (IT = no prefix; en/de/fr = `/{lang}/...`), URL canonicalization, search-string preservation (newsletter `?ne=&ac=` autologin), 6 top-level nav tabs (Calcolatore, Confronti, Fisco, Guida, Vita, Statistiche), 8 sub-tabs per category, browser back/forward semantics, and the static-overlay vs hydrated distinction (which goes away — Astro handles both via the same model).

**Architecture:**
- Every top-level tab = one `.astro` page. Six total IT pages (+24 locale pages):
  - `src/pages/calcolatore/index.astro` + per-sub-tab pages
  - `src/pages/confronti/index.astro` + sub-tabs
  - `src/pages/fisco/index.astro` + sub-tabs
  - `src/pages/guida/index.astro` + sub-tabs
  - `src/pages/vita/index.astro` + sub-tabs
  - `src/pages/statistiche/index.astro` + sub-tabs
- Interactive React components become **islands** (`client:load` / `client:visible` / `client:idle` per use case):
  - `<CalculatorIsland client:load />` (above-the-fold, immediate hydration)
  - `<JobBoardIsland client:visible />` (deferred until in viewport)
  - `<ChartsIsland client:idle />` (Recharts — heavy, idle hydration)
  - `<MapIsland client:visible />` (Leaflet — viewport hydration)
- **State that was local to `App.tsx`**: localized to each island. URL is the source of truth for cross-island state (e.g., selected canton, currency view). Where two islands on the same page must share state, use a `nanostores` or URL-search-param approach (NOT a global store unless absolutely required).
- **Router replacement:**
  - `pushRoute()` → `navigate()` from `astro:transitions/client` (Astro view-transitions) or plain `history.pushState` wrapped in a thin helper.
  - `parsePath()` → not needed; Astro routing parses URLs. Helper `localizedHref(routeKey, locale)` for cross-locale link generation.
  - `useNavigationState` hook → replaced by per-island reading of URL search params + page-level Astro frontmatter.
- **Locale routing:** Astro i18n config sets IT as default with no prefix. `/{lang}/...` prefixes for en/de/fr. Sub-plan 06 owns the i18n migration; this sub-plan only defines page shapes that work with the eventual config.
- **Critical-path LCP preservation:** the IT critical translations (`it-critical.ts`) move from SYNC-imported in App.tsx to inline-injected by Astro's frontmatter into the head. Sub-plan 06 finalizes; this sub-plan ensures every page declares its critical-i18n needs.
- **Static-overlay vs hydrated unified:** Astro pages emit static HTML by default; islands hydrate where marked. The `services/router.ts:parsePath().route.staticOverlay` flag goes away — every page IS staticOverlay (server-rendered) AND IS hydrated (where islands declare).

**Tech Stack:** Astro (sub-plan 02), @astrojs/react, React 19, nanostores (optional, only if shared island state required), Recharts/Leaflet (preserved).

**Depends on:**
- Sub-plan 02 (Astro skeleton)
- Sub-plan 03 (articles must be Astro-served before SPA cutover or links break)
- Sub-plan 04 (programmatic landings must be Astro-served before SPA cutover; nav links to them must resolve)

**Estimated effort:** 4 weeks (20 engineering days). Longest pole.

**Ships standalone value:** ❌ No. SPA decomposition is transitional infrastructure; users see no new value until cutover.

---

## File structure (planned)

**Created:**
- `src/pages/index.astro` (homepage)
- `src/pages/calcolatore/index.astro` + `/{sub-tab}.astro` per sub-tab
- `src/pages/confronti/index.astro` + sub-tabs
- `src/pages/fisco/index.astro` + sub-tabs
- `src/pages/guida/index.astro` + sub-tabs
- `src/pages/vita/index.astro` + sub-tabs
- `src/pages/statistiche/index.astro` + sub-tabs
- Locale variants `src/pages/{en,de,fr}/...` for each above
- `src/components/islands/CalculatorIsland.tsx` (wraps existing Calculator component)
- `src/components/islands/JobBoardIsland.tsx`
- `src/components/islands/ChartsIsland.tsx`
- `src/components/islands/MapIsland.tsx`
- `src/components/islands/NewsletterFormIsland.tsx`
- `src/components/islands/PopupNewsletterIsland.tsx` (global; mounted in BaseLayout)
- `src/lib/router.ts` — thin `localizedHref(routeKey, locale)` helper + minimal navigate wrapper
- `src/lib/url-state.ts` — URL search-param sync helpers (replaces useNavigationState's URL logic)
- `tests/spa-island-equivalence.test.ts` — per-page L2 equivalence vs legacy SPA

**Modified:**
- `src/layouts/BaseLayout.astro` — wire nav + footer + popup-newsletter mount points
- `src/components/Nav.astro` — port of current nav, links use `localizedHref`

**Deleted (in cleanup commit at end):**
- `App.tsx`
- `services/router.ts`
- `services/seoService.ts` (parts not already migrated to `structuredData.ts` from sub-plan 01)
- `hooks/useNavigationState.ts`
- `hooks/useUIState.ts` (if fully replaced by per-island state — verify)
- `services/locales/blog-body/` (already deleted in sub-plan 03 cleanup)

---

## Phases

1. **Inventory & boundary mapping.** Read App.tsx end-to-end. Map every state slice to a page/island. Output: a markdown document `docs/spa-decomposition-map.md` listing every useState/useEffect with its target island. ~2 days.
2. **One pilot tab end-to-end.** Pick the simplest tab (likely Statistiche or Guida). Build its `.astro` page, port its islands, verify L2 equivalence + interactive behavior. ~3 days.
3. **Router helper + URL-state helper.** Build `localizedHref` and URL search-param sync. Test against current router invariants (search-param preservation, canonical redirect rules). ~1.5 days.
4. **Tab 2 — Vita.** Apply pattern from phase 2. ~2 days.
5. **Tab 3 — Fisco.** Includes the funnel calculator (PostHog instrumentation — see memory `project_recovery_may18.md`; do NOT regress the `useUIState.ts:95` entry-tag bug). ~3 days.
6. **Tab 4 — Confronti.** Includes Permit B vs G comparator. ~2.5 days.
7. **Tab 5 — Calcolatore.** The flagship calculator. Single biggest island. ~3 days.
8. **Tab 6 — Statistiche.** Includes Recharts-heavy dashboards. `client:idle` for charts. ~2 days.
9. **Global islands.** Popup newsletter, analytics consent (silent — per memory `feedback_silent_consent.md`), search bar. ~1.5 days.
10. **Footer + nav + breadcrumbs.** Port to Astro components. ~1 day.
11. **Cleanup commit.** Delete `App.tsx`, `services/router.ts`, hooks. Run full E2E suite. ~1 day.
12. **Coexistence cutover.** Remove the merge step's "Astro paths override Vite paths" — Astro now owns everything except whatever sub-plans 06-08 still handle. Switch deploy to Astro-primary. ~0.5 day.

---

## Critical risks

1. **State that crosses tab boundaries.** If App.tsx has state that survives navigation between tabs (e.g., "selected canton" persists when user moves Calcolatore → Statistiche), URL params or a tiny `nanostores` atom must replace it. Inventory in phase 1 is critical.
2. **Calculator funnel instrumentation regression.** Memory `project_recovery_may18.md` flags `useUIState.ts:95` previously fired entry events without funnel tags, causing -71% measurement. The island migration MUST preserve correct entry-tag firing. Add a PostHog event-shape test.
3. **Newsletter autologin (`?ne=&ac=` params).** Memory `feedback_router_preserve_search.md`: router/nav history writes must append `window.location.search`. The new `localizedHref` + navigate wrapper MUST preserve search params on every transition. Add a regression test.
4. **Browser back/forward.** Astro view-transitions handle this differently from manual `history.pushState`. If using view-transitions, regression-test back/forward on every tab.
5. **LCP impact.** App.tsx loads ~80 critical i18n keys synchronously to hit IT LCP. Per-Astro-page inline injection must achieve same LCP profile. Measure on phase 2 pilot; abort the migration shape if LCP regresses >10%.
6. **`hooks/useNavigationState.ts` reads `staticOverlay` from the router (memory `feedback_static_overlay_truth_is_router.md`).** This flag goes away post-migration. Audit all consumers of `staticOverlay` (`grep -rln staticOverlay`) and remove or replace.
7. **`App.tsx` is one file with hundreds of conditional renders.** Decomposition risks introducing visual regressions on small things (margin tweaks, ARIA labels). Mitigation: Playwright visual regression suite (`test:e2e:visual`) run on every PR in this sub-plan. Snapshot updates require explicit review.
8. **Mobile-first content positioning rules #15-17.** Every island's content order on mobile must preserve current order (meaty content above fold). Re-verify mobile rendering on every tab phase.

---

## Rollback

- Each tab phase is one PR. Revert restores legacy tab in App.tsx.
- During coexistence (phases 2-11), the merge step ensures Astro pages are served only where they exist; reverting a phase removes those paths from `dist-astro/`, falling back to legacy.
- Phase 12 is the cutover and the last reversible point. Tag `pre-spa-cutover` before phase 12 merge. 30-day pin.

---

## Open questions to resolve before expansion

1. **View transitions or hard navigation.** Astro 6.x supports `@astrojs/view-transitions`. Smooth, SPA-feeling, but adds complexity. Recommend: defer; hard navigation is fine if every page is fast static + light islands.
2. **Shared state library.** If phase 1 inventory finds significant cross-tab state, add `nanostores` (~1KB, used by Astro examples) instead of full Zustand. Decide post-phase-1.
3. **`hooks/useUIState.ts`** scope. May still be useful per-island. Decide during phase 5 (Fisco — the funnel-heavy tab).
4. **Component imports.** Currently `@/components/Foo` resolves to repo root `components/`. After migration, components shared between islands should move to `src/components/`. Decide: leave at root until end-of-sub-plan, then mass-move; or migrate incrementally. Recommend: incremental — when an island imports a component for the first time, move it to `src/components/` in that PR.

---

## Execution handoff

(Same as sub-plan 01. This is the most subagent-friendly sub-plan because each tab phase is bounded — recommend Subagent-Driven with checkpoints between tabs.)
