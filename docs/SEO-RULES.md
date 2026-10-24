# SEO Rules — Detailed Reference

> This file is referenced from CLAUDE.md. Read on-demand when working on SEO, structured data, or job pages.

## Canonical URL

**Always use `https://frontaliereticino.ch`** — no `www`. Every page URL is slash-terminated (site-wide trailing-slash convention: `buildPath()` forces it; no-slash variants 301 to the slash form at the edge) — only the bare origin string carries no trailing path slash. All sitemaps, hreflang, JSON-LD, and workflow scripts must use this form.

## Static Page Generation

This is a client-side SPA. Without static HTML, Google sees an empty `<div id="root">`. The build pipeline generates **~16,000+ static HTML files** via Vite plugins:

- `ogPagesPlugin` — 524 blog article pages
- `jobsSeoPagesPlugin` — 4396 active job pages + 9507 expired soft-landings + 548 company pages + 211 search pages
- `staticPagesPlugin` — 2431 content pages

**Every new page MUST generate a static HTML file in `dist/`.** If it doesn't, it will NOT be indexed.

## JobPosting Structured Data — schema always present, each field iff the source states it

Owner decision 2026-10-24: every active job page in every locale MUST carry valid `JobPosting` JSON-LD, and **every field in it is present if and only if it exists in the source** (the listing, the employer's publisher form, or the employer's curated HQ in the job's own city). A missing optional field is the contract; an invented one is the defect. This replaces the old "ZERO TOLERANCE — even optional fields must always be present using defaults" rule, which shipped the Lugano town hall ("Piazza Riforma 1", 6900) as the street of every Lugano job, sector estimates as `baseSalary`, `FULL_TIME` for unknown contracts and a synthetic `validThrough`.

### Active job ⇒ JobPosting, always (owner decision 2026-10-24)

An active (non-expired) job detail page **never** omits `JobPosting`, whatever the provenance of its data. From 2026-10-04 (PR #11394, with #11303/#11276) to 2026-10-24 the build withheld the schema from listings without a verified publication date; #13286 restored it for six URLs only and #14546 kept first-seen "display-only". Google for Jobs clicks (`searchAppearance JOB_LISTING`) fell from ~2,100 to ~1,000 per weekday from 3-5 October. Never reintroduce a "withhold the schema" branch: `buildJobPostingSchema()` returns a non-nullable `JobPostingSchema` so such a branch fails type-checking at every caller.

- **`datePosted` chain** (`resolveSchemaPostingDate`, `scripts/lib/job-posting-date.mjs`, mirrored in `functions/src/lib/jobPostingDate.js`): `reported` source date (validated, not in the future) → `first-seen` (`firstSeenAt`: when the listing appeared on the site) → `observed` (earliest of `crawledAt`/`scrapedAt`/`updatedAt`) → `build-clock` (build date, only for a record with no usable timestamp). Never a future date, never the old `1970-01-01` sentinel.
- **Provenance stays separate.** Visible recency UI, "new" badges and alerts keep reading `resolveReportedPostingDate()` / `firstSeenAt` (`resolveRolloutPostingDate`); the chain feeds structured data only.
- **Cache reuse** cannot drop the schema: a cached active page without JobPosting is invalidated and re-rendered (`shouldInvalidateActiveJobReuseWithoutJobPosting`), and a missing date fails closed into a re-render.
- **SPA** (`JobBoard.tsx`): when the client cannot build its own schema it keeps the static JobPosting, unconditionally.
- **Expired pages** keep their own contract: JobPosting with a past `validThrough` only when the archive holds a reported publication date, a real title/employer and a real past timestamp. Removing the markup is itself one of Google's documented ways to retire a listing, so an archive with only synthetic dates carries `WebPage` metadata instead. A URL with no archived record at all ("Offerta non verificata", `noindex`) has nothing verifiable to describe and carries no JobPosting by construction.

**Gates (blocking, zero tolerance — they judge what this build emits):**
1. In build: `jobsSeoPagesPlugin` feeds every active canonical detail, as written (fresh render or cache reuse), to `createActiveJobPostingCoverage()` (`scripts/lib/active-jobposting-coverage.mjs`) and throws if any lacks JobPosting. It prints `[jobposting-coverage] active=… with-jobposting=… rate=…%` on every build.
2. Post build: with `JOBPOSTING_COVERAGE_OUT` set (deploy build step) the plugin writes the list of those pages; `scripts/ci/assert-active-jobposting-coverage.mjs dist` re-reads each one from the final, pruned `dist/` and fails the deploy on a page that lost JobPosting, on an absent page, or on a missing/truncated sidecar.

### Always present (Google's required set — missing is deploy-blocking)
`title`, `description`, `datePosted`, `hiringOrganization.name`, `jobLocation` with `addressLocality` and `addressCountry`. Contract: `MANDATORY_JOBPOSTING_FIELDS` in `scripts/lib/jobposting-mandatory-fields.mjs`; the builder throws on a regression (`assertMandatoryFieldsComplete` in `build-plugins/shared/jobPostingSchema.ts`).

### Present only when the source states them (malformed when present is deploy-blocking)
- **`baseSalary`**: only `salarySource: 'reported'` (publisher ads: the employer's own figure). `maxValue` only when the source states an upper bound — a single figure is never widened by 20 %. Sector estimates (`salarySource: 'estimated'`, `salaryDefaults.ts`) and structured salaries of unknown origin (`existing`, missing) **stay visible on the page with an explicit label** — "(stima)" / "(fonte non verificata)" from `build-plugins/shared/salaryEstimateSuffix.ts`, and an FAQ answer that says the listing states no salary — and never reach the markup.
- **`streetAddress` / `postalCode`**: the listing's own street (`isSourceStreetAddress`: a street, not the locality name) and its own CAP when coherent with the locality (not another city's CAP, not a crawler canton default); or the curated `COMPANY_HQ_ADDRESSES` tuple, whole, only when the job sits in the HQ city and the listing names no other CAP there. Never a city-hall table, never "<city> centro", never the canton capital's tuple. `addressRegion` stays (it comes from the canton).
- **`employmentType`**: the contract types the listing states, resolved once by `scripts/lib/job-employment-type.mjs` from `employmentType`, `contract`, `contractType` (`OTHER` = crawler could not read it, not a statement), else from the workload the title states (#15009: "60%" → PART_TIME, "80-100%" → FULL_TIME) — one token or an array (`["FULL_TIME","TEMPORARY"]` for "A tempo pieno, Interinale"). Unknown or unrecognised → absent, and the page prints the same resolution ("Contratto: Tempo pieno, Temporaneo" / "non indicato"). "permanent"/"indeterminato" state a duration, not hours: they are not `FULL_TIME`.
- **`validThrough`**: only the source deadline. Google: "If a job posting never expires, or you don't know when the job will expire, don't include this property." The synthetic windows (crawledAt+60d, datePosted+90d, floor now+30d, #3505) are gone; the expired contract does not need them, because an expired page uses the archive's real past timestamps (see below) and an active page that stops being listed becomes that expired page.
- **`responsibilities` / `qualifications`**: only text of the same listing. A crawler must cut its body where other offers start (PEMSA: `cutPemsaRelatedOffers`, by offer id).
- **`description`**: Use locale fallback chain (locale -> Italian -> raw description); when the result is thinner than 30 chars the static page synthesizes a description from the structured fields (title, company, city, contract) — the schema is never skipped. Only the SPA runtime path, which cannot synthesize it, skips its own copy and keeps the static one.

### Observer
`scripts/validate-jobs-rich-results-sample.mjs` (`npm run validate:jobs-rich-results`) compares each built JobPosting with the `data/jobs.json` record it came from, both ways: a field the source lacks is an error (`baseSalary:estimate_in_markup`, `streetAddress:not_from_source`, `validThrough:not_from_source`, `employmentType:not_from_source`), and so is a source value the page dropped (`baseSalary:reported_salary_dropped`, `validThrough:source_value_dropped`).

### Applies to all page types:
- Active job pages (all 4 locales) — validated by `validate-jobs-rich-results-sample.mjs`
- Expired job soft-landing pages — same rules apply: no generated defaults
- Bridge pages (non-IT locale redirects, `__BRIDGE_TARGET_SLUG__`) — treated as warnings, not errors

### SPA runtime schema (JobBoard.tsx):
- The `JobBoard` component dynamically injects `JobPosting` JSON-LD via `useEffect`
- Same rules apply: description fallback chain; source fields only (it reads the raw `contract`/`employmentType`/`contractType`, never the `'full-time'`-defaulting filter bucket of `normalizeJobContract`)
- Jobs with description < 30 chars are excluded from the SPA's own schema graph, and the static JobPosting is then preserved (never removed)

The validation script `scripts/validate-jobs-rich-results-sample.mjs` (`npm run validate:jobs-rich-results`) audits a dist against `data/jobs.json`: every active job/locale must carry JobPosting and its `datePosted` must match the provenance chain. The deploy-blocking gates are the two coverage gates above. **Do not weaken them. `employmentType` is an error, not a warning.**

The validation script `scripts/validate-jobs-rich-results-sample.mjs` enforces this. **Do not weaken it: a schema without the required fields, a malformed optional field, or an optional field that is not in the source are errors, not warnings.**

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
