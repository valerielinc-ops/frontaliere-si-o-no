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

## JobPosting Structured Data — schema and field coverage stay complete

Owner decision 2026-10-24: every active job page in every locale MUST carry valid `JobPosting` JSON-LD. Owner decision 2026-10-31 supersedes the field-omission part of that rule: improve the quality of available data without lowering coverage; replace weak values with better evidence and preserve the best existing value, marked for enrichment, when no stronger evidence is available. Do not invent a street or civic number. `streetAddressSource` records internal provenance and is never emitted in JSON-LD.

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

### Always present (site contract — missing is deploy-blocking)
`title`, `description`, `datePosted`, `hiringOrganization.name`, `jobLocation` with `addressLocality`, `addressCountry`, `postalCode` and `streetAddress`, `employmentType`, `baseSalary`, and `validThrough`. Contract: `MANDATORY_JOBPOSTING_FIELDS` in `scripts/lib/jobposting-mandatory-fields.mjs`; the builder throws on a regression (`assertMandatoryFieldsComplete` in `build-plugins/shared/jobPostingSchema.ts`). The per-record mandatory gate preserves the full active-inventory coverage baseline; `scripts/measure-jobposting-eligibility.mjs` also compares before/after coverage on the same snapshot.

### Provenance and quality rules
- **`baseSalary`**: present on every active JobPosting. A reported figure wins and `maxValue` appears only when the source states an upper bound; otherwise it carries the site's sector estimate, without label or removal (owner decision 2026-10-31, `docs/JOB-DETAIL-RENDERING-CONTRACT.md`). The visible page keeps its "(stima)" / "(fonte non verificata)" label.
- **`streetAddress`**: use the best verified level in order: listing street; curated company address in the same city; Zefix/LINDAS registered address in the same city; geocoded or otherwise known company address in that city; current best source value. The crawler write pipeline reads `data/prospector/jobposting-address-cache.json`; refresh that reusable cache with `node scripts/refresh-jobposting-address-cache.mjs`. Registry records are accepted only for the exact employer and same locality/canton. Internal `streetAddressSource` levels are `listing-source`, `curated-company-city`, `zefix-registry`, `known-company-address`, and `to-enrich`. If only a locality or another weak current value exists, retain it with `to-enrich` so coverage does not fall; count it separately. Never emit a "city centre" placeholder or synthesized municipal/canton-capital street. A source CAP must stay coherent with the locality.
- **`jobLocationType: TELECOMMUTE`**: only when the title or the location declares the job fully remote (`isFullyRemoteListing`). A "home office" benefit in the description, "hybrid" or a "remote hands" duty do not make an on-site job remote.
- **`employmentType`**: the contract types the listing states, resolved once by `scripts/lib/job-employment-type.mjs` from `employmentType`, `contract`, `contractType` (`OTHER` = crawler could not read it, not a statement), else from the workload the title states (#15009: "60%" → PART_TIME, "80-100%" → FULL_TIME) — one token or an array (`["FULL_TIME","TEMPORARY"]` for "A tempo pieno, Interinale"). Unknown or unrecognised → absent, and the page prints the same resolution ("Contratto: Tempo pieno, Temporaneo" / "non indicato"). "permanent"/"indeterminato" state a duration, not hours: they are not `FULL_TIME`.
- **`validThrough`**: a plausible source deadline wins. A missing, past, or ATS system-default date more than 365 days ahead is replaced with a bounded window from the latest saved active observation; the window shortens with posting age and is capped by employment type. Only a new real crawler observation renews it, so a removed listing's last date can expire. Without an observation timestamp, use a fixed employment-type cap anchored to the known publication/first-seen date. If no publication, first-seen, observation, or persisted deadline exists, use the same cap from the build clock as `build-clock-fallback`; this is a coverage fallback, not source evidence. Keep the source `datePosted` unchanged for old listings still observed live.
- **`responsibilities` / `qualifications`**: only text of the same listing. A crawler must cut its body where other offers start (PEMSA: `cutPemsaRelatedOffers`, by offer id).
- **`description`**: Use locale fallback chain (locale -> Italian -> raw description); when the result is thinner than 30 chars the static page synthesizes a description from the structured fields (title, company, city, contract) — the schema is never skipped. Only the SPA runtime path, which cannot synthesize it, skips its own copy and keeps the static one.

### Observer
`scripts/validate-jobs-rich-results-sample.mjs` (`npm run validate:jobs-rich-results`) compares emitted address and deadline values with the same provenance resolvers used by the builder. Missing street/deadline, stale internal provenance, and city-centre placeholders fail; each field must cover every eligible locale in the active snapshot. `scripts/measure-jobposting-eligibility.mjs` prints field coverage and source-level distributions before/after on one snapshot and exits non-zero if either field loses coverage.

### Applies to all page types:
- Active job pages (all 4 locales) — validated by `validate-jobs-rich-results-sample.mjs`
- Expired job soft-landing pages — same rules apply: no generated defaults
- Bridge pages (non-IT locale redirects, `__BRIDGE_TARGET_SLUG__`) — treated as warnings, not errors

### SPA runtime schema (JobBoard.tsx):
- The `JobBoard` component dynamically injects `JobPosting` JSON-LD via `useEffect`
- Same rules apply: description fallback chain and the shared address/deadline enrichment. Contract type still reads the raw `contract`/`employmentType`/`contractType`, never the `'full-time'`-defaulting filter bucket of `normalizeJobContract`.
- Jobs with description < 30 chars are excluded from the SPA's own schema graph, and the static JobPosting is then preserved (never removed)

The validation script `scripts/validate-jobs-rich-results-sample.mjs` (`npm run validate:jobs-rich-results`) audits a dist against `data/jobs.json`: every active job/locale must carry JobPosting, its `datePosted` must match the provenance chain, and mandatory fields must retain coverage. The deploy-blocking gates are the coverage gates above. **Do not weaken them. `employmentType` is an error, not a warning.**

The validation script `scripts/validate-jobs-rich-results-sample.mjs` enforces this. **Do not weaken it: missing required fields, malformed values, or an address/deadline that disagrees with its recorded provenance are errors, not warnings.**

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
