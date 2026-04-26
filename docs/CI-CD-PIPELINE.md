# CI/CD Pipeline — Detailed Stage Documentation

> Extracted from CLAUDE.md to reduce context window usage. This is the authoritative reference for the 5-stage job crawler pipeline.

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

**Trigger**: Cron `0 8 * * *` + `0 20 * * *` (twice daily) + manual dispatch

**What it does**:
1. Discovers all `update-jobs-*.yml` workflows
2. Reads each crawler's jobs count to classify volume:
   - Large (>50 jobs): 120 s delay between dispatches
   - Medium (10–50): 60 s delay
   - Small (<10): 20 s delay
3. Dispatches each with `skip_ai_translation=1` flag (AI translation is deferred to translate-pending)
4. Coop Ticino is excluded — has its own dedicated cron at 06:00 UTC

After dispatching, **does not wait**. All crawlers run concurrently. `translate-pending` handles the "after all crawlers" step.

---

### Stage 3 — Individual Crawlers (`update-jobs-{slug}.yml` ×103)

**Trigger**: Dispatched by orchestrator (or manually)

**Each crawler does**:
1. Crawl company job portal (Playwright or API-based)
2. Extract jobs — **skips AI translation** (`skip_ai_translation=1`), marks jobs `needsRetranslation: true`
3. Write per-crawler slice: `data/jobs/by-crawler/{slug}.json`
4. Write translation cache: `data/translation-cache/{slug}.json`
5. Scoped housekeeping: URL-validates only this company's jobs
6. Commit and push with `git-commit-data.sh --slice-only` (uses `GITHUB_TOKEN`)

> **Important**: Commits with `GITHUB_TOKEN` do NOT trigger `deploy.yml` (GitHub anti-loop rule). Deploy is triggered only by `translate-pending` via `GITHUB_PAT`.

**Files written per crawler**:
- `data/jobs/by-crawler/{slug}.json` — active jobs (Italian only, EN/DE/FR pending)
- `data/jobs/expired/by-crawler/{slug}.json` — jobs that failed URL validation
- `data/jobs-crawler-summaries/by-crawler/{slug}.json` — metadata (count, timestamp)
- `data/translation-cache/{slug}.json` — SHA256-keyed AI translation cache

---

### Stage 4 — Translation (`translate-pending.yml`)

**Trigger**:
- `workflow_run` on `orchestrate-crawlers` completed
- Cron fallback: `0 12 * * *` (12:00 UTC) and `0 0 * * *` (00:00 UTC)
- Manual dispatch with `max_jobs` (default: 100) and `dry_run` inputs

**What it does**:
1. **Assemble dataset** (`assemble-jobs-dataset.mjs`): reads all per-crawler slices → merges (last-write-wins by `assembledAt`) → outputs `data/jobs.json` + `public/data/jobs.json`
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
| JobPosting rich results | `validate-jobs-rich-results-sample.mjs` | ALL mandatory JSON-LD fields present on sampled pages |
| Third-party secrets | `validate:third-party-secrets` | No API keys/tokens in source |
| Job data quality | `validate:jobs-quality` | Format + locale consistency |
| Sitemap links | `validate:sitemap-links` | All sitemap URLs exist in `dist/` |
| Soft-404 indicators | `validate-soft404.mjs` | No pages marked soft-404 |
| Canonical tags | `validate-canonical.mjs` | Correct canonical URLs |
| Content quality | `validate-content-quality.mjs` | No thin pages (<50 words) |
| Page SEO quality | `validate-page-seo-quality.mjs` | H1 tags, lang attribute, schema validity, meta viewport |

**Pipeline sequence**:
1. Assemble jobs dataset (final merge)
2. Global housekeeping (cross-crawler dedup + locale hardening)
3. All validation gates above
4. Fetch Amazon product data (continue-on-error)
5. `npm run build:prod` → Vite + all build plugins → ~16,000 static HTML files
6. Validate generated pages (JobPosting JSON-LD, sitemaps, canonicals, content)
7. Deploy to GitHub Pages (`https://frontaliereticino.ch`)
8. Post-deploy: Google Indexing API, IndexNow (Bing/Yandex), Google Search Console (all continue-on-error)
9. If article deploy: post to Facebook + LinkedIn

---

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

**How.** At the end of every run, the workflow self-dispatches the next via `workflow_dispatch` API using the `GITHUB_PAT` secret (same pattern as `scripts/lib/trigger-deploy.sh`). The shared concurrency group `article-generation` prevents overlap. The `7,37 * * * *` cron stays as a fallback safety net.

**Outcome matrix** (computed by step `decide_trigger`, dispatched by step `Self-trigger next run`):

| Outcome | Delay | Retry counter |
|---|---|---|
| `success` (committed + verified in dist) | 0s | reset to 0 |
| `no_changes` (no source / all duplicates) | 600s | reset to 0 |
| `rebase_failed` (push race deferred article) | 60s | reset to 0 |
| `verify_failed` / `generate_failed` / `build_failed` | 60s → 300s → 1800s | exponential, max 3 retries |
| `retry_exhausted` | n/a — no dispatch | cron resumes |

**Kill instructions.** Two options:

1. **Soft kill (per-run skip)**: clear the `GITHUB_PAT` repo secret. The script logs "skip, no token" and exits 0 — the cron schedule keeps the workflow alive.
2. **Hard kill (chain off)**: comment out the `Self-trigger next run` step in `.github/workflows/generate-article.yml` and push. Cron continues at 30-min intervals.

Source: `scripts/lib/trigger-self.sh`, tests at `tests/lib/trigger-self.test.ts`.
