# SEO Rules — Detailed Reference

> This file is referenced from CLAUDE.md. Read on-demand when working on SEO, structured data, or job pages.

## Canonical URL

**Always use `https://frontaliereticino.ch/`** — no `www`, no trailing slash (except root). All sitemaps, hreflang, JSON-LD, and workflow scripts must use this form.

## Static Page Generation

This is a client-side SPA. Without static HTML, Google sees an empty `<div id="root">`. The build pipeline generates **~16,000+ static HTML files** via Vite plugins:

- `ogPagesPlugin` — 524 blog article pages
- `jobsSeoPagesPlugin` — 4396 active job pages + 9507 expired soft-landings + 548 company pages + 211 search pages
- `staticPagesPlugin` — 2431 content pages

**Every new page MUST generate a static HTML file in `dist/`.** If it doesn't, it will NOT be indexed.

## JobPosting Structured Data — ZERO TOLERANCE

Every active job page in every locale MUST have valid `JobPosting` JSON-LD with ALL fields. **Even "optional" fields must always be present using defaults/fallbacks — missing them is a deploy-blocking error.**

### Required fields (Google minimum for rich results)
`title`, `description`, `datePosted`, `hiringOrganization.name`, `jobLocation`

### Mandatory fields enforced as deploy-blocking errors
`baseSalary`, `postalCode`, `streetAddress`, `employmentType`, `validThrough`, `jobLocation.address.addressRegion`

### Fallback rules — when source data is missing, generate defaults (never omit):
- **`baseSalary`**: Use `minValue: 41080, currency: CHF, unitText: YEAR` (Ticino minimum wage)
- **`postalCode`**: Use `6900` (Lugano) if lookup fails
- **`streetAddress`**: Use `addressLocality` value as fallback
- **`employmentType`**: Default to `OTHER` if contract type unknown
- **`jobLocation`**: Default to `addressLocality: Bellinzona, addressRegion: TI, addressCountry: CH`. `addressRegion` is derived from `addressLocality` via `CITY_TO_CANTON` (build-plugins/shared/companyHqAddresses.ts) when source data is missing.
- **`validThrough`**: Source value wins; otherwise `crawledAt + 60 days`, then `datePosted + 90 days`, then `now + 60 days`. Must always be a valid ISO datetime.
- **`description`**: Use locale fallback chain (locale -> Italian -> raw description); skip JobPosting entirely if result < 30 chars

### Applies to all page types:
- Active job pages (all 4 locales) — validated by `validate-jobs-rich-results-sample.mjs`
- Expired job soft-landing pages — same rules apply, generate defaults
- Bridge pages (non-IT locale redirects, `__BRIDGE_TARGET_SLUG__`) — treated as warnings, not errors

### SPA runtime schema (JobBoard.tsx):
- The `JobBoard` component dynamically injects `JobPosting` JSON-LD via `useEffect`
- Same rules apply: description fallback chain, baseSalary always present
- Jobs with description < 30 chars must be excluded from the schema graph entirely

The validation script `scripts/validate-jobs-rich-results-sample.mjs` enforces this at deploy time. **Do not weaken it. `employmentType` is an error, not a warning.**

### Dataset schema (statistics pages):
Every `Dataset` schema.org block MUST include `description` and `creator` fields. These are validated by Google and missing fields appear in Search Console as warnings. All new Dataset schemas must follow the pattern used in `jobsObservatory` and `livability` entries in `seo-pages.ts`.

## Page-Level SEO Requirements (deploy-blocking)

Every static HTML page MUST have:
- **Exactly 1 `<h1>` tag** — not 0, not 2+. H1 must not be empty or inside `<noscript>`.
- **Valid `lang` attribute** on the `<html>` tag matching the page locale (`it`, `en`, `de`, `fr`).
- **Valid schema markup** — all `<script type="application/ld+json">` blocks must be parseable JSON with no conflicting primary schemas on the same object. BreadcrumbList is supplementary and can coexist with any primary schema.
- **Meta viewport** — `<meta name="viewport">` must be present.

These are enforced by `scripts/validate-page-seo-quality.mjs` at deploy time.

## Structured Data Validation Gate

`scripts/validate-structured-data-completeness.mjs` runs at deploy time and **blocks deploy** (exit 1) if any structured data schema has missing or invalid mandatory fields. It samples pages across all types: active jobs, expired soft-landings, company pages, statistics, and blog.

### Dataset schemas (statistics pages)

Every `Dataset` JSON-LD block MUST include:
- `description` — non-empty string describing the dataset
- `creator` — `{ "@type": "Organization", "name": "...", "url": "..." }`

Dataset schemas MUST be emitted as **top-level** JSON-LD objects (separate `<script type="application/ld+json">` blocks), NOT nested inside a WebPage's `about` property. Google does not reliably extract nested Dataset schemas.

### Future schema additions

When adding any new schema.org type, include ALL fields from Google's documentation for that type. Check Google Search Console's documentation for the specific rich result type. Every field marked "Required" or "Recommended" by Google MUST be present with a fallback value.

## SEO Checklist for New Pages

1. Add `SEO_METADATA` entry in `services/seoService.ts` with `canonicalPath`
2. Add to appropriate sitemap with hreflang for all 4 locales + x-default
3. Add router slugs in all 4 locale `SlugTable` objects
4. Verify static HTML generated: `dist/{slug}/index.html` exists with correct `<title>` and `<meta>`
5. Add to `SiteSearch.tsx` search index

## Job-board URL architecture (cathedral 2026-05-10)

Since the CH-wide cathedral expansion, job-board pages use a per-canton URL pattern:

- **Per-canton**: `/cerca-lavoro-{italian-canton-slug}/{job-slug}` for IT (e.g. `/cerca-lavoro-zurigo/`, `/cerca-lavoro-ticino/`); anglicized ASCII for non-IT locales (e.g. `/find-jobs-zurich/`, `/jobs-in-zurich/`, `/trouver-emploi-zurich/`).
- **Aggregator**: `/cerca-lavoro-svizzera/` (CH-wide listing) plus locale variants (`/find-jobs-switzerland/`, `/jobs-in-schweiz/`, `/trouver-emploi-suisse/`).
- **Slug source of truth**: `data/canton-url-slugs.json` (26 cantons + `_AGGREGATE_` × 4 locales = 104 entries).
- **Multi-canton jobs**: emit a SINGLE canonical URL with `JobPosting.jobLocation[]` array — never duplicate slugs across cantons (E8).
- **Frozen URL guarantee (E9)**: `data/slug-registry.json` is immutable per fingerprint. Reclassification (e.g. quorum gate moves a job from TI to GR) preserves the originally indexed URL.

### Sitemap-index + per-canton shards

The cathedral replaces the monolithic `sitemap-jobs.xml` with a sitemap-index:

- `dist/sitemap-index.xml` — top-level index referencing all per-canton + aggregator shards
- `dist/sitemap-jobs-{canton}.xml` — one per active canton (lowercase canton code)
- `dist/sitemap-jobs-svizzera.xml` — aggregator
- Generator: `scripts/lib/sitemap-shard.mjs`

Every new job page MUST land in the correct per-canton shard via the canton-quorum gate (`scripts/lib/canton-quorum-gate.mjs`); low-confidence classifications are excluded from sitemaps until upgraded. See [docs/CRAWLERS.md](CRAWLERS.md#cathedral-ch-wide-expansion-2026-05-10) for the gate logic and [docs/CATHEDRAL-IMPLEMENTATION-PLAN.md](CATHEDRAL-IMPLEMENTATION-PLAN.md) for the full design.
