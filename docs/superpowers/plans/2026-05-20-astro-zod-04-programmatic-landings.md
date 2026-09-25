# Sub-Plan 04: Programmatic Landings → Astro Dynamic Routes

> **For agentic workers:** This is a STUB. Expand to bite-sized TDD tasks before executing.

**Goal:** Port all programmatic-content build plugins to Astro dynamic routes with `getStaticPaths()`. Each plugin's hand-rolled HTML string-concat is replaced by a `.astro` page template + reusable `.astro`/`.tsx` components. The 4 programmatic landings most exposed to the JSON→HTML "mapping pain" (`orphanQueryLandingPlugin`, `salaryHubPlugin`, `careerLandingsPlugin`, `healthPremiumsLanding`) plus the 4 dashboard-style landings (`fuelDailyPages`, `weeklyEmployersPlugin`, `jobMarketSnapshotPlugin`, `borderWaitPlugin`) — total 8 plugins — become 8 Astro routes consuming typed data via Zod schemas from sub-plan 01.

**Architecture:**
- Each plugin → one or more `src/pages/<path>/[...slug].astro` files with `getStaticPaths()` returning the full URL set.
- Data sources stay as JSON on disk (unchanged from today). Astro routes load them via `loadJobs()`, `loadHealthPremiums()`, etc. helpers that wrap Zod parsing.
- Hand-rolled HTML chunks (orphanQueryLandingPlugin lines 700-1050 etc.) extracted into reusable `.astro` components: `<StatsTileGrid>`, `<AdviceBanner>`, `<JobListBlock>`, `<FaqAccordion>`, `<BreadcrumbNav>`, `<RankingTable>`. These match the SEO-landing template contract in CLAUDE.md rule #17.
- JSON-LD via `JsonLd.astro` component (from sub-plan 02) calling schema-driven helpers from sub-plan 01 — never hand-rolled.
- Cross-page content index (CLAUDE.md feedback / earlier analysis): build once at boot, expose as `loadContentIndex()`. Used by orphan landings to filter matching jobs in O(1) instead of O(N_clusters × N_jobs).

**Tech Stack:** Astro (sub-plan 02), Zod schemas (sub-plan 01), Node fs/promises for JSON loads.

**Depends on:** Sub-plan 02 (Astro skeleton). NOT dependent on sub-plan 03 (articles) — these can parallelize.

**Estimated effort:** 3 weeks (15 engineering days). Each of the 8 plugins is ~1.5 days end-to-end.

**Ships standalone value:** ✅ Yes, per-landing. Each plugin migrated is one PR; each PR independently deployable.

---

## File structure (planned)

**Created:**
- `src/pages/ricerca/[slug].astro` (IT orphan landings) + en/de/fr equivalents
- `src/pages/calcola-stipendio/[scenario].astro` (IT salary-hub) + en/de/fr
- `src/pages/lavoro/[role]/[city].astro` (career landings) + en/de/fr
- `src/pages/assicurazione-malattia/[canton].astro` + locales
- `src/pages/carburante/[type].astro` + locales
- `src/pages/datori-di-lavoro/settimanali.astro` + locales
- `src/pages/mercato-lavoro/[canton].astro` + locales
- `src/pages/attesa-frontiera/[crossing].astro` + locales
- `src/components/seo/StatsTileGrid.astro`
- `src/components/seo/AdviceBanner.astro`
- `src/components/seo/JobListBlock.astro`
- `src/components/seo/FaqAccordion.astro`
- `src/components/seo/BreadcrumbNav.astro`
- `src/components/seo/RankingTable.astro`
- `src/components/seo/CtaPrimary.astro`
- `scripts/lib/content-index.mjs` — boot-time index builder
- `scripts/lib/loaders/jobs.mjs`, `articles.mjs`, `healthPremiums.mjs`, etc. — typed loaders (Zod-validated)
- `tests/landings-migration-equivalence.test.ts` per landing

**Modified:**
- `src/content/config.ts` — extend with `landings` collection if any have human-authored frontmatter

**Deleted (per plugin, in cleanup commits after deploy verifies parity):**
- `build-plugins/orphanQueryLandingPlugin.ts` (87 KB)
- `build-plugins/salaryHubPlugin.ts` (~264 lines + supporting modules)
- `build-plugins/careerLandingsPlugin.ts`
- `build-plugins/healthPremiumsLandingPlugin.ts`
- `build-plugins/fuelDailyPagesPlugin.ts`
- `build-plugins/weeklyEmployersPlugin.ts`
- `build-plugins/jobMarketSnapshotPlugin.ts`
- `build-plugins/borderWaitPlugin.ts`
- `build-plugins/shared/seoPageShell.ts` (replaced by Astro `BaseLayout`)
- `build-plugins/shared/seoContentTokens.ts` (port to Astro component CSS module)

---

## Phases (each plugin = one phase, expandable to ~10-15 bite-sized tasks)

