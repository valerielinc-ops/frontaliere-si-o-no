# Astro + Zod Full Migration — Plan Index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Vite + React SPA + hand-rolled router + 16 custom build-plugins architecture with Astro (file-based routing, content collections, MDX, islands), with Zod as the single source of truth for all content/data schemas. End state: every renderable artifact lives as a typed file in `src/content/` or `src/pages/`, JSON-LD is generated from Zod schemas, 7 of 10 current dist-walking audit gates become build-time invariants by construction.

**Architecture (end state):**
- **Astro** (`withastro/astro` 6.3.x) drives the build. `astro.config.mjs` replaces `vite.config.ts`. File-based routing under `src/pages/`. Static output (`output: 'static'`) to preserve current SEO/CDN posture.
- **Content collections** under `src/content/{articles,landings,jobs,...}/` with `src/content/config.ts` defining Zod schemas per collection. Frontmatter validated at build; missing mandatory SEO fields = build failure.
- **MDX** (`@astrojs/mdx`) for articles (10,800 files: 2,702 articles × 4 locales) — Pattern A file-per-locale, parallel to current `services/locales/blog-body/{locale}/*.ts`.
- **React islands** (`@astrojs/react`) for the interactive surfaces (calculators, comparators, job board, maps). App.tsx (~2,700 lines) decomposed into per-island components; per-tab state local to each island; URL is the source of truth for cross-island state.
- **i18n** via `@astrojs/i18n` + manual critical-path inline for IT LCP (preserve current `it-critical.ts` SYNC-load behavior).
- **Cathedral retirement:** parallel closeBundle, custom plugin sequencing, FAST_BUILD/SKIP_* env vars all retired. Astro's build pipeline replaces them.
- **All 117 GitHub workflows** audited; deploy.yml, post-deploy-validation.yml, audit-dist-from-run.yml rewired to Astro output paths.

**Tech Stack:**
- Astro 6.3.x + @astrojs/react + @astrojs/mdx + @astrojs/sitemap + @astrojs/i18n
- Zod 4.4.x (devDep until SPA islands need runtime schemas)
- React 19 (preserved for islands)
- TypeScript ~5.8 (preserved)
- Tailwind 4 (preserved via `@astrojs/tailwind` or Vite plugin compat)
- Vitest 4 (preserved for unit/integration tests)
- Playwright (preserved for E2E)
- Firebase / Remote Config (preserved; loaded at runtime in islands)

---

## Why decomposed

This migration covers ≥8 ontologically independent subsystems. Bundling them into one plan would (a) outrun the context window, (b) freeze before execution because the spec drifts, (c) prevent shipping intermediate value. Per `superpowers:writing-plans` scope check: each subsystem ships working, testable software on its own.

Each sub-plan in this index can be paused, audited, even rolled back independently. The first sub-plan (Zod foundations) delivers value **even if the Astro migration is later cancelled** — those schemas + invariants are net wins on the current Vite stack.

---

## Sub-plans

