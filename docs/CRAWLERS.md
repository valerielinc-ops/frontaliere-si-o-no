# Job Crawlers — Detailed Reference

> This file is referenced from CLAUDE.md. Read on-demand when working on crawlers, translation, or job data.

## Architecture

- **103 dedicated crawlers**, one per company
- Each has: workflow (`update-jobs-{slug}.yml`), script (`scripts/update-{slug}-jobs.mjs`), parser (`scripts/lib/{slug}-job-parser.mjs`)
- Shared infrastructure in `scripts/lib/dedicated-crawler-common.mjs` (~2000 lines)
- ATS-specific clients (Workday, Greenhouse, Lever, SuccessFactors) extracted in `scripts/lib/ats-clients/`
- AI translation via `scripts/lib/ai-models.mjs` with Firestore-backed scoring, 429 tracking, and multi-model fallback chain

## Cathedral CH-wide expansion (2026-05-10)

The crawler scope was expanded from a 3-canton focus (TI/GR/VS) to **all 26 Swiss cantons**. Master plan: [docs/CATHEDRAL-IMPLEMENTATION-PLAN.md](CATHEDRAL-IMPLEMENTATION-PLAN.md). Rollback runbook: [docs/CATHEDRAL-ROLLBACK.md](CATHEDRAL-ROLLBACK.md).

Key changes:

- **`TARGET_CANTONS` flipped from `['TI', 'GR', 'VS']` to all 26** (`Object.keys(SWISS_CANTONS)` in `scripts/lib/crawler-location-config.mjs`).
- **Canton-quorum gate** (`scripts/lib/canton-quorum-gate.mjs`): BFS-strict primary check → 2-of-3 quorum fallback (title + body + addressLocality) → keep-as-is for low-confidence (excluded from per-canton SEO landing). Liechtenstein blacklist + `addressCountry !== 'CH'` rejection built in.
- **Slug-registry frozen URL strategy (E9)**: `data/slug-registry.json` freezes fingerprint → slug mapping. Reclassification (e.g. TI→GR by quorum) preserves the original URL — never breaks indexed pages. Snapshot-and-restore is the rollback primitive (see `CATHEDRAL-ROLLBACK.md`).
- **URL architecture**: per-canton `/cerca-lavoro-{italian-canton-slug}/{job-slug}` (e.g. `/cerca-lavoro-zurigo/`, `/cerca-lavoro-ticino/`) plus aggregator `/cerca-lavoro-svizzera/`. Non-IT locales use anglicized ASCII slugs (E5). Slug table loaded from `data/canton-url-slugs.json` (26 cantons + `_AGGREGATE_` × 4 locales = 104 entries).
- **Multi-canton canonical (E8)**: when a job applies to multiple cantons, use a single canonical URL with `jobLocation[]` array — no slug duplication.
- **Per-canton sharding**: monolithic `data/jobs.json` is **deprecated** (E4) in favour of `data/jobs/by-canton/{XX}.json` shards. SPA fetches lazily via `services/jobsService.ts` (`fetchJobsForCanton`) with IDB cache + ETag. Default landing is referrer-aware (D11): `frontaliere*` query → TI; else `svizzera` aggregator.
- **Sitemap-index with per-canton shards**: `dist/sitemap-index.xml` references `dist/sitemap-jobs-{canton}.xml` per canton + the aggregator. Generator: `scripts/lib/sitemap-shard.mjs`.
- **ATS clients extracted**: `scripts/lib/ats-clients/{workday,greenhouse,lever,successfactors}.mjs` (E3). New SuccessFactors client added for CH-wide coverage. Hybrid API + Playwright fallback (D5).
- **Crawler health monitor** (`.github/workflows/crawler-health-monitor.yml`): per-crawler success-rate watchdog, auto-opens GitHub issue on regression (D6).
- **Pre-flip dry run** (D8, mandatory): `scripts/dry-run-target-cantons-flip.mjs` produces 3-bucket report (new slugs / previously-filtered / reclassified) before any TARGET_CANTONS flip.

## Slug Stability — Jaccard Token Similarity

**Never regenerate slugs unconditionally on every crawl run.** Minor title wording changes (e.g. "per la Ricerca" -> "di ricerca") must NOT produce a new slug, as this orphans the old indexed URL and creates an endless `previousSlugs` chain.

**The correct check** is `isSlugStable(existingSlug, newSlug)` exported from `dedicated-crawler-common.mjs`. It uses Jaccard token similarity (threshold 0.80) to distinguish minor wording from genuinely different roles:

- Tokenizes slug into meaningful words (filters stop words: IT/EN/DE/FR connectives)
- Computes `|intersection| / |union|` — >= 0.80 -> keep existing slug
- Fallback: if either slug has < 4 meaningful tokens, uses 4-token prefix match

**Why not 50-char prefix?** The prefix heuristic has two failure modes:
1. False negative: different roles that share a long common prefix get merged
2. False positive: em-dash vs hyphen variations or reordered words produce a new slug unnecessarily

Only **USI, SUPSI, LIS** had real ongoing slug churn. Other crawlers either fill-only or have their own guards. When auditing a new crawler, check whether it unconditionally regenerates slugs — it should use `isSlugStable()` instead.

## Translation Cache (SHA256)

- `data/translation-cache/{company-slug}.json` stores translated titles/descriptions
- Hash-based skip: if `SHA256(title|description)` matches cache and <30 days old, skip AI call
- ~90% cache hit rate after first run
- Jobs with `needsRetranslation: true` flag bypass cache and get priority

## Crawler Orchestration

`orchestrate-crawlers.yml` dispatches all 103 crawlers with volume-based staggering:
- Large (>50 jobs): 300s delay
- Medium (10-50 jobs): 60s delay
- Small (<10 jobs): 30s delay

## Key Data Files

| File/Directory | Written by | Purpose |
|---|---|---|
| `data/jobs/by-crawler/{slug}.json` | Individual crawlers + translate-pending | Per-crawler slice: active jobs |
| `data/jobs/by-canton/{XX}.json` | Assemble step | Per-canton shard (replaces monolithic `data/jobs.json` since cathedral 2026-05-10) |
| `data/jobs/expired/by-crawler/{slug}.json` | Cleanup + crawlers | Expired jobs for SEO soft-landings |
| `data/jobs.json` + `public/data/jobs.json` | Assemble step (legacy) | Deprecated monolithic dataset — kept for backward compat during cathedral migration |
| `data/canton-url-slugs.json` | Manual + cathedral generators | 26 cantons + `_AGGREGATE_` × 4 locales URL slug map |
| `data/translation-cache/{slug}.json` | Crawlers + translate-pending | SHA256-keyed AI translation cache (~90% hit rate) |
| `data/slug-registry.json` | Assemble step | Fingerprint -> slug mapping for canonical URLs (immutable / frozen URL strategy E9) |
| `data/jobs-crawler-config.json` | Assemble step | Crawler configuration registry |

## Slug Lifecycle & SEO Continuity

When a job's slug changes (via relocalize or hardenJobLocaleFields), the old slug is preserved in `previousSlugs[]` on the job object. The build plugin (`jobsSeoPagesPlugin`) uses `previousSlugs` to generate **bridge pages** (canonical redirect pages) so old indexed URLs don't 404.

When a job is **deleted**, the expired entry captures `slugByLocale` + `previousSlugs`. The build plugin indexes both current + previous slugs from expired entries in `expiredBySlug`, ensuring all old URLs get **enriched soft-landing pages** (title, company, salary visible) rather than generic 404 pages.
