# CI/CD Pipeline — Detailed Stage Documentation

> Extracted from CLAUDE.md to reduce context window usage. This is the authoritative reference for the 5-stage job crawler pipeline.

---

## Cathedral CH-wide expansion (2026-05-10)

> Cross-references: [docs/CATHEDRAL-IMPLEMENTATION-PLAN.md](CATHEDRAL-IMPLEMENTATION-PLAN.md) · [docs/CATHEDRAL-ROLLBACK.md](CATHEDRAL-ROLLBACK.md)

The CH-wide cathedral expansion (Phase 1 + Phase 2) widens the pipeline from a 3-canton (Ticino-centric) scope to all **26 Swiss cantons** plus Liechtenstein guard, and adds 11 marquee employer crawlers covering pharma, finance, retail, industrial, and hospital verticals.

### Pre-merge safety tag

| Artifact | Value |
|---|---|
| Safety tag (Phase 1 baseline) | `pre-cathedral-2026-05-10` |
| Slug-registry snapshot | `data/slug-registry.pre-cathedral.snapshot.json` |

Rollback is fully scripted — see [docs/CATHEDRAL-ROLLBACK.md](CATHEDRAL-ROLLBACK.md).

### Phase 1 additions (P1.x)

- **`TARGET_CANTONS` expanded from 3 → 26** (P1.6). All crawler classification, job-board canton filters, and SEO landing emitters now iterate the full 26-canton set. Liechtenstein remains a guarded exclusion (country-code gate, not a canton).
- **`canton-quorum-gate`** (P1.4) — SEO data integrity guard. Blocks deploy if any canton has < N quorum jobs after a refresh, preventing thin-content landings on under-populated cantons. Runs as a deploy.yml validation gate.
- **`crawler-health-monitor.yml`** (P1.19) — daily cron `30 6 * * *` (06:30 UTC). Reads each crawler's last-success timestamp + delta vs 7-day median count; if a crawler is silent > 48 h or jobs count drops > 50 % vs median, opens a GitHub issue (label `crawler-health`) with diagnostics. Auto-closes the issue on next healthy run.
- **`jobs-by-canton` sharding** (E4) — monolithic `data/jobs.json` is **deprecated** for runtime reads. The SPA's JobBoard now lazy-fetches `data/jobs/by-canton/{canton}.json` based on referrer/geo. The assembled `data/jobs.json` is still emitted for build-plugin consumption, but client-side bundles must NOT import it.
- **Sitemap shards** — `sitemap-index.xml` is the new entry point. Per-canton shards `sitemap-jobs-{italian-slug}.xml` (e.g. `sitemap-jobs-ticino.xml`, `sitemap-jobs-zurigo.xml`) replace the legacy monolithic `sitemap-jobs.xml`. The legacy URL is preserved as a 301 redirect for one quarter.

### Phase 2 additions — 11 marquee crawlers (historical, 2026-05-10)

> Slugs below are still crawled — as of the 2026-07 consolidation (see Stage 3) they run as `background: true` steps inside one of the 23 `crawler-group-{01..23}.yml` files rather than in their own dedicated `update-jobs-{slug}.yml` workflow. `grep -l "crawler-{slug}" .github/workflows/crawler-group-*.yml` finds which group any of them currently lives in.

| Crawler slug | Vertical | Canton focus |
|---|---|---|
| `roche` | Pharma | BS |
| `novartis` | Pharma | BS |
| `zurich-insurance` | Finance | ZH |
| `nestle` | Food | VD |
| `schindler` | Industrial | LU |
| `migros-hq` | Retail | ZH |
| `swiss-re` | Insurance | ZH |
| `eth-zurich` | Academic | ZH |
| `epfl` | Academic | VD |
| `chuv` | Hospital | VD |
| `inselspital` | Hospital | BE |

### Concurrency impact (superseded 2026-07 — see Stage 3)

Historically (pre-consolidation), every dispatched crawler held its own GitHub Free-tier concurrent-job slot for its full run duration, so the orchestrator staggered dispatches by estimated crawler volume (Large 120s / Medium 60s / Small 20s) to stay under the 20-runner cap. The 2026-07 consolidation into 23 `crawler-group-*.yml` workflows (each holding exactly ONE concurrent-job slot regardless of how many crawlers run inside it via `background: true` steps) made this volume-tiered staggering unnecessary — the orchestrator now uses a flat, short delay between its 23 dispatches (see Stage 2).