| # | File | Scope | Depends on | Est. effort | Ships value standalone? |
|---|------|-------|------------|-------------|-------------------------|
| 01 | [`2026-05-20-astro-zod-01-zod-foundations.md`](./2026-05-20-astro-zod-01-zod-foundations.md) | Install Zod. Schemas for the 6 most-referenced data sources (jobs, articles, orphan clusters, health-premiums, fuel-daily, border-wait). Schema-derived JSON-LD helpers (JobPosting, Article, FAQPage, ImageObject, BreadcrumbList, WebPage). Retire 7 dist-walking audits as build-time invariants. | — | 1.5 weeks | ✅ Yes |
| 02 | [`2026-05-20-astro-zod-02-astro-skeleton.md`](./2026-05-20-astro-zod-02-astro-skeleton.md) | Install Astro + integrations. Create `astro.config.mjs` parallel to `vite.config.ts` (coexistence mode for transition). Define `src/content/config.ts` with collection schemas (reusing Zod from sub-plan 01). One pilot static page (`/privacy/`) rendered via Astro end-to-end. CI deploys both Astro output + legacy Vite output to validate parity. | 01 | 1 week | ⚠️ Partial (pilot page only) |
| 03 | [`2026-05-20-astro-zod-03-articles-mdx.md`](./2026-05-20-astro-zod-03-articles-mdx.md) | Big-bang migration of 2,702 articles × 4 locales = 10,800 TS body files → MDX files in `src/content/articles/{slug}.{locale}.mdx`. Migration script + verification (byte-equivalent rendered HTML). Retire `data/blog-articles-data.ts` + `services/locales/blog-meta-{locale}.ts` + `services/locales/blog-body/`. Rewire `scripts/create-article.mjs` to emit MDX. | 02 | 2 weeks | ✅ Yes |
| 04 | [`2026-05-20-astro-zod-04-programmatic-landings.md`](./2026-05-20-astro-zod-04-programmatic-landings.md) | Port programmatic landing build plugins to Astro dynamic routes: `orphanQueryLandingPlugin`, `salaryHubPlugin`, `careerLandingsPlugin`, `healthPremiumsLanding`, `fuelDailyPages`, `weeklyEmployersPlugin`, `jobMarketSnapshot`, `borderWait`. Each becomes `src/pages/[...slug].astro` with `getStaticPaths()` reading from typed data sources. Hand-rolled HTML string-concat (orphanQueryLandingPlugin lines 700-1050) replaced by JSX/.astro components. | 02 | 3 weeks | ✅ Yes (per-landing) |
| 05 | [`2026-05-20-astro-zod-05-spa-pages.md`](./2026-05-20-astro-zod-05-spa-pages.md) | Decompose App.tsx (~2,700 lines) into per-tab React islands. Each top-level nav tab (Calcolatore, Confronti, Fisco, Guida, Vita, Statistiche) becomes a `.astro` page hosting one or more React islands. Replace `services/router.ts` `parsePath()` + `pushRoute()` with Astro file-based routing + island-local state. Preserve URL canonicalization rules (it = no prefix; en/de/fr = `/{lang}/...`). | 02, 03, 04 | 4 weeks | ❌ No (transition-only) |
| 06 | [`2026-05-20-astro-zod-06-i18n.md`](./2026-05-20-astro-zod-06-i18n.md) | Migrate `services/locales/` chunked i18n to Astro `@astrojs/i18n`. Preserve critical-path SYNC load for `it-critical.ts` (LCP guarantee). Lazy chunks `{lang}-core / -calculator / -comparatori` re-architected as per-route eager imports (Astro routes are pre-known at build, no SPA-style lazy needed). 31 chunk files reduced to per-route bundles. | 02, 05 | 2 weeks | ⚠️ Partial (works only after 05) |
| 07 | [`2026-05-20-astro-zod-07-build-pipeline.md`](./2026-05-20-astro-zod-07-build-pipeline.md) | Audit and rewire 117 GitHub workflows. Retire `vite.config.ts`, Cathedral parallelization (`parallel_plugins=true`), FAST_BUILD/SKIP_* env vars. Rewire `deploy.yml`, `post-deploy-validation.yml`, `audit-dist-from-run.yml`, `tests.yml`. Update `scripts/audit-all.mjs` to walk Astro output (`dist/` path may change — confirm Astro default is `dist/`). Update `scripts/load-rc-env.mjs` import to be Astro-compatible. Branch protection rules audited. | 02-06 (all preceding) | 1.5 weeks | ❌ No (infra-only) |
| 08 | [`2026-05-20-astro-zod-08-cutover.md`](./2026-05-20-astro-zod-08-cutover.md) | Final cutover: switch `npm run build` to Astro-only. Remove `vite.config.ts`, all `build-plugins/`, `App.tsx`, `services/router.ts`, `services/locales/blog-body/`, `data/blog-articles-data.ts`. 14-day SEO regression monitoring window (GSC position, indexed page count, crawl errors). Rollback artifact preserved for 30 days. | 01-07 (all) | 1 week (+ 14d monitor) | ❌ No (cutover-only) |

**Total estimated effort:** ~16 weeks engineering + 14 days SEO monitoring. Optimistic; expect 20 weeks calendar with normal interruptions.

---

## Critical sequencing

```
01 (Zod) ───┬─→ 02 (Astro skeleton) ──┬─→ 03 (Articles MDX) ──┐
            │                          ├─→ 04 (Landings) ──────┤
            │                          └─→ 05 (SPA) ───┬───────┤
            │                                          └─→ 06 (i18n) ──┐
            └──────────────────────────────────────────────────────────┴─→ 07 (Pipeline) → 08 (Cutover)
```

