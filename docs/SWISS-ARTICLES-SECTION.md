# Switzerland-wide Articles Section (`svizzera`)

National mirror of the cross-border (`frontaliere`) blog article section. Same
features, broader scope: economy, taxes, work, living, housing for **anyone
living or working in Switzerland**, not only cross-border workers.

## Design principle — additive, not fork

The frontaliere section is the **default** and stays byte-identical. The svizzera
section reuses the same runtime component, build plugins, maintenance scripts and
i18n key namespace; it differs only in data + URL slug + body/meta location. A
single source of truth lives in `services/articleSections.ts`
(`ARTICLE_SECTIONS`). The i18n key namespace is shared (`blog.article.{id}.*`) —
article ids never collide across sections (the generator dedups on id), so no
prefix threading is needed.

## URL namespace

| locale | frontaliere | svizzera |
|--------|-------------|----------|
| it | `/articoli-frontaliere/` | `/articoli-svizzera/` |
| en | `/cross-border-articles/` | `/swiss-articles/` |
| de | `/grenzgaenger-artikel/` | `/schweiz-artikel/` |
| fr | `/articles-frontalier/` | `/articles-suisse/` |

## Per-section artifacts

| concern | frontaliere | svizzera |
|---------|-------------|----------|
| registry | `data/blog-articles-data.ts` (`ARTICLES`) | `data/swiss-articles-data.ts` (`SWISS_ARTICLES`) |
| slug data | `services/routerBlogData.ts` (`BLOG_SLUGS`) | `services/routerSwissData.ts` (`SWISS_SLUGS`) |
| body | `services/locales/blog-body/{loc}/{id}.ts` | `services/locales/blog-body-ch/{loc}/{id}.ts` |
| meta | `services/locales/blog-meta-{loc}.ts` | `services/locales/blog-meta-ch-{loc}.ts` |
| seo | `services/seo/seo-blog{,-2..7}.ts` | `services/seo/seo-blog-ch.ts` |
| sitemap | `public/sitemap-blog.xml` | `public/sitemap-blog-ch.xml` |
| trending | `public/article-trending.json` | `public/article-trending-ch.json` |

## Routing

`AppRoute` carries `blogSection?: 'frontaliere' | 'svizzera'` plus `swissArticle`
/ `swissSlug` (mirrors `blogArticle` / `blogSlug`). `SLUG_TABLES[loc].blogCh`
holds the hub slug; `parsePath`/`buildPath` branch on the hub slug / section.
`preloadSwissData()` + `resolveSwissSlug()` lazily load `routerSwissData.ts`.
The bare hub + articles route via the SPA (`blogCh` top-level slug → `blog`
tab); the paginated archive (`/articoli-svizzera/tutti/page-N/`) is a static SEO
hub recognized by `isSeoHubPath`.

## Navigation

A `SubTabNav` toggle (Frontalieri | Svizzera) under the Articoli tab switches
`blogSection`. The shared `BlogArticles` component takes a `section` prop and
reads the matching registry / body dir / meta chunk.

## Generation pipeline

`scripts/create-article.mjs --section=svizzera` authors into the svizzera
registries using national CH news sources and a national-scope relevance
classifier. Dedup/state files are section-keyed so svizzera dedups against its
own set. Maintenance scripts accept `--section`: `batch-add-faq-to-articles.mjs`,
`fix-faq-locales.mjs` (translate backfill), `audit-articles-factcheck.mjs`,
`audit-evergreen-articles.mjs`, `fetch-article-trending.mjs`.

## Not yet wired (follow-up)

- **Bare hub static landing** `/articoli-svizzera/` is emitted by the SPA, not
  pre-rendered by `staticPagesPlugin` (the `/tutti/` archive ladder is). Wire the
  static bare-hub landing when traffic warrants.
- **Google-News topic section pages** (`sectionPagesPlugin`) stay
  frontaliere-funnel-scoped; a parallel svizzera taxonomy is a standalone feature.
- **Discovery-pool / evidence-slot** generation is frontaliere-only; svizzera
  uses the proven-only generation path.
- CTA nav-actions + image catalog are reused from frontaliere (v1 simplification).
