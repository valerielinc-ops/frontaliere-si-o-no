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

## Anti-Shrink Guard — Refusal and Evidence-Based Acceptance

`writeJobsCrawlerSlice()` refuses to persist a slice that shrinks abnormally
(`shouldBlockShrink()` in `scripts/assemble-jobs-dataset.mjs`): below 40% of a
20+ baseline, below 20% under that baseline, or any total wipeout. It keeps the
prior slice on disk, files a `parser-health` issue and throws.

That refusal has a counterpart, because a source can also shrink **for real**.
Without one, an employer that closes most of its vacancies bricks its crawler:
every run trips the guard, throws, fails the workflow step (the crawler-group
workflow runs housekeeping and commit only when the crawl step **succeeded**)
and freezes the slice holding jobs that no longer exist — the guard against
silent content *loss* starts causing silent content *rot*. Confirmed on
grace-la-margna (#5016/#5017): 14 winter-season postings expired, the source
listed 1, and 10 consecutive runs failed while 13 dead jobs stayed live.

**`writeJobsCrawlerSliceVerified(crawlerKey, jobs, options)`** is the async
entry point that resolves this. It behaves exactly like the sync function until
the guard trips; then it probes every job the write would drop at **its own
source URL** via `validateJobUrls()` (`scripts/lib/validate-job-url.mjs`) and
retries the write with the guard bypassed only if every one of them is provably
gone. The disappearing jobs are archived into
`data/jobs/expired/by-crawler/<key>.json` first, so their indexed URLs get the
enriched soft-landing page instead of a 404.

Two properties are load-bearing and must not be relaxed:

- **The threshold is untouched.** This is a proof requirement, not a lower
  ratio. Only `definitive` verdicts count as evidence — HTTP 404/410, redirect
  to a generic listing, an ATS "position closed" marker, an explicit
  "no longer available" phrase.
- **The validator is fail-open, so ambiguity blocks.** A timeout, 403/429, bot
  challenge, auth wall, network error, or a dropped job with no URL to probe
  all report "still alive" and the guard stands. A degraded or blocked source
  can therefore never masquerade as a legitimate shrink — which is precisely
  the case the guard exists to catch.

`runStandardCrawlerPipeline` already uses the verified write, so every
template-based crawler gets this by construction. A bespoke runner
(`update-grace-jobs.mjs`) opts in by calling it instead of
`writeJobsCrawlerSlice`. `SKIP_SHRINK_GUARD=1` remains the manual, human-only
override for a local re-run; it is not the automated path.

### Extraction completeness — catching a partial parse at the source

The shrink guard is a **relative** check (new count vs. prior slice). It cannot
catch a crawler that was partial from its very first run, nor a slice that
erodes gradually, and it reports the damage downstream, hours later, where a
broken parser and a legitimate expiry look identical.

The upstream check is `assertExtractionComplete()`
(`scripts/lib/extraction-completeness.mjs`). Many boards publish their own
total — `Job offers (14)` in a profile tab, `totalNumber` in an API payload,
`123 results` above a list. Where one exists, hold the extractor to it:
a selector that stops matching then fails **at extraction**, loudly, instead of
returning a fraction and exiting 0.

This matters because 106 of the 117 bespoke `update-*-jobs.mjs` crawlers
validate their extraction only by checking it is non-empty, and the shared
pipelines are no stricter (`crawler-template.mjs` soft-returns on zero
listings). `update-grace-jobs.mjs` is the reference adoption: it parses the
hotelcareer profile tab and reconciles before writing anything.

Two rules, mirroring the shrink guard's:

- **A missing declared total is a failure, not a free pass.** If the counter
  cannot be located, completeness is unverifiable — and a check that cannot
  check must not report success, or it becomes the thing it was added to
  prevent.
- **Over-extraction fails too.** Matching more than the source declares means
  the selector is picking up navigation or related-job links.

Per-crawler escape hatch (grace: `JOBS_GRACE_SKIP_COUNT_CHECK=1`) for the case
where the mismatch is understood; it never reports the run as verified.

## Slug Lifecycle & SEO Continuity

When a job's slug changes (via relocalize or hardenJobLocaleFields), the old slug is preserved in `previousSlugs[]` on the job object. The build plugin (`jobsSeoPagesPlugin`) uses `previousSlugs` to generate **bridge pages** (canonical redirect pages) so old indexed URLs don't 404.

When a job is **deleted**, the expired entry captures `slugByLocale` + `previousSlugs`. The build plugin indexes both current + previous slugs from expired entries in `expiredBySlug`, ensuring all old URLs get **enriched soft-landing pages** (title, company, salary visible) rather than generic 404 pages.

## Job-Content Plausibility — Is the Record a Job Ad at All?

Every check above asks whether a slice is *fresh*, *complete*, or *internally
consistent*. None of them asks the prior question: **is this record a job
advertisement in the first place?** Two defects found by hand on 2026-08-24
showed that gap is real and that nothing automated was watching it.

- **`hotel-international`** — a crawler promoted by the prospector — published
  5 of 5 "jobs" that were room promotions: *"Prenota SENZA carta di credito!"*,
  *"Offerta speciale 3 notti"*, *"Perché prenotare direttamente"*.
- **`schindler`** carried 11 records titled *"Manager für Cookie-
  Einwilligungen"* (and its `it`/`fr` translations) — the source site's cookie
  consent widget — attached to the description of a different, real role.

Both slices were fresh, non-empty, richly described and structurally valid, so
`crawler-health-monitor.yml`, `audit-parser-quality.mjs` and
`crawler-data-quality-audit.yml` all passed them.

**`scripts/lib/job-content-plausibility.mjs`** holds the recognizer;
**`scripts/audit-job-content-plausibility.mjs`** (`npm run
audit:job-content-plausibility`) runs it over `data/jobs/by-crawler/*.json` and
emits a shortlist. It reports at two levels: `job` for bad records inside an
otherwise healthy crawler (schindler, 13/91), and `crawler` when the crawler
itself appears pointed at a page that is not a job listing
(hotel-international, 5/5) — one finding instead of N, because the repair is
one thing, not N things.

Three properties are load-bearing, and each one is a measurement on the real
corpus rather than an intuition:

- **A positive signal never cancels a decisive rule.** *"Manager für Cookie-
  Einwilligungen"* contains "Manager", a role noun. If role vocabulary could
  outvote the consent-widget rule, the defect that motivated this audit would
  stay invisible.
- **The vocabulary is bound, never single-token.** `cookie` alone would reject
  a real "Category Manager Cookies"; `reservation` alone would reject
  "Reservation Agent"; `newsletter` alone would reject "Newsletter Manager".
  Every rule needs two co-occurring elements, or an imperative form ("Prenota…",
  "Buchen Sie…") that a job title never takes. `tests/job-content-plausibility.test.ts`
  pins these adjacent-but-real titles as explicit negatives.
- **Title↔description divergence corroborates, it never triggers.** 2,670 jobs
  (8.8% of the corpus, across 214 crawlers) have zero lexical overlap and are
  overwhelmingly legitimate. It would also have missed hotel-international
  entirely, where title and description agree perfectly — both wrong. Repeated
  titles inside one crawler were rejected as a signal for the same reason: 584
  cases, nearly all legitimate multi-location retail postings.

Measured on 2026-08-24: **30,320 jobs across 573 crawlers → 19 findings on 3
crawlers, no false positives.** The third was previously unknown —
`gemeinde-st-moritz`, whose 5 records all carried the sidebar heading *"Wichtige
Kontakte"* as title and the site's navigation menu as description, while their
URLs named real vacancies.

### The loop: weekly audit and one-command human reporting

`.github/workflows/crawler-content-plausibility-audit.yml` runs the
deterministic filter weekly (Monday 09:10 UTC), and starts the paid Claude job
**only when the shortlist is non-empty** — a clean corpus costs zero Claude
invocations. Claude confirms or discards each candidate and opens at most 3
issues, labelled `job-content-quality`. The `url` field is the strongest
oracle: an URL slug naming a real vacancy under a title that is something else
proves the parser is reading the title from the wrong node.

`scripts/report-crawler-content-error.mjs` closes the other half — the case
that actually happened, a human noticing a bad page while browsing:

```bash
node scripts/report-crawler-content-error.mjs schindler "titolo = widget cookie"
node scripts/report-crawler-content-error.mjs https://www.hotel-international.ch/it/offerte/... "sono offerte hotel"
```

It accepts a crawler key **or any job URL** (resolving the key from the
dataset), attaches whatever the deterministic detector independently finds on
that crawler, and files the issue through `scripts/lib/github-issue-creator.mjs`
so it dedups like every other automated reporter. From there it is the ordinary
autonomous loop — `issue-triage` → `issue-fix` → PR → `## LGTM` → auto-merge —
with no further human action.

**Routing is a deliberate choice, and it differs between the two entry points.**
Audit findings and default manual reports carry no routing label, so
`scripts/lib/classify-issue.mjs` classifies them `other` → `agent:fix-queued`,
drained one at a time by `followup-drainer`. `route: 'fix'` is documented there
as "the ONLY exception, proven safe for months", and an LLM confirmation is not
that case. A human who has seen the bad page with their own eyes can pass
`--urgent`, which adds `parser-broken` — enough on its own to classify the issue
`crawler` and route it to an immediate `agent:fix`.

When a report turns out to describe something the detector did **not** flag, the
fix is not finished at the parser: add the rule to
`scripts/lib/job-content-plausibility.mjs` and the case to
`tests/job-content-plausibility.test.ts`, so the class is covered next time. The
issue body says so explicitly.

**Repair the parser, never the data.** Deleting bad records from
`data/jobs/by-crawler/<key>.json` by hand accomplishes nothing — the next crawl
rewrites them identically.

## Aggregator-Sourced Crawlers — the Data Can Be Genuine and the Destination Still Wrong

Every gate above (structured-data validation, parser health, job-content
plausibility) asks whether a record is a real vacancy. None of them asks
*whose* site we send the visitor to. A dedicated crawler can source an
employer's postings — and its `url`/`applyUrl` — from a third-party job-board
aggregator (jobs.ch, jobup.ch, indeed, ...) instead of the employer's own
domain. The vacancy is genuine, every existing gate stays green, and we still
hand the click to a competing job board instead of the direct employer. Four
crawlers did this — `equans`, `cham-swiss-properties`, `city-pop`, `dic-sa` —
all built by hand in PR #3428 (2026-07-04), before the prospector existed —
see `docs/PROSPECTOR.md` for why the prospector's own crawler-synthesis
pipeline does not create these by construction.

**The shared domain list**: `scripts/lib/known-aggregator-domains.mjs` is the
single source of truth for which registrable domains are multi-employer
marketplaces rather than a rentable single-tenant ATS. The prospector's
`NON_PLATFORM_HOSTS` (`scripts/lib/prospector/config.mjs`) imports it, so a
board added here is excluded from the prospector's platform registry too —
adding it in only one place would leave the other creation path unguarded.

**The gate**: `tests/aggregator-sourced-crawler-gate.test.ts`
(`scripts/lib/aggregator-source-gate.mjs`) scans every `*-job-parser.mjs` for
an import of a registered aggregator-backed shared client — today
`jobs-ch-search-common.mjs` (jobs.ch/jobup.ch, whole file) and
`jobup-ch-feed-common.mjs` (jobup.ch "mask" feed — only its
`createJobupChFeedParser`/`fetchJobupDetailDescription` exports count; the
same file's `detectEmploymentTypeFromOccupation` is a generic percentage
classifier reused by non-jobup.ch parsers and must NOT trigger the gate) —
and fails unless the file declares one of three tags, checked against the
employer's own site:

| tag | means |
|---|---|
| `@outsourced-ats-confirmed: <evidence>` | checked — the employer has no independent direct listing, or explicitly delegates to this board |
| `@outsourced-ats-needs-migration: <evidence>` | checked — a direct or better-outsourced source DOES exist; open debt |
| `@outsourced-ats-needs-verification: <reason>` | not yet checked (e.g. the employer's site blocks automated fetches) |

All three satisfy the gate — disclosure is the requirement, not instant
perfection — but only `confirmed` closes the question, and it does not mean
"stuck on jobs.ch forever": of the four crawlers this surfaced, three ended up
migrated off jobs.ch/jobup.ch once a REAL BROWSER check found a better source.

**`equans` was `confirmed` and that was wrong** — the mistake is worth stating
plainly rather than quietly overwriting. The first pass read the career
page's "zwei Jobportalen" text with a static fetch and assumed it meant
jobs.ch/jobup.ch (matching the parser's pre-existing docblock claim) without
checking what the two portals actually were. A real browser found the page
instead embeds `https://ohws.prospective.ch/public/v1/careercenter/1004089/`
directly — Equans's own Prospective.ch tenant (122 live listings, apply links
routing to Equans's own SuccessFactors instance), not jobs.ch at all. Equans
is now migrated the same as the two below, via the shared
`prospective-ch-job-parser-common.mjs` factory already used by dozens of
other direct-employer crawlers in this fleet. **Lesson**: a static fetch
cannot see what a JS-rendered embed actually loads — it can misreport
`confirmed` just as easily as it misses a real source entirely (the
`needs-verification` case below). Treat a `confirmed` reached without a real
browser as unverified until one checks it, not as settled.

`city-pop` is `confirmed` for the opposite reason, and this one IS
solid — a real-browser check found no careers/jobs section anywhere on its
own site (both `/careers` and `/jobs` 404) — jobs.ch is its only discoverable
channel, not a bypassed alternative. `cham-swiss-properties` and `dic-sa` were
`needs-migration` — a real browser found each one's own site embedding/
linking a genuine direct source (a Dualoo portal at
`jobs.dualoo.com/portal/6j9quii0`, and a WordPress `job-offers` REST API at
`dic-ing.ch/wp-json/wp/v2/job-offers`, respectively) — and are now `confirmed`
under the migrated source: their `url`/`applyUrl` point at the employer's own
domain (or, for Dualoo, the employer's own single-tenant ATS portal — not a
multi-employer marketplace) instead of jobs.ch/jobup.ch. This is why a *test*
enforces the tag rather than a one-time review: the day someone repeats the
2026-07-04 shortcut — a new `*-job-parser.mjs` importing
`jobs-ch-search-common.mjs` with no tag — `npm test` fails immediately instead
of shipping another silent redirect to a competitor's board. A static fetch
cannot always answer the tag's question (bot protection, JS-only rendering) —
that failure mode is exactly what escalates a crawler from
`needs-verification` to a real-browser check, not a reason to leave it
unverified indefinitely.

The same gate covers `jobup-ch-feed-common.mjs`'s "mask" feed
(`jobup.ch/masks/{key}/list_{key}.asp?cmd=json`), a second, independently
built jobup.ch integration. `cnp`, `pole-sante-pays-enhaut` and
`fondation-soins-lausanne` all import it and are all `confirmed`: the first
two employers' own career pages embed the jobup.ch mask widget directly (same
shape as `equans`); the third's real direct source (a shared AVASAD portal)
is confirmed dead for automated fetches (403, including through a clean-IP
proxy — issue #4168), making jobup.ch its genuine current channel, not a
bypassed one.

An unmarked import is the one state the gate refuses. A tagged one is not
blocked, because the loop this repo runs cannot review every PR by hand —
the tag **is** the review, exactly like the promotion gate's rejection
reasons in `docs/PROSPECTOR.md`.
