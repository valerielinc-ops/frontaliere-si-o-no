# Cathedral CH-Wide — Master Implementation Plan

**Branch**: `feat/cathedral-ch-wide`
**Safety tag**: `pre-cathedral-2026-05-10` (HEAD before changes: `58eb418c49`)
**Started**: 2026-05-10 by autonomous orchestrator
**CEO plan**: `~/.gstack/projects/valerielinc-ops-frontaliere-si-o-no/ceo-plans/20260510-ch-wide-crawlers-cathedral.md`
**Eng review test plan**: `~/.gstack/projects/valerielinc-ops-frontaliere-si-o-no/saggesel-main-eng-review-test-plan-20260510-100633.md`

## Decisions consolidated (CEO + Eng = 24 decisions)

| Code | Topic | Choice |
|---|---|---|
| D1 | Intent | SEO-first, brand intoccato |
| D2 | Path | Full Cathedral C' |
| D3 | Mode | HOLD SCOPE |
| D4 | Job-room.ch | EXCLUDED |
| D5 | ATS | Hybrid API + Playwright |
| D6 | Health monitor | Workflow + auto-issue |
| D7 | Canton gate | BFS-strict + 2-of-3 + keep-as-is |
| D8 | Slug dry-run | Mandatory pre-flip |
| D9 | SPA shard | Per-canton + lazy load |
| D10 | Staging | Z 1 mega-PR |
| D11 | Brand monitor | SKIP (deferred) |
| D12 | Marquee curation | Top + LinkedIn (deferred autonomous) + welches-spital |
| E1 | router.ts | In scope |
| E3 | ATS clients | Extractive + new SuccessFactors |
| E4 | Monolithic jobs.json | Deprecated |
| E5 | URL ASCII | Anglicized non-IT |
| E6 | Cathedral-flip E2E | Mandatory regression test |
| E8 | Multi-canton canonical | Single URL + jobLocation[] array |
| E9 | Reclassification | Slug-registry frozen URL pattern |
| E10 | LinkedIn | Discovery deferred autonomously, hand-curated for Phase 1 |
| E11 | Default landing | Referrer-aware (frontaliere → TI; else svizzera) |
| E12 | Test fixtures | FIRST commit (swap order) |

## Phase Breakdown

### PHASE 1 — Foundation (sequential, main worktree, ~15-20 tasks)

**P1.1 — Test fixtures parametrization (E12 swap)**
Files: ~80 test files in tests/
Action: Replace hardcoded `canton: 'TI'` / `'lugano'` references with parameterized fixtures that accept any canton from BFS data. Add helper `tests/__fixtures__/cantonFixture.ts` exporting `makeJobFixture({ canton: 'TI' })` and similar.
Done when: All ~80 test files compile and pass; existing TI tests still green.
Hooks bypass: skip `prepush` (we run it at gate). Run `vitest run --no-coverage` only on touched files for fast feedback.

**P1.2 — data/canton-url-slugs.json + loader**
Files: NEW `data/canton-url-slugs.json`, NEW `scripts/lib/canton-url-slugs.mjs`
Action: Create JSON with all 26 canton codes mapped to `{it, en, de, fr}` URL slugs (ASCII anglicized for non-IT, italian native for IT). Aggregate key `_AGGREGATE_` for `svizzera/switzerland/schweiz/suisse`. Loader exports `getCantonUrlSlug(code, locale)` and `parseCantonUrlSlug(slug, locale)` (reverse).
Done when: JSON validates schema, loader has unit test (P3.x).

**P1.3 — services/router.ts refactor**
Files: MODIFIED `services/router.ts`
Action:
- Replace per-locale literal `jobBoard: 'cerca-lavoro-ticino'` with table per-canton: 25 cantoni + svizzera × 4 locales = 104 entries (loaded from `data/canton-url-slugs.json`).
- Change `jobBoardCity` from literal-union to `string` (runtime check via `isKnownSwissMunicipality`).
- Add `parseJobBoardSlug(pathSegment, locale): { cantonCode | null, isAggregator }` to dispatch routing.
- Backward compat: `/cerca-lavoro-ticino/{slug}` continues to work for IT locale.
Done when: SPA navigation works for `/cerca-lavoro-ticino/`, `/cerca-lavoro-zurigo/`, `/cerca-lavoro-svizzera/`, `/find-jobs-zurich/`, `/jobs-in-zurich/`, `/trouver-emploi-zurich/`.

**P1.4 — scripts/lib/canton-quorum-gate.mjs (D7 + Liechtenstein blacklist)**
Files: NEW `scripts/lib/canton-quorum-gate.mjs`, MODIFIED `scripts/lib/target-swiss-locations.mjs`
Action:
- BFS-strict primary check: if `addressLocality` exact-matches BFS municipality → high confidence
- 2-of-3 quorum fallback: if title + body + addressLocality at least 2 agree on canton → high confidence
- keep-as-is: if neither, leave existing canton tag → low confidence (excluded from per-canton SEO landing)
- Liechtenstein blacklist: postcodes 9485-9498, "Schaan", "Vaduz", "Triesen", "Balzers" etc → REJECTED
- Country code check: addressCountry !== 'CH' → REJECTED
- Returns: `{ canton: 'TI'|...|null, confidence: 'high'|'low'|'reject' }`
Done when: unit tests cover 26 cantons happy path + 10 edge cases.