---

### Stage 1 — Cleanup (`cleanup-stale-jobs.yml`)

**Trigger**: Cron `0 6 * * *` (06:00 UTC daily, before orchestration)

**What it does** — iterates ALL `data/jobs/by-crawler/*.json` slices:
1. **Locale hardening** (`hardenJobLocaleFields`): repairs malformed slugs, removes stale hash suffixes, adds renamed slugs to `previousSlugs`
2. **Age pruning**: removes jobs with `crawledAt` older than 60 days
3. **URL validation**: HTTP-checks each job URL concurrently; removes definitive 404/410/gone jobs
4. **Dedup**: within each slice, keeps newest job when two jobs share the same slug
5. **Archive to expired**: removed jobs with unique slugs → `data/jobs/expired/by-crawler/{slug}.json` (for soft-landing pages). Archived entries include `slugByLocale` + `previousSlugs` for enriched soft-landings.
6. Commits with `git-commit-data.sh --slice-only`; does **NOT** trigger deploy

**Key behaviors**:
- Deduped-away jobs (slug still live in kept job) are NOT archived — correct, the URL is still active
- `hardenJobLocaleFields` may rename slugs during cleanup; old slugs go into `previousSlugs` of the surviving job
- Does not block if individual slices fail (continues with `|| true`)

---

### Stage 2 — Orchestration (`orchestrate-crawlers.yml`)

**Trigger**: Cron `0 9 * * *` + `0 21 * * *` (twice daily) + manual dispatch

**What it does**:
1. Discovers all `crawler-group-*.yml` workflows (23 files, see Stage 3 below)
2. Dispatches each with `skip_ai_translation=1` flag (AI translation is deferred to translate-pending) and a short delay between dispatches (default 20s — only 23 targets, no volume-tiered staggering needed anymore)
3. Coop is folded into its own dedicated group (`crawler-group-01.yml`, historically the single slowest crawler at ~3h) rather than a standalone cron

After dispatching, **does not wait**. All 23 groups run concurrently, each holding exactly ONE GitHub Actions concurrent-job slot. `translate-pending` handles the "after all crawlers" step.

---

### Stage 3 — Crawler Groups (`crawler-group-{01..23}.yml`, 581 crawlers)

