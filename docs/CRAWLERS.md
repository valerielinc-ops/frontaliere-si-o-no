# Job Crawlers — Detailed Reference

> This file is referenced from CLAUDE.md. Read on-demand when working on crawlers, translation, or job data.

## Architecture

- **581 dedicated crawlers**, one per company
- Each has: script (`scripts/update-{slug}-jobs.mjs`), parser (`scripts/lib/{slug}-job-parser.mjs`), and a manifest entry in `data/crawler-manifest.json` (workflow steps — see "Crawler-Group Workflows (2026-07 consolidation)" below)
- Shared infrastructure in `scripts/lib/dedicated-crawler-common.mjs` (~2000 lines)
- ATS-specific clients (Workday, Greenhouse, Lever, SuccessFactors) extracted in `scripts/lib/ats-clients/`
- AI translation via `scripts/lib/ai-models.mjs` with Firestore-backed scoring, 429 tracking, and multi-model fallback chain

## Crawler-Group Workflows (2026-07 consolidation)

Each crawler no longer has its own `.github/workflows/update-jobs-{slug}.yml`.
That 1:1 model (581 individual `workflow_dispatch`-only workflows) meant every
dispatched crawler run held one of GitHub Free tier's 20 concurrent-job slots
for its full duration (mean ~27min, up to ~160min for Coop) — starving other
CI (PR tests, the review-loop) of runner capacity during the ~1160
dispatches/day the orchestrator fired.

**New model**: the 581 crawlers are packed into **23 grouped workflows**
(`.github/workflows/crawler-group-01.yml` … `crawler-group-23.yml`), generated
by `scripts/generate-crawler-group-workflows.mjs`. Each group is a **single
job** that:

1. Runs shared setup once (checkout, `npm ci`, Playwright install if any
   member needs it, Firebase credentials, Remote Config secrets).
2. Runs every member crawler as a `background: true` step — GitHub Actions'
   parallel-steps feature, where a `run:` step marked `background: true`
   starts and returns immediately, letting the job move on to start the next
   background step. All of a group's crawlers therefore run **concurrently**,
   but the whole job still occupies only **ONE** concurrent-job slot no
   matter how many crawlers are inside it (this is the entire point — NOT a
   matrix strategy, which would cost one slot per matrix entry).
3. A final standalone `wait-all: true` step blocks until every background
   step finishes; a failed background step fails the job.

Each crawler's own `run:` step, housekeeping step, and commit-and-push /
error-reporting step are **inlined verbatim** into that crawler's single
background step as one shell script (GitHub's `background: true` applies to
one self-contained `run:` step, not a group of steps) — by design by the
consolidation, no shared/generic commit or error-reporting step was
introduced; every crawler still commits and reports failures via its own
unchanged mechanism (`scripts/lib/git-commit-data.sh`,
`scripts/lib/github-issue-creator.mjs`), it's just now one step instead of
its own workflow run. The housekeeping and commit-and-push steps only run if
the crawler's own run step succeeded (mirroring GitHub Actions' default
step-halt-on-failure semantics from the original individual workflows); the
failure-report step only runs if it didn't.

**Two concurrency hazards this introduced, both fixed at the generated-YAML
callsite** (not in the shared libraries, which stay correct for any future
single-crawler-per-job usage):

- `scripts/lib/slug-history-journal.mjs`'s telemetry file
  (`/tmp/slug-history-summary-${pid}.txt` by default) and
  `scripts/lib/git-commit-data.sh`'s "pick the globally-newest matching file"
  fallback would let one crawler's commit step steal + delete a sibling's
  telemetry when several crawlers share one job's `/tmp`. Fix: every
  generated background step sets
  `SLUG_HISTORY_SUMMARY_FILE=/tmp/slug-history-summary-<slug>.txt` (unique
  per crawler).
- `git-commit-data.sh`'s `git add`/`git commit` run directly against the
  shared working-copy `.git/index` with no locking — safe when each crawler
  is its own runner/clone, unsafe when several background steps share one
  job's working directory. Fix: each crawler's commit-and-push invocation is
  wrapped in `flock /tmp/crawler-group-git.lock -c '...'`, serializing only
  the few-second commit moment (not the crawl itself) across siblings.

**Bin-packing**: a group's wall-clock is bounded by its **slowest** member
(concurrent, not summed), so `scripts/generate-crawler-group-workflows.mjs`
isolates genuine duration outliers (e.g. Coop, ~160min, far above the corpus
median) into their own singleton group, then spreads the rest evenly across
the remaining groups (anchor the longest items one per group, then balance
the long tail by member count) so no group's bottleneck — or background-step
count — is worse than necessary. Duration data comes from
`data/crawler-workflow-duration-baseline.json` (historical averages from the
GitHub Actions runs API; new/never-dispatched crawlers fall back to the
corpus median).

**Adding/removing a crawler**: `node scripts/scaffold-crawler.mjs {key}`
still generates the parser/runner/test files, but now upserts a manifest
entry into `data/crawler-manifest.json` instead of writing a standalone
workflow file. Run `node scripts/generate-crawler-group-workflows.mjs`
afterwards to regenerate all 23 group workflows with the new crawler folded
in. The generator is deterministic given the same manifest + duration
baseline.

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

`orchestrate-crawlers.yml` dispatches all 23 `crawler-group-*.yml` workflows
(runs twice daily, cron `0 9,21 * * *`), each firing all its member crawlers'
background steps concurrently within its own job. Dispatching 23 targets
takes seconds, so the flat per-dispatch delay (default 20s, configurable via
the `delay_seconds` workflow_dispatch input) exists only as light headroom
against GitHub API rate limits / runner contention — the old per-crawler
volume-based stagger (582 individual dispatches, tiered 20s/60s/120s delays)
is no longer needed at this granularity.

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
