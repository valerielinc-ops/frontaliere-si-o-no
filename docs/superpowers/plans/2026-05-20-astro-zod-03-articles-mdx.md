# Sub-Plan 03: Articles Big-Bang Migration to MDX

> **For agentic workers:** This is a STUB. Expand to bite-sized TDD tasks before executing.

**Goal:** Migrate all 2,702 articles × 4 locales = ~10,800 TypeScript body files to MDX. End state: every article lives at `src/content/articles/{slug}.{locale}.mdx` with Zod-validated frontmatter (via sub-plan 01's `ArticleMetaSchema`+`LocalizedArticleSchema`). Drop `data/blog-articles-data.ts`, `services/locales/blog-meta-{it,en,de,fr}.ts`, `services/locales/blog-body/{it,en,de,fr}/`. Rewire `scripts/create-article.mjs` to emit MDX directly (no more TS modules). Article rendering moves from runtime SPA hydration of TS imports → Astro static pages with React islands only for interactive components (`<Calc />`, `<NewsletterForm />`, etc.).

**Architecture:**
- **Migration script** (`scripts/migrate-articles-to-mdx.mjs`, one-shot): reads `data/blog-articles-data.ts` for metadata, reads each `services/locales/blog-body/{locale}/{id}.ts` for body, reads `services/locales/blog-meta-{locale}.ts` for title/excerpt, emits `src/content/articles/{id}.{locale}.mdx` with merged frontmatter + body. Idempotent — re-running produces byte-identical output.
- **Frontmatter:** every mandatory field from `LocalizedArticleSchema`. Adds `originalTsBodyPath` (pointer to source file) for one round-trip verification, then dropped.
- **Body:** ported from the TS body files. These contain HTML strings (`<p>...</p>...`); MDX handles raw HTML natively. Interactive components currently rendered as inline JSX from the TS module become MDX component imports (`import Calc from '@/components/Calc'`).
- **Astro route:** `src/pages/articoli/[slug].astro` for IT, `src/pages/{en,de,fr}/articles/[slug].astro` for others. Each calls `getCollection('articles')` filtered by locale, builds dynamic paths, renders via `BaseLayout`.
- **`create-article.mjs` rewire:** AI prompt template updated to output MDX (frontmatter YAML + body markdown/MDX). Output written directly to `src/content/articles/{id}.{locale}.mdx`. Validation via `LocalizedArticleSchema.parse()` before write.
- **Cleanup commit (separate from migration commit):** delete the 3 source paths after the migration script verifies byte-equivalence of rendered HTML.

**Tech Stack:** Astro content collections (sub-plan 02), MDX, Zod (sub-plan 01), Node fs/promises.

**Depends on:** Sub-plan 02 (Astro skeleton + content config + MDX integration must exist).

**Estimated effort:** 2 weeks (10 engineering days).

**Ships standalone value:** ✅ Yes. Once shipped, all 2,702 articles are served from Astro static output, and the legacy TS-module pipeline can be retired.

---

## File structure (planned)

**Created:**
- `scripts/migrate-articles-to-mdx.mjs` — one-shot migration
- `scripts/verify-article-render-equivalence.mjs` — byte-diff legacy article render vs Astro article render
- `src/content/articles/{slug}.{locale}.mdx` × 10,800 files
- `src/pages/articoli/[slug].astro` (IT — no prefix per CLAUDE.md i18n convention)
- `src/pages/en/articles/[slug].astro`
- `src/pages/de/artikel/[slug].astro`
- `src/pages/fr/articles/[slug].astro`
- `src/components/ArticleLayout.astro` — shared article shell
- `src/components/ArticleCalculatorIsland.tsx` — React island for inline calculator embed (replaces inline JSX from TS bodies)
- `tests/articles-migration-equivalence.test.ts` — sample-N test that legacy render === Astro render for representative articles

**Modified:**
- `src/content/config.ts` — extend `articles` collection schema (sub-plan 02 had a stub; flesh it out here)
- `scripts/create-article.mjs` — emit MDX instead of TS
- `package.json` — `npm run new-article` continues to work
- `services/router.ts` — remove article-related route shapes (only safe after sub-plan 05 ships, so this modification may move to sub-plan 05)

**Deleted (in cleanup commit):**
- `data/blog-articles-data.ts`
- `services/locales/blog-meta-it.ts` (and en, de, fr)
- `services/locales/blog-body/it/` (entire directory)
- `services/locales/blog-body/en/`, `de/`, `fr/`
- Any test files that hard-coded reads of the above (port to read from `getCollection('articles')` instead)

---

## Phases (each becomes ~5-20 bite-sized tasks when expanded)

1. **Schema completeness pass.** Extend `LocalizedArticleSchema` (sub-plan 01) with every field actually present in `blog-articles-data.ts` ARTICLES entries that wasn't in the initial schema (e.g., `hasCalculator`, `imageAlt`, ...). Test against 20 sample articles. ~1 day.
2. **Migration script (read side).** Build a function `loadLegacyArticle(id, locale)` that returns a `LocalizedArticle`-shaped object by merging the 3 source files. Test against 100 sample articles. ~1 day.
3. **Migration script (write side).** Build `emitMdx(article)` that produces frontmatter YAML + body MDX. Test on 10 articles — re-import via Astro content collection, verify schema validates. ~1 day.
4. **Migration dry run.** Run on all 2,702 × 4 = 10,800 articles in a scratch dir (NOT in `src/`). Inspect error log; expect schema violations on legacy articles missing the new required fields. Triage each pattern of violation. ~1 day.
5. **Triage gap-fill.** Either (a) extend schema with reasonable defaults (e.g., `imageAlt` derives from title if missing), or (b) script a back-fill pass on the legacy TS files first, or (c) document accepted exceptions. Each exception is justified or it's not allowed. ~1-2 days.
6. **Full migration commit.** Run the migration script for real, into `src/content/articles/`. ONE huge commit ("feat(articles): migrate 10,800 articles to MDX"). PR shows `+10800 files` — that's expected. ~0.5 day.
7. **Astro route page.** Build `src/pages/articoli/[slug].astro` consuming the collection. Verify one URL (`/articoli/stipendio-netto-2026/`) renders byte-equivalent (L2: DOM + content-equivalent) to legacy. ~1 day.
8. **Locale routes.** Same for en/de/fr. ~1 day.
9. **Verification harness.** Run `scripts/verify-article-render-equivalence.mjs` over a stratified sample of 100 articles (high-traffic + recently-edited + edge-case categories). L2 equivalence target: 100% pass. ~1 day.
10. **CI gate.** Add a vitest test that runs the verification harness over a stable 20-article sample on every PR. ~0.5 day.
11. **create-article.mjs rewire.** AI prompt now requests MDX. Validate output against `LocalizedArticleSchema`. New articles written directly to `src/content/articles/`. ~1 day.
12. **Cleanup commit.** Delete legacy files. Run full test suite. Confirm zero broken imports. ~0.5 day.
13. **PR + deploy + 48h soak.** Watch GSC `/articoli/*` for any drop in indexed pages or click loss. ~0.5 day + monitoring window.

---

## Critical risks

1. **HTML semantic drift.** Legacy TS body files contain HTML strings; MDX may re-parse and emit subtly different whitespace, attribute order, or self-closing tags. Mitigation: L2 equivalence (DOM-equivalent, not byte). Accept minor whitespace diffs that don't change rendered text or DOM structure.
2. **Inline component embeds.** Some legacy TS bodies likely contain inline JSX like `<Calculator />` or `<Newsletter />`. MDX requires these as imports + ESM. Migration script must detect inline JSX, generate the right `import` statements at the top of the MDX file.
3. **Body word-count below 50 in legacy articles.** `ArticleLocaleBodySchema` (sub-plan 01) requires ≥50 words. Some legacy articles may not qualify. Triage: rewrite or drop. Rule #4: never accept thin content.
4. **Volume — 10,800 file PR.** `gh pr create` works but reviewer experience is terrible. Mitigation: PR body explicitly says "see migration script for content; no manual edits to individual MDX files; reviewer audits the SCRIPT". Also stage in a sub-directory first if needed.
5. **Git status / IDE performance.** 10,800 new files might slow `git status` and IDEs. Local: add `src/content/articles/*` to the `local-ignore-cron.sh` pattern. Remote: GitHub handles it fine.
6. **Migration is non-idempotent if `create-article.mjs` runs DURING migration.** Mitigation: pause the create-article cron during the migration PR. Document the cron stop+start in the PR.
7. **Article translations drift.** Each `{slug}.{locale}.mdx` is independent. If a translator/AI edits IT but not EN/DE/FR, you get drift. Mitigation: add a `translationCanonicalLastModified` frontmatter field that the build can compare; mark drifted translations stale.
8. **Test files that read `data/blog-articles-data.ts` directly will break on cleanup.** Inventory before phase 12: `grep -rln "blog-articles-data\|blog-body\|blog-meta" tests/` and convert each to use `getCollection('articles')` or fixture data.

---

## Rollback

- The migration is one PR. Revert it = revert all 10,800 file additions and the cleanup deletion. Single revert commit restores legacy.
- If discovered AFTER deploy: revert + force-deploy. Articles served from legacy TS modules until investigation completes.
- Backup: pre-migration tag `git tag pre-articles-mdx-migration` before the merge. Pinned for 30 days.

---

## Open questions to resolve before expansion

1. **Inline component coverage.** Does ANY legacy article body import or inline a React component? If yes, list them and design MDX imports. (Grep `services/locales/blog-body/it/ -l "<Calculator\|<Newsletter\|<Quote"` etc.)
2. **Image references.** Legacy bodies reference images as strings (`<img src="/images/...">`). MDX handles this fine — but Astro's image optimization (`@astrojs/image` or `astro:assets`) might want explicit imports. Decide: defer optimization to a later sub-plan, or do it during migration. Recommend: defer.
3. **`hasCalculator` flag behavior.** What does it currently trigger? If it's UI-only (renders a calculator below the article body), the MDX page template handles it conditionally and the flag stays in frontmatter. If it inlines a component into the body, design the embed.
4. **`updatedAt` semantics.** Should the migration set `updatedAt` to today (migration date) for every article, or preserve legacy `updatedAt`? Preserve. Last-modified shouldn't shift on a no-op migration.
5. **Slug rename history.** If a legacy article was renamed, `data/article-redirects.json` likely tracks it. Verify redirects still emit (sub-plan 04 may own this if landings own redirects).

---

## Execution handoff

(Same Subagent-Driven vs Inline question as sub-plan 01.)