> **Consolidated 2026-07** from 581 individual `update-jobs-{slug}.yml` workflows into 23 grouped workflows. Each dispatched individual workflow used to hold a full GitHub Free-tier concurrent-job slot (20 max) for its ENTIRE run duration (mean ~27min, up to ~3h for Coop) — ~1160 dispatches/day starved all other CI (PR tests, review-loop) of runner slots. Each `crawler-group-NN.yml` runs its member crawlers as GitHub Actions "parallel steps" (`background: true` + `wait-all: true`) — many crawlers execute concurrently INSIDE ONE job, so the group holds a single concurrent-job slot no matter how many crawlers it contains. See `scripts/generate-crawler-group-workflows.mjs` (the generator, re-run after adding/removing a crawler) and `scripts/extract-crawler-manifest.mjs` (parses each crawler's own bespoke steps into `data/crawler-manifest.json`). Bin-packing balances the 23 groups by historical average duration (`data/crawler-workflow-duration-baseline.json`, refreshed via `scripts/fetch-crawler-workflow-durations.mjs`), isolating extreme outliers (Coop) into their own group.

**Trigger**: Dispatched by orchestrator (or manually) — dispatching a group runs ALL its member crawlers.

**Each crawler's own composite background step does** (byte-for-byte preserved from its former individual workflow — no shared/generic commit or error-reporting step was introduced):
1. Crawl company job portal (Playwright or API-based; some crawlers still install Playwright/`xvfb-run` as part of their own step)
2. Extract jobs — **skips AI translation** (`skip_ai_translation=1`), marks jobs `needsRetranslation: true`
3. Write per-crawler slice: `data/jobs/by-crawler/{slug}.json`
4. Write translation cache: `data/translation-cache/{slug}.json`
5. Scoped housekeeping: URL-validates only this company's jobs (`continue-on-error` — never fails the crawler)
6. Commit and push with `git-commit-data.sh --slice-only` (uses `GITHUB_TOKEN`) — each crawler's own commit message/extra-paths preserved verbatim
7. On failure: reports to GitHub Issues via its own `github-issue-creator.mjs` call, unchanged per crawler

Each crawler's composite step sets `SLUG_HISTORY_SUMMARY_FILE=/tmp/slug-history-summary-{slug}.txt` (unique per crawler name) so concurrent sibling crawlers sharing one job's `/tmp` cannot steal/delete each other's commit-message telemetry (`scripts/lib/slug-history-journal.mjs`'s PID-based default + `scripts/lib/git-commit-data.sh`'s newest-file glob fallback are correct for single-crawler-per-job usage, but would collide across concurrent background steps without this per-crawler override).

> **Important**: Commits with `GITHUB_TOKEN` do NOT trigger `deploy.yml` (GitHub anti-loop rule). Deploy is triggered only by `translate-pending` via `GITHUB_PAT`.

**Files written per crawler**:
- `data/jobs/by-crawler/{slug}.json` — active jobs (Italian only, EN/DE/FR pending)
- `data/jobs/expired/by-crawler/{slug}.json` — jobs that failed URL validation
- `data/jobs-crawler-summaries/by-crawler/{slug}.json` — metadata (count, timestamp)
- `data/translation-cache/{slug}.json` — SHA256-keyed AI translation cache

**Adding a new crawler**: `scripts/scaffold-crawler.mjs` no longer generates a standalone workflow file — it appends a manifest entry to `data/crawler-manifest.json` and re-runs the group generator automatically, folding the new crawler into its least-loaded group.

---

### Stage 4 — Translation (`translate-pending.yml`)

**Trigger**:
- `workflow_run` on `orchestrate-crawlers` completed
- Cron fallback: `0 12 * * *` (12:00 UTC) and `0 0 * * *` (00:00 UTC)
- Manual dispatch with `max_jobs` (default: 100) and `dry_run` inputs

**What it does**:
1. **Assemble dataset** (`assemble-jobs-dataset.mjs`): reads all per-crawler slices → merges (last-write-wins by `assembledAt`) → outputs `data/jobs.json` + `public/data/jobs.json` + per-canton shards `data/jobs/by-canton/{canton}.json` (E4 — the SPA reads the per-canton shards; monolithic `data/jobs.json` is build-plugin-only after cathedral 2026-05-10)
2. **Relocalize pending** (`relocalize-pending-jobs.mjs --max-jobs N`):
   - Finds all jobs with `needsRetranslation: true` or missing locale coverage
   - Runs shared crawler in `LOCALIZE_EXISTING_ONLY` mode (no crawling, translation only)
   - Uses centralized AI model chain (74 models, 10 providers, Firestore-backed scoring)
   - **Time budget**: 90-minute internal budget (workflow timeout: 120 min)
   - Syncs translated content back to per-crawler slices (`syncTranslationsToCrawlerFile`)
   - When overwriting `slugByLocale` for `needsRetranslation` jobs, preserves old slugs in `previousSlugs` to prevent URL orphaning
3. **Commit** with `git-commit-data.sh --slice-only "🌐 Auto-translate pending jobs"`
4. **Validate completeness** (`validate-translation-completeness.mjs`):
   - Checks every job has 4-locale coverage (title ≥ 3 chars, description ≥ 120 chars)
   - If any job incomplete: **skips deploy**, exits 0 — next cron run retries
5. **Trigger deploy** (only if validation passes): `bash scripts/lib/trigger-deploy.sh` using `GITHUB_PAT`

**Recovery**: If quota exhausted mid-run, validation fails, deploy is skipped. Next cron (12:00 or 00:00 UTC) retries automatically until all jobs are translated.

---

### Stage 5 — Deploy (`deploy.yml`)

**Trigger**: Push to `main` + `workflow_dispatch` (called by `trigger-deploy.sh` via `GITHUB_PAT`)

**Validation gates (all blocking — exit code 1 = deploy aborted)**:

| Gate | Script | What it checks |
|------|--------|----------------|
| Translation completeness | `validate-translation-completeness.mjs` | Every job has 4 locales with min content |
| Canton quorum (cathedral P1.4) | `validate-canton-quorum.mjs` | Every canton in `TARGET_CANTONS` (26) has ≥ N quorum jobs — blocks thin-content landings |
| JobPosting rich results | `validate-jobs-rich-results-sample.mjs` | ALL mandatory JSON-LD fields present on sampled pages |
| Third-party secrets | `validate:third-party-secrets` | No API keys/tokens in source |
| Job data quality | `validate:jobs-quality` | Format + locale consistency |
| Sitemap links | `validate:sitemap-links` | All sitemap URLs exist in `dist/` (validates `sitemap-index.xml` + per-canton shards `sitemap-jobs-{italian-slug}.xml` post-cathedral 2026-05-10) |
| Soft-404 indicators | `validate-soft404.mjs` | No pages marked soft-404 |
| Canonical tags | `validate-canonical.mjs` | Correct canonical URLs |
| Content quality | `validate-content-quality.mjs` | No thin pages (<50 words) |
| Page SEO quality | `validate-page-seo-quality.mjs` | H1 tags, lang attribute, schema validity, meta viewport |

**Pipeline sequence**:
1. Assemble jobs dataset (final merge)
2. Global housekeeping (cross-crawler dedup + locale hardening)
3. All validation gates above
4. `npm run build:prod` → Vite + all build plugins → ~16,000 static HTML files
5. Validate generated pages (JobPosting JSON-LD, sitemaps, canonicals, content)
6. Deploy to GitHub Pages (`https://frontaliereticino.ch`)
7. Post-deploy: Google Indexing API, IndexNow (Bing/Yandex), Google Search Console (all continue-on-error)
8. If article deploy: post to Facebook + LinkedIn

---

### PR review + auto-merge + follow-up triage (PR #769)

> Operational contracts live in `REVIEW.md` (review tiers, signal grammar, scope filter) and `FOLLOWUP.md` (follow-up issue contract). This section is just the workflow surface — do not duplicate contract content here.

| Workflow | Trigger | Role |
|---|---|---|
| `.github/workflows/pr-review-loop.yml` | `pull_request` (sync/open) | Tiered Claude review; emits structured `REVIEW.md` signals + `## LGTM` when green |
| `.github/workflows/auto-merge-on-lgtm.yml` | `pull_request_review` submitted by the review bot | Squash-merges the PR when the review body contains the literal `## LGTM` marker |
| `.github/workflows/post-merge-followup.yml` | `pull_request` `closed` + `merged == true` | Reads PR body `## Non implementato` + reviewer 🟡 / ❓ / adversarial bullets, applies the scope filter, dedups against open follow-up issues, files new issues (labels `follow-up` + `funnel-*`, cap 10/PR) and posts a summary comment on the merged PR |

**`pr-review-loop.yml` — tiered review (PR #769)**

- `Determine review tier` step inspects the PR's changed paths and computes `model` + `max_turns` dynamically. **The exact model/turn values + path patterns live in the workflow step `Determine review tier` (`.github/workflows/pr-review-loop.yml`) — do not hard-code numbers here, they drift** (this doc said Opus/`max_turns: 25` long after the workflow moved to 40):
  - **high tier** — Opus, runs the adversarial-check sweep. Triggered by funnel-critical CODE: `tests/`, `.github/workflows/`, `build-plugins/`, or index-mutating `scripts/`. Non-funnel helper scripts (`scripts/{ci,dev,evals}/`) and read-only audit/report scripts stay **normal**. DATA/docs-only diffs (`data/**`, `public/**`, `reports/**`, `docs/**`) never escalate the tier.
  - **normal tier** — everything else. Sonnet.
- Tool whitelist widened to include `Bash(rg:*)` and `Bash(git:*)` so the reviewer can do cross-file pattern probing (`REVIEW.md` step 5) and PR-history checks.
- Test plan compliance is enforced by `REVIEW.md` step 6 — the reviewer cross-checks the PR body's test plan against the diff.
- Green output ends with the literal `## LGTM` marker; that is the single signal `auto-merge-on-lgtm.yml` watches for. See `REVIEW.md` for what scenarios are allowed to emit `## LGTM`.

**`post-merge-followup.yml` — scope-filtered follow-up issues (PR #769)**

- Runs only on merged PRs (`pull_request.closed && merged == true`).
- Parses two sources: the PR description's `## Non implementato` block (author-declared deferred work) and the reviewer's 🟡 / ❓ / adversarial bullets from the latest `pr-review-loop` review.
- Applies the `REVIEW.md` scope filter (monetization / traffic / SEO funnel impact); cosmetic or out-of-scope bullets are dropped.
- Dedups candidates against currently open issues labelled `follow-up` before opening anything new.
- Creates at most **10 issues per merged PR**, all labelled `follow-up` plus the relevant `funnel-*` label, and posts a summary comment back on the merged PR linking each new issue.
- Issue body contract (titles, sections, linkbacks) is defined in `FOLLOWUP.md`.

**`auto-merge-on-lgtm.yml`**

- Fires on **two** triggers: `pull_request_review` (the Claude review bot just posted) **and** `workflow_run` of the `tests` workflow `completed` (vitest just finished). Either ordering is covered.
- The merge decision is centralized in `scripts/ci/auto-merge-eval.mjs` (single source of truth, identical gates for both triggers). It squash-merges PR `N` **only when ALL hold**: PR open + not draft; the latest claude-bot review on the **current head** contains `## LGTM` and **not** `🔴 Important`; the `vitest (unit + integration)` check-run on the head is `success` (**not** merely `!= failure` — pending/missing does **not** merge); and the P3 collision gate passes. Merge mechanism unchanged (PAT primary for the deploy/follow-up cascade, `GITHUB_TOKEN` fallback). See `REVIEW.md` for which outcomes emit `## LGTM`.
- **Why two triggers + require-success:** previously the gate only blocked on vitest `conclusion == failure`; a pending/missing vitest **proceeded** → a PR could merge before its tests finished, and if they went red, main went red (`#1454`: merged on LGTM while vitest was still running → vitest failed → main red cascade). On `pull_request_review` with vitest not yet `success`, the job exits 0 quietly; the `tests` completion re-evaluates.

### Pipeline hardening — auto-rebase, collision detector, bounded 🔴 fixer

Three deterministic (zero-Claude) helpers + one bounded Claude fixer close the gaps around near-merge PRs. **Labels used:** `collision-risk` (P1 gate input), `needs-human` (P4 escalation), plus the existing `stale-review`. Create them once if missing: `gh label create collision-risk` / `gh label create needs-human` (idempotent, `|| true`).

| Workflow | Trigger | Role |
|---|---|---|
| `.github/workflows/pr-autorebase.yml` | `schedule` `*/30` + dispatch | `scripts/ci/pr-autorebase.mjs`: actually runs `git merge origin/main` + push (PAT) for **near-merge** PRs behind main, so review + vitest re-run. **Frugality gate:** only PRs that already have a `## LGTM` review or carry `collision-risk`/`stale-review` (a rebase push re-triggers the Claude reviewer = quota). `MERGEABLE` only; `CONFLICTING` → abort + ensure `stale-review` + one dedup'd comment (`<!-- AUTOREBASE_CONFLICT -->`). Cap ~10 PR/run. |
| `.github/workflows/pr-collision-detector.yml` | `pull_request` (open/sync/reopen) + `schedule` `*/30` + dispatch | `scripts/ci/pr-collision-detector.mjs`: labels `collision-risk` on **both** PRs of any open pair sharing ≥1 funnel-critical file (globs: `scripts/lib/**`, `build-plugins/**`, `services/seoService.ts`, `services/seo/**`, `.github/workflows/**`, `scripts/update-*.mjs`), one dedup'd comment per PR (`<!-- COLLISION:<other> -->`). Recomputed every run — removes the label when a PR no longer collides. This feeds P1's collision gate: the second-to-merge must rebase past the first. Root cause of the `#1454`↔`#1459` main-red. |
| `.github/workflows/pr-redflag-fixer.yml` | `pull_request_review` submitted | When the reviewer posts a `🔴` on an **autonomous** PR (author Bot **or** head `fix/*` — never human PRs), Claude applies a class-complete fix on the same branch, runs tests, commits (canonical identity) + pushes (PAT re-triggers re-review). **Anti-loop:** a hidden `<!-- REDFLAG_FIX_ROUND: N -->` marker counts rounds; at `N>=2` → label `needs-human` + escalation comment, **STOP without Claude**. Capability guard: PR touching `.github/workflows/**` without a PAT → skip (push would be rejected). Tier: opus if funnel-critical (`tests/`, `build-plugins/`, `scripts/lib/`, `services/seo*`) else sonnet. Auth via `CLAUDE_CODE_OAUTH_TOKEN`. |

### GITHUB_TOKEN Limitation

Pushes made with the default `GITHUB_TOKEN` **do not trigger other workflows** (GitHub anti-loop rule). Only `translate-pending` and `article-generation` trigger deploy — they use `GITHUB_PAT` (from Firebase Remote Config) via `scripts/lib/trigger-deploy.sh`.

If `GITHUB_PAT` is missing, deploy is skipped gracefully. Admin can always trigger manually via `workflow_dispatch`.

### GitHub Actions Step Timeout — Critical Gotcha

**Never use `timeout-minutes` at the step level on steps that must be followed by cleanup/commit steps.**

When a step is killed by a step-level timeout, GitHub Actions marks it as `failure`. Subsequent steps with `if: always()` are NOT executed — `always()` only overrides `failure` from the workflow context, not from a step that was killed by its own timeout.

**Correct pattern**: Set `timeout-minutes` at the **job** level only. Use an internal time budget (e.g. `TIME_BUDGET_MS`) in the script itself to stop gracefully before the job timeout, leaving room for commit/deploy steps to run.

```yaml
jobs:
  translate:
    timeout-minutes: 350   # ← job-level only
    steps:
      - name: Translate pending jobs
        # NO timeout-minutes here
        run: node scripts/relocalize-pending-jobs.mjs  # script stops at 320min internally
      - name: Commit and push
        if: always()   # ← this works correctly with job-level timeout
        run: bash scripts/lib/git-commit-data.sh ...
```

### AI Provider Retry-After Headers

Some AI providers return extreme `Retry-After` values (e.g. Cerebras: `Retry-After: 86399` = 24h). Without a cap, the entire translate-pending pipeline freezes for a full day, causing a massive translation backlog.

**Rule**: Always cap `Retry-After` header values to a maximum of **2 minutes** (`MAX_RETRY_AFTER_MS = 2 * 60 * 1000`) in `scripts/lib/ai-models.mjs`. The model fallback chain will naturally move to the next available provider.

## Article generation self-trigger chain

**Why.** `generate-article.yml` runs every 30 min via cron, but GitHub Actions silently skips ~66% of cron slots (measured 34% utilization over 5 days; avg gap 88 min vs 30 expected). At ~22 min real generation time per article, the theoretical max is 65/day; we were getting ~16/day.

**How.** At the end of every run, the workflow self-dispatches the next via `workflow_dispatch` API using the `GITHUB_PAT` env var (loaded into `$GITHUB_ENV` by `scripts/load-rc-env.mjs` from Firebase Remote Config — **NOT** an Actions secret). The `Self-trigger next run` step inherits this env; do **not** add `GITHUB_PAT: ${{ secrets.GITHUB_PAT }}` to its env block — `secrets.GITHUB_PAT` resolves to empty and shadows the RC value. Same pattern as `scripts/lib/trigger-deploy.sh`. The shared concurrency group `article-generation` prevents overlap. The `7,37 * * * *` cron stays as a fallback safety net.

**Outcome matrix** (computed by step `decide_trigger`, dispatched by step `Self-trigger next run`):

| Outcome | Delay | Retry counter |
|---|---|---|
| `success` (committed + verified in dist) | 0s | reset to 0 |
| `no_changes` (no source / all duplicates) | 600s | reset to 0 |
| `rebase_failed` (push race deferred article) | 60s | reset to 0 |
| `verify_failed` / `generate_failed` / `build_failed` | 60s → 300s → 1800s | exponential, max 3 retries |
| `retry_exhausted` | n/a — no dispatch | cron resumes |

**Kill instructions.** Two options:

1. **Soft kill (per-run skip)**: clear the `GITHUB_PAT` parameter in Firebase Remote Config (the value source — there is no `GITHUB_PAT` Actions secret). The script logs "skip, no token" and exits 0 — the cron schedule keeps the workflow alive.
2. **Hard kill (chain off)**: comment out the `Self-trigger next run` step in `.github/workflows/generate-article.yml` and push. Cron continues at 30-min intervals.

Source: `scripts/lib/trigger-self.sh`, tests at `tests/lib/trigger-self.test.ts`.
