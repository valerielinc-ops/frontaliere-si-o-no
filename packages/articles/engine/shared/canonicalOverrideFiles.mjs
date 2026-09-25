/**
 * Where each article section's canonical-override map lives, per repo layout.
 *
 * **What the override map does** (unchanged, issue #3010 item 1): the shadowed
 * member of a near-duplicate pair points `<link rel="canonical">` and `og:url`
 * at the authoritative winner instead of at itself, so Google consolidates the
 * ranking signal onto one URL. Both pages stay live and reachable at their own
 * URL — the repo anti-cut rule forbids removing or noindexing an indexed page —
 * and the only other effect is that the shadowed URL is not advertised in a
 * sitemap (a `<loc>` whose page canonicalises elsewhere is a hard CI gate
 * failure: `scripts/audit-sitemap-canonicals.mjs`,
 * `scripts/validate-sitemap-pages.mjs`).
 *
 * **Why this is a separate `.mjs` and not a field inside
 * `articleSectionDescriptors.ts`.** Three runtimes need the same literal and
 * only one of them can load TypeScript:
 *   - the engine renderer (`ogPagesPlugin.ts`), via
 *     `ARTICLE_SECTION_DESCRIPTORS`, under Vite here and under `tsx` in the
 *     corpus repo;
 *   - `scripts/lib/article-canonical-overrides.mjs`, imported by raw-`node` CI
 *     scripts with no TS loader (`scripts/ci/check-blog-slugs-sitemap-sync.mjs`,
 *     `scripts/pull-articles-api.mjs`);
 *   - the tests.
 * Same shim-free reasoning as `articleSectionCore.mjs` next door: pure data, no
 * `fs`, no dependency, importable by a plain relative path from anywhere.
 *
 * **Why a candidate LIST per section.** Article pages are rendered by the
 * corpus repo (nanakokyobashi-rgb/frontaliere-articles) since the 2026-08-02
 * cutover, so a path that only resolves in this repo makes the whole mechanism
 * inert where it matters — and inert quietly, because
 * `loadSwissArticleCanonicalOverrides` degrades to `{}` by design. The two
 * layouts differ:
 *
 *   | file ships in                        | this repo                              | corpus repo   |
 *   |--------------------------------------|----------------------------------------|---------------|
 *   | the corpus (`content/`)              | `data/…` (site-owned copy)             | `content/…`   |
 *   | the engine (`packages/articles/…`)   | `packages/articles/engine/shared/…`    | `engine/…`    |
 *
 * The frontaliere map ships INSIDE the engine deliberately. `mirror-articles-engine.yml`
 * carries `packages/articles/engine/**` (plus `index.ts` and `articleSections.ts`)
 * and nothing else, and `scripts/pull-articles-corpus.mjs` mirrors the corpus's
 * `content/` back over `packages/articles/content/` with deletions — so a new
 * data file placed there would be deleted on the next pull and would never
 * reach the renderer. Engine-local is the only home in this repo that both
 * survives the pull and travels with the mirror.
 */

/**
 * Repo-root-relative candidate paths, per section, in resolution order.
 * @type {Record<'frontaliere' | 'svizzera', readonly string[]>}
 */
export const CANONICAL_OVERRIDE_FILES = {
  // Ships with the engine (see the header): resolves here and, after the
  // engine mirror, in the corpus repo at `engine/shared/…`.
  frontaliere: [
    'packages/articles/engine/shared/frontaliere-article-canonical-overrides.json',
    'engine/shared/frontaliere-article-canonical-overrides.json',
  ],
  // Predates the cutover and ships with the corpus, so it keeps its two
  // historical homes. `content/…` is listed second because it is the corpus's
  // copy of the same file — without it the svizzera map resolves to `{}` in
  // the repo that renders the pages, which is how twelve svizzera URLs ended
  // up de-listed from `sitemap-blog-ch.xml` while their pages still declared
  // themselves canonical.
  svizzera: [
    'data/swiss-article-canonical-overrides.json',
    'content/swiss-article-canonical-overrides.json',
  ],
};
