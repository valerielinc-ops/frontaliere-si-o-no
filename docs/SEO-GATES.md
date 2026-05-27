# SEO Content Gates

Each gate is a **per-feature ratchet**: counts can only go DOWN. Improvements never auto-rebaseline — run the listed `:rebaseline` script after a deliberate drop and commit the new baseline together with the fix.

> **Hard rule (CLAUDE.md non-negotiables #1, #5):** Never widen a baseline as a workaround. Never set `noindex` to "fix" an orphan/deep page without explicit per-URL approval. Default fix is internal links, not de-index.

---

## 1. Text-to-HTML ratio

**Why.** Semrush flags pages with `visibleText / totalHTML ≤ 10 %` as "low text-to-HTML ratio". The Apr 2026 audit caught 1,193 such pages.

**Where.**
- Local: `npm run audit:text-html-ratio` (after `npm run build`)
- CI: `Gate — text-to-HTML ratio` step in `.github/workflows/deploy.yml`
- Baseline: `data/text-html-ratio-baseline.json`
- Rebaseline: `npm run audit:text-html-ratio:rebaseline`

**Playbook on regression:**

1. `npm run build && npm run audit:text-html-ratio` — stderr names the regressing feature bucket.
2. Inspect worst offenders: `node scripts/audit-text-html-ratio.mjs --feature=<name> --limit=20`
3. Find the emitter:

   | Feature bucket | Plugin / source |
   |---|---|
   | `fuel-daily` | `build-plugins/fuelDailyPagesPlugin.ts` |
   | `weekly-employers` / `weekly-employers-hub` | `build-plugins/weeklyEmployersPlugin.ts` |
   | `health-premiums` | `build-plugins/healthPremiumsLandingPlugin.ts` |
   | `job-board` | `build-plugins/jobsSeoPagesPlugin.ts` |
   | `blog` | `scripts/create-article.mjs` |
   | `spa-locale` / `spa-other` | `build-plugins/htmlTemplate.ts` + SPA prerender shell |

4. Add **coherent, page-relevant** content — methodology paragraph, FAQ, scenario walk-through, contextual cross-references. Never hidden text or boilerplate (Google penalises template-wide duplication and cloaking).
5. Rebuild + rerun + rebaseline + commit.

---

## 2. Orphaned pages in sitemaps

**Why.** Semrush flagged 4,936 "orphaned pages in sitemaps" — pages listed in any `sitemap-*.xml` but not reachable via internal `<a href>` BFS from the homepage.

**Where.**
- Local: `npm run audit:orphan-sitemap-pages`
- CI: `Gate — orphan pages in sitemaps` step in `.github/workflows/deploy.yml`
- Baseline: `data/orphan-pages-baseline.json`
- Rebaseline: `npm run audit:orphan-sitemap-pages:rebaseline`

**Playbook.** The cause is usually:
- **Static archive page lost an internal link** (e.g. nav widget removed) — fix the link source.
- **New auto-generated content** (cron-published article/job) with no static linker — add a link from the relevant index (`/articoli-frontaliere/` → `/articoli-frontaliere/tutti/`) or update the archive pagination.
- **Sitemap entry without HTML** (stale entry) — restore page or remove from sitemap.

---

## 3. ImageObject license fields (zero tolerance)

**Why.** Google Search Console flags every `ImageObject` in JSON-LD that omits any of the five licensable-image fields: `acquireLicensePage`, `copyrightNotice`, `license`, `creator`, `creditText`. Without ALL five, the image is ineligible for licensable-image rich results and surfaces as "Migliora l'aspetto degli elementi" in GSC.

**Where.**
- Helper: `services/seo/imageObjectLd.ts` — every new emitter MUST go through `imageObjectLd()` / `imageObjectLdDocument()`. Helper defaults to site Organization as creator + `/termini-di-servizio#licenza-immagini` license URL. `creditText` defaults to resolved `creator.name` or `"Frontaliere Ticino"`.
- Local audit: `npm run audit:image-object-license`
- CI: `audit:image-object-license` step in `.github/workflows/post-deploy-validation.yml`
- Vitest: `tests/seo/image-object-license-fields.test.ts` (runs in pre-push when `RUN_DIST_GATES=1`)

**Hard rule.** Zero tolerance — no ratchet/baseline. For third-party images (webcams, press photos), pass overrides to `imageObjectLd()`; never strip fields:

```ts
imageObjectLd({
  contentUrl: webcam.imageUrl,
  creator: { '@type': 'Organization', name: webcam.sourceName },
  license: webcam.license,
  copyrightNotice: `© ${webcam.sourceName}`,
})
```

---

## 4. BFS depth from `/` (MAX_DEPTH=4)

**Why.** Real crawlers (Ahrefs, Googlebot) cap their crawl depth. A URL only reachable at BFS depth ≥ 5 from `/` is effectively orphan even if `audit:orphan-sitemap-pages` accepts it. May 2026 Ahrefs audit caught 1,854 IT blog articles in this gap.

**Where.**
- Local: `npm run audit:max-bfs-depth`
- CI: `audit:max-bfs-depth` step in `.github/workflows/post-deploy-validation.yml`
- Baseline: `data/bfs-depth-baseline.json`
- Rebaseline: `npm run audit:max-bfs-depth:rebaseline`

**Depth schema (default MAX_DEPTH=4):** `0=/`, `1=tab`, `2=hub index`, `3=archive page`, `4=leaf URL` (articles, jobs). Running with a different `--max-depth` than the baseline refuses to compare.

**Playbook.** The cause is usually:
- **Compact pagination ate the link graph**: section index links only `page-1, current-1, current, current+1, last` — pages 3..N-2 reachable only via chained "next" clicks. Fix: emit a full page navigator linking every `page-N` directly. Reference: commit `aa987d38f7` for the `/articoli-frontaliere/` fix.
- **Hub page lost a child-list section**: e.g. `/mercato-lavoro-ticino/` stopped listing per-sector snapshots. Fix: add child-list `<section>` so each child is at depth 2 from `/`.

---

## 5. `<title>` length (60 + 10 % tolerance, max 66)

**Why.** Google's SERP-display budget is ~60 char; titles past it get visually truncated or rewritten by Google, costing keyword visibility. May 2026 Semrush audit flagged 2,740 indexable pages — almost all with the `" | Frontaliere Ticino"` brand suffix (22 char) appended on top of an already-near-cap headline.

**Where.**
- Helper: `build-plugins/shared/titleSuffix.ts` exports `TITLE_TARGET_CHARS = 60`, `TITLE_MAX_CHARS = 66`, and `buildTitleWithBrand()`. The helper **drops the brand suffix** when `headline + brand > 66` instead of truncating mid-headline.
- Local audit: `npm run audit:title-length`
- CI: shard 3 of `scripts/lib/post-build-tasks.sh`
- Baseline: `data/title-length-baseline.json`
- Rebaseline: `npm run audit:title-length:rebaseline`

**NEVER reintroduce mid-`…` truncation:** it tanked CTR on `/calcola-stipendio/` 4.8 % → 0.99 % during the cap=70 era.

**Job-board exception.** `composeJobPageTitle` in `build-plugins/jobsSeoPagesPlugin.ts` passes `JOB_TITLE_MAX = 70` to preserve city + (#hash) disambiguator structure. Job pages account for the bulk of the baseline by design.

**Playbook.** Cause is usually:
- **New template added a brand-preserving caller** that didn't go through `buildTitleWithBrand` — route through helper.
- **AI-generated headline drift**: `create-article.mjs` prompts started returning ~70-char headlines — fix prompt to target 50-60 char.
- **Cap intentionally raised**: someone bumped `TITLE_MAX_CHARS` past 66. Reject — never widen the cap.

Use `FAST_BUILD= npx vite build && npm run audit:title-length` to reproduce locally (FAST_BUILD env trap).

---

## 6. `(#hash)` disambiguator visible in `<title>`

**Why.** When two articles produce the same base `<title>`, the og-pages plugin appends a runtime disambiguator (`build-plugins/ogPagesPlugin.ts:articleHashFromSlug`). Disambiguator prefers a HUMAN-READABLE token (year `(2026)`, known city `— Bellinzona`, trailing slug word) and falls back to an FNV-1a 8-hex hash `(#abcd1234)` only as last resort. May 2026 Semrush audit caught **935 IT blog pages** with the hash visible in SERP — kills CTR. Goal: drive count to 0 by deduping at source.

**Where.**
- Local: `npm run audit:title-no-disambig-hash` (greps `dist/` for `\(#[0-9a-f]{8}\)` inside `<title>`)
- CI: shard 3 of `scripts/lib/post-build-tasks.sh`
- Baseline: `data/title-no-disambig-hash-baseline.json`
- Rebaseline: `npm run audit:title-no-disambig-hash:rebaseline`
- Preventive: `scripts/create-article.mjs:optimizeSeoMetadata` checks new article's IT title against existing `blog-meta-it.ts` titles AT CREATE TIME and auto-appends year/city. Hard-fails when year+city are insufficient.

**Playbook.**
1. `FAST_BUILD= npx vite build && npm run audit:title-no-disambig-hash` — stdout shows offending pages with hash + base title.
2. Find colliding pair: grep `services/locales/blog-meta-it.ts` for the base title (without brand suffix). Two articles with the same `'.title'` value will be the cause.
3. Fix at source by editing one article's `'.title'` in all four locale meta files (`blog-meta-{it,en,de,fr}.ts`). Add a year/city/source qualifier: `"Primo Maggio a Varese"` → `"Primo Maggio a Varese 2026: corteo CGIL"`.
4. NEVER widen the baseline as a workaround.
