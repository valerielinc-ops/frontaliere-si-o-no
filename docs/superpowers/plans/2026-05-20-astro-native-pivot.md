# Astro-Native Refactor — Pivot Plan (supersedes incremental sub-plans 02-08)

**Date:** 2026-05-20
**Decision authority:** User directive — "cambiamo il nostro modo di pensare in base al tool, niente più JSON, no compromessi, max parallelismo, completa tutti i sub-plan attraverso 08 includendo deploy live."

## Pivot context

The original sub-plans 02-08 described an INCREMENTAL migration: keep JSON on disk, build Astro routes that load JSON via wrapper helpers (`loadJobs()` etc.), preserve SPA shell during transition, coexistence-deploy first.

The user has rejected this approach. New directive:

1. **Astro-native everywhere.** No JSON loaders. Use `astro:content` collections as the canonical data layer. `getCollection('jobs')`, `getCollection('articles')`, etc.
2. **Workflows write INTO collections.** Crawlers produce `src/content/jobs/{stableId}.json` directly. AI article generator emits MDX into `src/content/articles/{slug}.{locale}.mdx`. Border-wait/fuel/health workflows write into their collections.
3. **No SPA preservation.** App.tsx + services/router.ts + build-plugins/* are deleted. Each route becomes an `.astro` page with React islands for interactive surfaces.
4. **Use Astro integrations natively.** `@astrojs/sitemap`, `@astrojs/mdx`, `@astrojs/react`, astro-i18n, firebase integration, github-pages adapter.
5. **Max parallelism.** Override CLAUDE.md's "3-4 parallel agents" cap. Dispatch 6-10 agents per wave.
6. **Out-of-the-box thinking.** If Astro's native pattern is better than what we have, refactor TO it, don't just port.
7. **Deploy live at end.** Full cutover. No coexistence.

## State at pivot

Sub-plan 01 (Zod foundations) — **mostly landed on `worktree-astro-zod-01-impl`** (will merge to main before Astro work starts):
- ✅ Zod 4.4.x installed
- ✅ 7 schemas: SeoText, Job, Article, OrphanCluster, HealthPremium, FuelDaily, BorderWait — with barrel export
- ✅ Producer gates wired (assemble-jobs, create-article, cluster-orphan, fetch-health-premiums, snapshot-fuel-history, snapshot-border-wait-history)
- ✅ Schema-driven JSON-LD helpers (jobPosting, article, faqPage, breadcrumb, webPage)
- ✅ orphanQueryLandingPlugin migrated to helpers
- ✅ ~36 other build-plugins migrated to helpers (Task 14)
- ⏭️ Tasks 15-17 SKIPPED: audit retirement + test wire + final PR — subsumed by the full Astro cutover (those audits die when dist becomes Astro's dist; the Zod schemas stay).
- ✅ deploy.yml push trigger disabled (manual workflow_dispatch only)

The Zod schemas + JSON-LD helpers are REUSABLE in the Astro architecture (relocate to `src/content/config.ts` + `src/lib/seo/` respectively). The plugin refactors (Tasks 13-14) become throwaway as the plugins themselves die in this pivot — accepted cost.

## New architecture (target)

```
src/
  content/
    config.ts                          # collection defs (Zod-typed)
    articles/
      {slug}.{it,en,de,fr}.mdx         # ~10,800 files
    jobs/
      {stableId}.json                  # ~6,000 files; crawlers write here
    orphan-clusters/
      {clusterId}.json                 # ~65 files
    health-premiums/
      {year}.json                      # 3 files
    fuel-snapshots/
      {YYYY-MM-DD}.json                # daily, ~365/year
    border-wait/
      current.json
      history/{YYYY-MM-DD}.json
    static-pages/
      {slug}.{locale}.mdx              # privacy, terms, etc.
    seo-landings/
      orphan-{slug}.{locale}.mdx       # generated long-tail SEO
  pages/
    index.astro                        # homepage
    calcolatore/[[slug]].astro         # calculator (React island)
    confronti/[[slug]].astro
    fisco/[[slug]].astro
    guida/[[slug]].astro
    vita/[[slug]].astro
    statistiche/[[slug]].astro
    articoli/[slug].astro              # IT articles
    {en,de,fr}/articles/[slug].astro   # locale articles
    lavoro/[stableId]/[slug].astro     # job pages
    ricerca/[slug].astro               # orphan landings
    calcola-stipendio/[scenario].astro
    [...all other current routes]
  components/
    islands/                            # React 19 client islands
      Calculator.tsx                    # client:load
      JobBoard.tsx                      # client:visible
      Charts.tsx                        # client:idle
      MapLeaflet.tsx                    # client:visible
      NewsletterForm.tsx
      ConsentAnalytics.tsx              # silent (per memory)
    seo/                                # Astro reusable components
      JsonLd.astro
      Breadcrumb.astro
      StatsTileGrid.astro
      AdviceBanner.astro
      JobListBlock.astro
      FaqAccordion.astro
      CtaPrimary.astro
    layouts/
      BaseLayout.astro                  # nav + footer + head + GTM/PostHog/Firebase
      ArticleLayout.astro
      JobLayout.astro
      SeoLandingLayout.astro
  i18n/
    {it,en,de,fr}/
      critical.ts                       # ~80 keys inline-injected for LCP
      core.ts
      calculator.ts
      [...per-domain]
    index.ts                            # getCriticalI18n(locale)
  lib/
    seo/
      structuredData.ts                 # JSON-LD helpers (relocated from services/)
      titleSuffix.ts                    # composeJobPageTitle (relocated)
    firebase.ts                         # @astrojs/firebase init
    posthog.ts
  middleware.ts                         # locale routing, canonical, redirects
.github/workflows/
  deploy.yml                            # astro build + @astrojs/github-pages
  [crawler workflows]                   # rewritten to write src/content/jobs/
  newsletter.yml                        # unchanged
  [data refresh workflows]              # rewritten to write into content collections
```

## Wave-based execution

Each wave dispatches the maximum safe parallelism. File-overlap analysis ensures no conflicts.

### Wave 0: Close sub-plan 01 + merge to main (SEQUENTIAL, ~10 min)
- Merge `worktree-astro-zod-01-impl` to `main` directly (no PR review, per user authorization)
- Delete the worktree
- Start clean on main from here forward (per user grant)

### Wave 1: Astro foundation (1 agent — sequential dependency for everything else)
- Install Astro 6.3.x + @astrojs/react + @astrojs/mdx + @astrojs/sitemap + astro-i18n + @astrojs/tailwind
- Write `astro.config.mjs` with: static output, IT default locale (no prefix), trailingSlash:'always', build.format:'directory'
- Create `src/` skeleton
- Verify `npx astro check` works
- Verify `npm run dev` (astro dev) boots

### Wave 2: Content collections setup (1 agent)
- Write `src/content/config.ts` with all 6 collection schemas (reuse Zod schemas from scripts/lib/schemas/, RELOCATE them to `src/lib/schemas/`)
- Empty collection directories ready for population

### Wave 3: Parallel data migration (6 agents)
- Agent A: jobs — write `scripts/migrate-jobs-to-content-collection.mjs` that splits `data/jobs.json` into `src/content/jobs/{stableId}.json`
- Agent B: articles — write `scripts/migrate-articles-to-mdx.mjs` that converts `services/locales/blog-body/{locale}/{id}.ts` + `data/blog-articles-data.ts` + `services/locales/blog-meta-{locale}.ts` → `src/content/articles/{slug}.{locale}.mdx`
- Agent C: orphan-clusters — split `data/gsc-orphan-queries-clusters.json` into per-cluster files
- Agent D: health-premiums — adapt nested → per-year files
- Agent E: fuel-snapshots — keep one file per day
- Agent F: border-wait — current + history files

### Wave 4: Workflow rewiring (parallel ~30 crawlers + utility workflows)
- Each crawler workflow rewritten: writes directly into `src/content/jobs/`, removes per-crawler slice files + assemble-jobs-dataset.mjs from the pipeline
- create-article.mjs rewritten to emit MDX
- GSC/health/fuel/border refresh workflows write into collections
- Delete obsoleted workflows (post-deploy-validate-dist.yml, audit-dist-from-run.yml, etc.)

### Wave 5: Astro pages (parallel ~12 page groups)
Each agent owns one page group + its tests:
- Homepage + Calcolatore
- Confronti + Fisco
- Guida + Vita + Statistiche
- Articles routes (4 locales)
- Job pages
- Orphan landings
- Salary hub + cost-of-living
- Static pages (privacy, terms, etc.)
- Career landings + health-premiums + fuel-daily landings
- Weekly employers + job-market-snapshot + border-wait

### Wave 6: React islands (parallel ~6)
- Calculator
- JobBoard
- Charts (Recharts)
- Map (Leaflet)
- NewsletterForm + popup
- ConsentAnalytics + PostHog wiring

### Wave 7: i18n (1 agent — astro-i18n setup + critical-path inline preservation)
- Setup astro-i18n
- Migrate `services/locales/` to `src/i18n/`
- Inline-inject critical-IT keys into `<head>` for LCP preservation
- Locale router (it default no prefix; en/de/fr prefixed)

### Wave 8: Integrations (parallel)
- Firebase integration (Remote Config + Analytics + Firestore)
- @astrojs/sitemap config
- @astrojs/github-pages deploy adapter
- middleware.ts (canonical, search-param preservation)

### Wave 9: Cleanup (1 agent)
- Delete: vite.config.ts, App.tsx, services/router.ts, build-plugins/, services/locales/, services/seo/* (except what's been relocated), hooks/, data/jobs/by-crawler/ (after migration), data/blog-articles-data.ts, services/locales/blog-body/
- Delete obsoleted workflows
- Update CLAUDE.md tech stack section

### Wave 10: Cutover + live deploy (sequential)
- Update `npm run build` → `astro build`
- Re-enable deploy.yml push trigger
- Test deploy via workflow_dispatch
- Curl + visual verification on 20+ URLs
- Live deploy via push to main

### Wave 11: Monitor (passive — user comes back to this)
- 14-day GSC + PostHog + AdSense monitoring window
- Rollback artifact preserved

## Risks accepted by user directive

- **SEO regression risk**: hard cutover with no coexistence. Production goes from Vite-SPA → Astro-static in one deploy. Google may re-evaluate ranking; can take 7-21 days. SEO moratorium #19 rule technically violated but user has authority to override.
- **Interactive-surface regression**: React islands may behave differently than current SPA. Calculator funnel + map + charts need verification.
- **Translation drift**: i18n migration may surface missing keys.
- **Newsletter autologin params**: must be preserved through Astro middleware.
- **AdSense + PostHog instrumentation**: must be re-wired in islands.
- **Cron crawler conflicts during migration**: crawlers continue committing to main while migration is in flight. Will need careful rebases.

## Sub-plan reference mapping

| Old sub-plan | New wave | Notes |
|---|---|---|
| 01 (Zod foundations) | DONE on `worktree-astro-zod-01-impl` | Merge to main at Wave 0 |
| 02 (Astro skeleton coexistence) | Wave 1+2 | But NO coexistence — Astro is the primary |
| 03 (articles MDX) | Wave 3 (Agent B) | Big-bang as planned |
| 04 (programmatic landings) | Waves 3+5 | Collections + Astro routes |
| 05 (SPA decomposition) | Waves 5+6 | App.tsx dies; islands replace |
| 06 (i18n) | Wave 7 | astro-i18n native |
| 07 (build pipeline) | Waves 4+8+9 | Workflow rewiring + deploy adapter + cleanup |
| 08 (cutover) | Wave 10 | Hard cutover, live deploy |

## Models for autonomous execution

- Sonnet for most implementer dispatches (mechanical Astro generation)
- Opus for architectural decisions (i18n setup, middleware, firebase integration)
- Haiku for review/verification dispatches
- Override CLAUDE.md's parallel cap; up to 8-10 in parallel where file scope is disjoint

## Stop conditions

- ANY data loss detected (collections incomplete) → halt + report
- Astro build fails irrecoverably after enrichment → halt + report
- Live deploy returns 5xx for >5% of curl probes → roll back + report