**P1.5 — scripts/dry-run-target-cantons-flip.mjs**
Files: NEW `scripts/dry-run-target-cantons-flip.mjs`
Action: Reads current `data/slug-registry.json` and `dist/sitemap-jobs*.xml`. Simulates TARGET_CANTONS=ALL_26 + canton quorum gate. Produces 3-bucket report:
- (a) genuinely new slugs (new ZH crawler etc.)
- (b) ZH slugs from existing crawlers that previously filtered out
- (c) reclassified slugs (TI→GR by quorum) — flag as "frozen URL preserved" per E9
Output: `data/dry-run-cathedral-flip-report.json` + console summary.
Done when: report printed, file written, exit 0.

**P1.6 — TARGET_CANTONS flip**
Files: MODIFIED `scripts/lib/crawler-location-config.mjs`
Action: `TARGET_CANTONS = ['TI', 'GR', 'VS']` → `TARGET_CANTONS = Object.keys(SWISS_CANTONS)` (all 26).
Done when: import works, no test regression on existing TI/GR/VS jobs.

**P1.7 — scripts/lib/jobs-loader.mjs (per-canton helper)**
Files: NEW `scripts/lib/jobs-loader.mjs`
Action: Exports `loadAllJobs()` (merge all per-canton shards) and `loadCantonJobs(code)`. Streaming-friendly to avoid OOM on 50k jobs.
Done when: replaces direct `data/jobs.json` reads in build-plugins.

**P1.8 — services/jobsService.ts SPA lazy fetch + IDB**
Files: MODIFIED `services/jobsService.ts`
Action: Add `fetchJobsForCanton(code)` with IDB cache + ETag check. `fetchAggregatedJobs()` does parallel fetch of selected cantons.
Done when: SPA can fetch per-canton without loading monolithic.

**P1.9 — components/community/JobBoard.tsx adapt**
Files: MODIFIED `components/community/JobBoard.tsx`
Action: Use `fetchJobsForCanton(filterCanton)` instead of monolithic. Pagination ~500/page within shard. Default canton: from D11 referrer-aware (frontaliere query → TI; else svizzera aggregator).
Done when: mobile 3G test loads canton page <5s.

**P1.10 — scripts/lib/sitemap-shard.mjs**
Files: NEW `scripts/lib/sitemap-shard.mjs`
Action: `splitToShards(urls, capPerShard=45000)` returns `[{filename: 'sitemap-jobs-ti.xml', urls: [...]}, ...]`. `emitSitemapIndex(shardPaths)` generates `sitemap-index.xml`.
Done when: sitemap-index.xml lists all shards, each ≤45k URLs.

**P1.11 — build-plugins/jobsSeoPagesPlugin.ts emit logic**
Files: MODIFIED `build-plugins/jobsSeoPagesPlugin.ts`
Action:
- Replace TARGET_CANTONS_CODES literal with read from `data/canton-url-slugs.json`
- Add `emitUrl(job, locale)` per E9 frozen-URL strategy
- Add `jobLocation[]` array per E8 single-canonical for multi-canton same job
- Integrate sitemap-shard
- Per-canton index page emit × 26 × 4 locales (104 pages)
Done when: dist contains all expected pages, sitemap-index.xml valid.

**P1.12 — build-plugins/jobMarketSnapshotPlugin.ts CH-wide**
Files: MODIFIED `build-plugins/jobMarketSnapshotPlugin.ts`
Action:
- Replace `TICINO_CITIES` hardcoded with CH-wide cities from BFS
- Pre-compute `cityToJobs` map (avoid N+1 per [4.2])
- Per-canton + per-city breakdown
Done when: F4 page shows correct CH-wide stats.

**P1.13 — build-plugins/weeklyEmployersPlugin.ts CH-wide**
Files: MODIFIED `build-plugins/weeklyEmployersPlugin.ts`
Action: Per-canton + per-company × CH refactor.
Done when: F5 page shows employers across all CH cantons.

**P1.14-P1.18 — ATS clients (5 files)**
Files: NEW
- `scripts/lib/ats-clients/workday-client.mjs` (extract from `scripts/lib/lonza-job-parser.mjs`)
- `scripts/lib/ats-clients/greenhouse-client.mjs` (extract from `scripts/lib/kudelski-nagra-job-parser.mjs`)
- `scripts/lib/ats-clients/lever-client.mjs` (extract from `scripts/lib/kudelski-nagra-job-parser.mjs`)
- `scripts/lib/ats-clients/successfactors-client.mjs` (NEW abstraction; migrate 10 existing parsers afterward)
- `scripts/lib/ats-clients/playwright-runtime.mjs` (stealth, polite rate-limit, browser lifecycle)

