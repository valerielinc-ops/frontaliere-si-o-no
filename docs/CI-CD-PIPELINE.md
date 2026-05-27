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

### Phase 2 additions — 11 marquee crawler workflows

Daily crawler workflows (cron staggered 07:00–09:00 UTC, classified `Medium` by orchestrator):

| Workflow | Vertical | Canton focus |
|---|---|---|
| `update-jobs-roche.yml` | Pharma | BS |
| `update-jobs-novartis.yml` | Pharma | BS |
| `update-jobs-zurich-insurance.yml` | Finance | ZH |
| `update-jobs-nestle.yml` | Food | VD |
| `update-jobs-schindler.yml` | Industrial | LU |
| `update-jobs-migros-hq.yml` | Retail | ZH |
| `update-jobs-swiss-re.yml` | Insurance | ZH |
| `update-jobs-eth-zurich.yml` | Academic | ZH |
| `update-jobs-epfl.yml` | Academic | VD |
| `update-jobs-chuv.yml` | Hospital | VD |
| `update-jobs-inselspital.yml` | Hospital | BE |

### Concurrency impact

Phase 2 adds **~12 daily workflow runs** to the GitHub Actions concurrency budget:
- 11 new marquee crawlers
- 1 `crawler-health-monitor`
- (`brand-monitor` already counted from Phase 1)

Combined with the existing ~103 crawlers, orchestration delays (Large 120 s / Medium 60 s / Small 20 s) keep peak concurrency below the free-tier 20-runner cap. If GH Actions queue depth grows during the 08:00 / 20:00 UTC bursts, increase the orchestrator's Medium-tier delay to 90 s before paying for hosted runners (see CLAUDE.md zero-cost rule).

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

### Stage 3 — Individual Crawlers (`update-jobs-{slug}.yml` ×114)

> Was ×103 pre-cathedral; +11 marquee crawlers shipped 2026-05-10 (Phase 2). See the [Cathedral CH-wide expansion](#cathedral-ch-wide-expansion-2026-05-10) section above for the full list.

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