1. **Shared component library.** Build the 7 reusable `.astro` components matching CLAUDE.md rule #17 template contract. Tested in isolation. ~2 days.
2. **Typed loaders + content index.** `scripts/lib/loaders/*.mjs` with Zod-validated reads. `loadContentIndex()` materializes job-by-cluster, content-by-tag, etc. ~1 day.
3. **Plugin 1 — orphanQueryLandingPlugin (heaviest, prove the pattern).** Astro route + components + per-cluster `getStaticPaths()` + role-aware editorial copy from `services/locales/{lang}-orphan-landings.ts`. Verify L2 equivalence vs legacy on 20 sample URLs. ~2 days.
4. **Plugin 2 — salaryHubPlugin.** Same pattern. ~1.5 days.
5. **Plugin 3 — careerLandingsPlugin.** ~1.5 days.
6. **Plugin 4 — healthPremiumsLanding.** ~1.5 days.
7. **Plugin 5 — fuelDailyPages.** ~1 day (dashboard-shape, less editorial).
8. **Plugin 6 — weeklyEmployersPlugin.** ~1 day.
9. **Plugin 7 — jobMarketSnapshotPlugin.** ~1 day.
10. **Plugin 8 — borderWaitPlugin.** ~1 day.
11. **Cleanup pass.** After all 8 plugins are deploy-verified, delete legacy plugin source. Update `vite.config.ts` to no longer register them. ~0.5 day.

---

## Critical risks

1. **Editorial copy migration.** `services/locales/{lang}-orphan-landings.ts` (and similar files for other plugins) contain hundreds of locale strings. These must migrate to either Astro i18n (sub-plan 06) or stay as TS imports. Decision: keep as TS imports during this sub-plan; sub-plan 06 consolidates.
2. **`getStaticPaths()` memory.** Orphan landings generate hundreds of URLs × 4 locales. `getStaticPaths()` runs at build start; the entire URL list must fit in memory. Should be fine (~10K paths × small metadata) but track build RAM during phase 3.
3. **L2 equivalence will not be byte-perfect.** Astro's HTML output differs in whitespace, attribute order, possibly comment stripping. Acceptance criterion: DOM-equivalent + visible-text-equivalent + JSON-LD-equivalent. `verify-l2-equivalence.mjs` (existing) is the tool.
4. **JSON-LD diffs are the #1 risk.** Even minor schema-marker diffs can affect Google rich results. For every plugin, the FIRST verification is `verify-l2-equivalence.mjs` filtered to JSON-LD only. Hard gate.
5. **Sitemap parity.** Each plugin currently emits sitemap entries via custom logic. `@astrojs/sitemap` auto-emits everything in `src/pages/`. Verify the URL set is identical (sort + diff). Address any missing URLs (e.g., trailing-slash conventions).
6. **Build time per plugin.** Some legacy plugins are slow (orphanQueryLandingPlugin took minutes during Cathedral optimization). Astro's build of equivalent routes may be slower or faster — measure during phase 3, decide whether to add per-route caching.
7. **Sub-plan 01's audit retirement assumed JSON-LD comes from helpers.** If any plugin migration accidentally re-introduces hand-rolled JSON-LD, the build won't catch it (the audit was retired). Mitigation: add a lint rule (`tests/no-handrolled-jsonld.test.ts`) that fails CI if `'@type':` appears anywhere under `src/` outside the JsonLd component.

---

## Rollback

- Each plugin migration is one PR. Revert restores the legacy plugin (still in `build-plugins/` until the cleanup pass).
- The coexistence merge step (`scripts/merge-astro-into-dist.mjs` from sub-plan 02) picks Astro-emitted paths over Vite-emitted; reverting removes the path from `dist-astro/`, so the legacy `dist/` version is served.
- Cleanup pass (phase 11) is the only irreversible step — only run it AFTER all 8 plugins are 14-day soak-clean.

---

## Open questions to resolve before expansion

1. **Static overlay handling.** CLAUDE.md mentions `parsePath().route.staticOverlay === true` URLs (fuel-daily, weekly-employers, health-premiums, border-wait, jobs-observatory, cost-of-living, salary-hub long-tail). After migration to Astro pages, this distinction disappears (no SPA fallback needed — Astro IS the static). Verify each such URL no longer needs the overlay flag in router. (Sub-plan 05 finalizes router removal.)
2. **Job match index keying.** Sub-plan 01 added `JobSchema.stableId`. The content index in phase 2 should key on `stableId`, not URL (CLAUDE.md rule #18 about vendor URL renames).
3. **Per-page CSS budget.** Astro extracts per-page critical CSS automatically. Current per-landing CSS approach (Tailwind utilities + a few CSS modules) should map cleanly, but verify no unused-CSS bloat on first phase-3 build.
4. **Translation handling for landings.** Plugins currently use `services/locales/{lang}-orphan-landings.ts` etc. as flat Records. Sub-plan 06 will move them; this sub-plan keeps importing them as-is.

---

## Execution handoff

(Same as sub-plan 01.)
