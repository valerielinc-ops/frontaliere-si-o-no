# Job Crawlers — Detailed Reference

> This file is referenced from CLAUDE.md. Read on-demand when working on crawlers, translation, or job data.

## Architecture

- **581 dedicated crawlers**, one per company
- Each has: script (`scripts/update-{slug}-jobs.mjs`), parser (`scripts/lib/{slug}-job-parser.mjs`)
- Shared infrastructure in `scripts/lib/dedicated-crawler-common.mjs` (~2000 lines)
- ATS-specific clients (Workday, Greenhouse, Lever, SuccessFactors) extracted in `scripts/lib/ats-clients/`
- AI translation via `scripts/lib/ai-models.mjs` with Firestore-backed scoring, 429 tracking, and multi-model fallback chain

## Consolidated CI Workflows (2026-07)

Crawlers no longer have their own `.github/workflows/update-jobs-{slug}.yml` file. Every dispatched individual workflow used to hold a full GitHub Free-tier concurrent-job slot (20 max) for its **entire run duration** (mean ~27min, up to ~3h for Coop) — ~1160 dispatches/day across the (then) 581 workflows starved all other CI (PR tests, `pr-review-loop`) of runner slots.

**Fix**: 581 individual workflows → **23 `.github/workflows/crawler-group-{01..23}.yml` workflows**. Each group runs its member crawlers as GitHub Actions "parallel steps": every crawler is a `background: true` step inside ONE job, with a final `wait-all: true` step rejoining them. A `background: true` step starts and returns immediately; the job only holds its GitHub Actions concurrent-job slot once, no matter how many crawlers run inside it — a `matrix:` strategy would NOT achieve this (matrix = one job per entry = still one slot per entry).

**Pipeline**:
- `scripts/extract-crawler-manifest.mjs` — parses every crawler's own bespoke steps (install, optional Playwright, Firebase prep, RC-secrets load, run-crawler, scoped housekeeping, commit+push, report-failure) into `data/crawler-manifest.json`. Real inspection of the pre-consolidation corpus found meaningful per-crawler variance beyond commit-message text (some crawlers pass an extra `data/jobs-crawler-adapters/` path to `git-commit-data.sh`, 10 use `npm ci --ignore-scripts`, some need Playwright + `xvfb-run`, step names differ, 2/581 lack a housekeeping step) — the manifest preserves every crawler's own steps VERBATIM rather than reconstructing them from a generic template.
- `scripts/fetch-crawler-workflow-durations.mjs` — pulls recent successful-run durations per crawler via the GitHub API, writes `data/crawler-workflow-duration-baseline.json` (workflow-file → avg-duration-ms). Re-runnable; falls back to the corpus median for any crawler with no run history.
- `scripts/generate-crawler-group-workflows.mjs` — the generator. Bin-packs crawlers into 23 groups via the repo's existing LPT (longest-processing-time) bin-packer (`scripts/ci/lpt-shard.mjs`, already used to balance vitest shards), using MAX (not sum) duration per group since background steps run concurrently. Extreme outliers (Coop, ~3h) are isolated into their own dedicated group first so they don't dominate an otherwise-balanced group. For each crawler, its extracted bespoke steps are collapsed into ONE composite shell script — GitHub Actions' `background: true` applies to a single `run:` block, not a multi-step sub-job — with subshell isolation per sub-step (so an internal `exit 0`, e.g. the real "no Firebase secret → skip" branch, only ends that sub-step, not the whole crawler) and `$GITHUB_ENV` writes re-sourced between sub-steps to replicate cross-step env propagation.
- Output: `.github/workflows/crawler-group-01.yml` .. `crawler-group-23.yml`. Regenerate after adding/removing/renaming a crawler: `node scripts/extract-crawler-manifest.mjs && node scripts/generate-crawler-group-workflows.mjs` (deterministic given the same manifest + duration baseline).

**Critical invariant preserved**: each crawler's commit-and-push and error-reporting mechanism is UNCHANGED — no shared/generic commit or error-reporting step was introduced. Every crawler still commits and reports errors via its own extracted steps, just co-located in one job instead of its own workflow run.

**slug-history-journal collision fix**: `scripts/lib/slug-history-journal.mjs`'s `defaultSummaryPath()` writes per-run telemetry to `SLUG_HISTORY_SUMMARY_FILE || /tmp/slug-history-summary-${pid}.txt`; the consumer `scripts/lib/git-commit-data.sh` falls back to `ls -t /tmp/slug-history-summary-*.txt | head -1` (globally-newest file, no crawler-name binding) when the env var is unset. With many crawlers as concurrent background steps sharing one job's `/tmp`, a crawler's commit step could steal + delete a sibling's telemetry file. Fix: every crawler's composite step sets `SLUG_HISTORY_SUMMARY_FILE=/tmp/slug-history-summary-{crawlerSlug}.txt` (unique per crawler name) at the generated-YAML level — `slug-history-journal.mjs`/`git-commit-data.sh` themselves are untouched (their PID-based default + glob fallback remain correct for any future single-crawler-per-job usage, e.g. manual local dispatch).

**Adding a new crawler**: `node scripts/scaffold-crawler.mjs {slug} ...` no longer generates a standalone workflow file. It writes the parser/runner/test files as before, then appends a manifest entry to `data/crawler-manifest.json` (via `scripts/lib/crawler-manifest-entry.mjs`, the same step-shape builder used so the manifest format can't drift between the bulk extractor and the scaffolder) and re-runs the group generator automatically, folding the new crawler into whichever group is currently least loaded.

**Orchestrator**: `orchestrate-crawlers.yml` discovers `.github/workflows/crawler-group-*.yml` (not `update-jobs-*.yml`) and dispatches all 23 with a flat delay (default 20s) between dispatches — the old volume-tiered staggering (Large/Medium/Small) existed to avoid overwhelming the 20-concurrent-slot cap with ~580 individual dispatches; with only 23 targets (each holding one slot) it's no longer needed.

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

`orchestrate-crawlers.yml` dispatches all 23 `crawler-group-*.yml` workflows (see "Consolidated CI Workflows" above) with a flat delay (default 20s) between dispatches — see that section for why the old per-crawler volume-based staggering (Large/Medium/Small) is no longer needed.

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