- **Sub-plan 01 must complete before any Astro work.** Astro content collections consume Zod schemas; defining them first means no rework.
- **Sub-plans 03 and 04 can parallelize** after 02. Different team members, no shared files.
- **Sub-plan 05 (SPA decomposition) is the longest pole.** Start it the day after 02 ships. Do not let it block 03/04 (which can deploy as Astro-emitted pages alongside the still-Vite-built SPA in coexistence mode).
- **Sub-plan 06 cannot ship before 05** because i18n is tested through the SPA tabs.
- **Sub-plan 07 starts when 03/04 are >50% complete** (CI rewiring needs working Astro output but doesn't need everything migrated).
- **Sub-plan 08 starts only when all green.**

---

## Cross-cutting concerns (apply to all sub-plans)

### Worktree-first

Per CLAUDE.md "Worktree-First Rule": every sub-plan execution starts with `EnterWorktree`. Branch name: `astro-zod-NN-<short-name>`. Multi-week sub-plans (03, 04, 05) live in long-running worktrees; the orchestrator can fan out tasks within a sub-plan to parallel agents (`Agent` with `isolation: "worktree"`).

### SEO moratorium (CLAUDE.md rule #19)

Active until `data/gsc-position-rolling.json` 7-day avg ≤ 7.5. Migration is **exempt** under the "consolidation refactors that NET-REDUCE pages" + "redirect/bridge emitters" carve-outs, BUT every sub-plan must:

1. Net-emit ≤ current page count (no new URLs introduced by migration itself).
2. Preserve every existing canonical URL byte-for-byte. Verify via `verify-l1-equivalence.mjs` pattern (already in repo) per sub-plan.
3. Run `scripts/refresh-gsc-position-rolling.mjs` + `scripts/check-seo-moratorium.mjs` at the start of each sub-plan to confirm we're not landing during a position dip.

### Audit gates during transition

Sub-plan 01 retires 7 dist-walking audits as build-time invariants. The remaining 3 (`content-duplicates`, `text-html-ratio`, `page-weight`) and the `bfs-depth` audit MUST keep running against Astro output throughout the transition. `scripts/audit-all.mjs` may need to walk two directories (Astro `dist/` + legacy Vite `dist/`) during coexistence (sub-plans 02-07).

### Rollback policy

Every sub-plan defines its own rollback procedure in its own document. Common pattern:
- Each sub-plan ships behind a `MIGRATION_STAGE` env var that lets `deploy.yml` deploy legacy vs Astro output.
- After cutover (sub-plan 08), keep the legacy build green for 14 days in CI but don't deploy. After 14 days, delete.

### Verification harness reuse

The existing `verify-l1-equivalence.mjs`, `verify-l2-equivalence.mjs`, `verify-l3-report-equivalence.mjs` (built for the audit-runner unification) are repurposed: any Astro-emitted page must be byte-equivalent (L1) or DOM+content-equivalent (L2) to its Vite-emitted predecessor. Sub-plans 03, 04, 05 lean heavily on these.

### Translation pattern (resolved decision)

Pattern A: file-per-locale. 4 MDX files per article (`{slug}.it.mdx`, `.en.mdx`, `.de.mdx`, `.fr.mdx`). No AI fan-out at build. Locked in sub-plan 03.

### Articles migration mode (resolved decision)

Big-bang: all 2,702 articles migrated in sub-plan 03. No dual-coexistence loader. Migration script must succeed atomically or roll back. `create-article.mjs` cuts over to MDX in the same PR as the bulk migration.

### Astro mode (resolved decision)

Full replacement (not coexistence, not greenfield). Vite eventually deleted in sub-plan 08.

---

## Self-review (per skill mandate)

**Spec coverage:**
- Zod integration → sub-plan 01 (full).
- Astro integration → sub-plans 02-08 (full).
- SEO moratorium handling → cross-cutting section above.
- Audit gate eviction → sub-plan 01 (build-time invariants); remaining gates handled in sub-plans 07-08.
- Articles big-bang → sub-plan 03 (explicit goal).
- File-per-locale → sub-plan 03 (Pattern A locked).
- SPA + router rewrite → sub-plan 05.
- i18n preservation (critical-path LCP) → sub-plan 06.
- Cathedral retirement → sub-plan 07.
- 117 workflows audit → sub-plan 07.

**Placeholders:** none. Every sub-plan stub names files, dependencies, deliverables, ship-standalone status.

**Type consistency:** schemas defined in sub-plan 01 are consumed by sub-plans 02-04. Names are pinned: `JobSchema`, `ArticleSchema`, `OrphanClusterSchema`, `HealthPremiumRowSchema`, `FuelDailySnapshotSchema`, `BorderWaitMeasurementSchema`. JSON-LD helpers pinned: `jobPostingLd()`, `articleLd()`, `faqPageLd()`, `imageObjectLd()` (already exists, refactored), `breadcrumbListLd()`, `webPageLd()`. These names appear identically in sub-plans 02-04.

---

## Execution handoff

**Recommendation:** sub-plan 01 first, in this same session if you want — it's the only one that ships value alone and doesn't lock you into Astro until you've felt the schema work.

For execution mode choice (Subagent-Driven vs Inline), see the execution handoff section at the end of sub-plan 01.
