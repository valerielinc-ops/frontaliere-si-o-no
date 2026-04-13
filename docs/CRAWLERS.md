# Job Crawlers — Detailed Reference

> This file is referenced from CLAUDE.md. Read on-demand when working on crawlers, translation, or job data.

## Architecture

- **103 dedicated crawlers**, one per company
- Each has: workflow (`update-jobs-{slug}.yml`), script (`scripts/update-{slug}-jobs.mjs`), parser (`scripts/lib/{slug}-job-parser.mjs`)
- Shared infrastructure in `scripts/lib/dedicated-crawler-common.mjs` (~2000 lines)
- AI translation via `scripts/lib/ai-models.mjs` with Firestore-backed scoring, 429 tracking, and multi-model fallback chain

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
| `data/jobs/expired/by-crawler/{slug}.json` | Cleanup + crawlers | Expired jobs for SEO soft-landings |
| `data/jobs.json` + `public/data/jobs.json` | Assemble step (translate-pending + deploy) | Monolithic global dataset |
| `data/translation-cache/{slug}.json` | Crawlers + translate-pending | SHA256-keyed AI translation cache (~90% hit rate) |
| `data/slug-registry.json` | Assemble step | Fingerprint -> slug mapping for canonical URLs (immutable once written) |
| `data/jobs-crawler-config.json` | Assemble step | Crawler configuration registry |

## Slug Lifecycle & SEO Continuity

When a job's slug changes (via relocalize or hardenJobLocaleFields), the old slug is preserved in `previousSlugs[]` on the job object. The build plugin (`jobsSeoPagesPlugin`) uses `previousSlugs` to generate **bridge pages** (canonical redirect pages) so old indexed URLs don't 404.

When a job is **deleted**, the expired entry captures `slugByLocale` + `previousSlugs`. The build plugin indexes both current + previous slugs from expired entries in `expiredBySlug`, ensuring all old URLs get **enriched soft-landing pages** (title, company, salary visible) rather than generic 404 pages.