**P1.19 — Crawler health monitor**
Files: NEW `.github/workflows/crawler-health-monitor.yml`, NEW `data/crawler-health.json`
Action: Daily workflow that reads `data/jobs/by-crawler/{slug}.json` last-modified, parses health from each crawler's last run. If `consecutiveEmptyRuns >= 3` → create GitHub issue.

**P1.20 — Hospital + top-employers list**
Files: NEW `scripts/import-swiss-hospitals.mjs`, NEW `scripts/import-handelszeitung-top500.mjs`
Action: Scrape welches-spital.ch (public directory) + Handelszeitung Top 500 (replaces LinkedIn for autonomous run). Output to `data/swiss-hospitals.json` + `data/marquee-companies-list.json`.

**P1.21 — Documentation**
Files: MODIFIED `docs/CRAWLERS.md`, NEW `docs/CATHEDRAL-ROLLBACK.md`
Action: Update CRAWLERS.md with new architecture. Write rollback runbook including slug-registry snapshot-and-restore step.

### PHASE 2 — Marquee crawlers (parallel worktrees, ~17 companies)

Curated list (cantons distributed):
- **ZH (5)**: UBS Switzerland, Swiss Re, Zurich Insurance HQ, Migros HQ, ETH Zürich
- **BS (3)**: Roche, Novartis, Syngenta
- **VD (4)**: Nestlé Switzerland, EPFL, CHUV, Logitech
- **BE (3)**: SBB CFF, Mobiliar HQ, Inselspital
- **GE (1)**: Pictet
- **LU (1)**: Schindler

Each crawler = 1 task = 1 agent in worktree. Parallelism 3 max.

For each company:
1. `scripts/update-{slug}-jobs.mjs`
2. `scripts/lib/{slug}-job-parser.mjs` (using ats-clients)
3. `.github/workflows/update-jobs-{slug}.yml`
4. Entry in `data/jobs-crawler-config.json`

### PHASE 3 — Test coverage

3.1 `tests/canton-quorum-gate.test.ts` (26 happy + 10 edge)
3.2 `tests/router-canton-slugs.test.ts` (4 locales × 26 cantons + svizzera)
3.3 `tests/sitemap-shard.test.ts` (45k cap, edges)
3.4 `tests/jobs-loader.test.ts` (load/merge correctness)
3.5 `tests/lib/ats-clients/*.test.ts` (5 files)
3.6 `tests/crawler-health.test.ts`
3.7 `tests/dry-run-target-cantons-flip.test.ts`
3.8 `tests/build-plugins/jobs-seo-pages-canton-emit.test.ts`
3.9 `tests/e2e/cathedral-flip-simulation.spec.ts` (CRITICAL regression gate)
3.10 `tests/e2e/canton-landing-seo.spec.ts`
3.11 `tests/e2e/jobboard-canton-shard.spec.ts`
3.12 `tests/e2e/sitemap-shard.spec.ts`
3.13 `tests/e2e/legacy-ti-urls.spec.ts`
3.14 `tests/e2e/canton-locale-routing.spec.ts`

### PHASE 4 — Final QA Gate (run all the things we skipped)

4.1 `npx tsc --noEmit` — clean
4.2 `npx vitest run` — all green
4.3 `FAST_BUILD= npx vite build` — clean exit
4.4 `npx playwright test tests/e2e/cathedral-flip-simulation.spec.ts` — pass
4.5 6 SEO content gates (run audits, rebaseline + improvement same-commit pattern)
4.6 `node scripts/dry-run-target-cantons-flip.mjs` — sanity check
4.7 Smoke test on preview URL: 10 sample pages

### PHASE 5 — Merge + Deploy

5.1 Update `pre-cathedral-2026-05-10` tag to remote (already tagged locally)
5.2 Final commit with comprehensive CHANGELOG
5.3 `git checkout main && git pull origin main`
5.4 `git merge feat/cathedral-ch-wide --no-ff`
5.5 `git push origin main`
5.6 Monitor `gh run watch` for deploy workflow
5.7 Wait for `gh run view` conclusion: success
5.8 Verify live site smoke test

### PHASE 6 — Cleanup

6.1 Inventory remaining branches: `git branch -a`
6.2 Inventory stashes: `git stash list`
6.3 Drop pre-session stash if intact and not relevant
6.4 Delete `feat/cathedral-ch-wide` (already merged)
6.5 Verify final state: only `main` remains

## Risks reaffirmed (carry forward, no re-litigation)

1. D10 Z mega-PR — high deploy risk
2. D11 brand dilution monitoring SKIP
3. E9 slug-registry frozen URL inconsistency
4. E10 LinkedIn ToS — DEFERRED to manual run by user (autonomous skip)

## NOT in this autonomous run (Phase 2 follow-ups)

1. Remaining 50-80 marquee crawlers beyond initial 17 — task list documented for future run
2. LinkedIn discovery script execution (E10 reaffirmed but autonomous unsuited)
3. Brand dilution monitoring workflow (D11 deferred)
4. Per-canton AdSense channels (manual UI)
5. Job-alert geo extension
6. Additional E2E test edge cases beyond mandatory regression gate
