# Cathedral Phase 8 — Canton-Aware Rewrite

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement these sub-PRs in parallel where dependencies allow.

**Goal:** Complete the cathedral migration by aligning every URL-emitting plugin with the canton-aware architecture stated by the product owner. The Phase 1–7 work (PR #107, #108) unblocked the deploy via band-aid fixes; Phase 8 replaces those band-aids with the correct architectural invariants.

**Target architecture (product owner statement):**
- `/cerca-lavoro-svizzera/` (+ 4 locale variants) = all-CH aggregator (pure navigation hub, NOT a faceted search)
- `/cerca-lavoro-{canton}/` (+ 4 locale variants) = per-canton search engine — every canton hub does what `/cerca-lavoro-ticino/` does today, scoped to its canton
- `/cerca-lavoro-{canton}/{slug}/` = job-detail at the canton path of the job
- Sub-page hubs (`/cerca-lavoro-{canton}/{tutti|settori|aziende|infermieri|oggi|...}/`) replicated for every canton with data
- previousSlugs bridges, expired soft-landings, related-links, sitemap entries: **all use the canton path of the job**, never the legacy TI section

**Hard invariants (must hold post-Phase-8):**
1. **TI invariance** — every existing `/cerca-lavoro-ticino/{anything}/` URL stays byte-identical (SEO history)
2. **Slug-registry frozen-URL** — registry is immutable; entries only get NEW fields (canton already added in Phase 1)
3. **Canonical self-reference** — every emitted page's `<link rel="canonical">` points at its own canton path; no cross-canton canonical
4. **hreflang completeness** — every multilingual page emits all 4 locales + x-default; postprocess drop-all-if-<5 (the Phase 3 band-aid) is REMOVED once the dedup architectural fix lands

---

## Pre-requisites

- Start in a fresh worktree per sub-PR (parallel execution).
- `data/jobs.json` (gitignored, ~30 MB) copied into each worktree before running scripts.
- `FAST_BUILD=` explicit-empty when running any vite command.
- Cathedral commits already in main: `87121647a9..0f56ef3720` (PR #107 + #108).

---

## Sub-PR map + dependencies

```
        ┌──────────────────────────────────┐
        │ (a) Dedup invariant              │  ← unblocks (b), (c), (g)
        │ (canton, locale, slug)           │
        └──────┬───────────────────────────┘
               │
        ┌──────┴─────────┬─────────────────┐
        ▼                ▼                 ▼
  (b) previousSlugs  (c) Expired      (g) Canton search engine
      canton-aware       tracking         richness parity with TI
                         canton-aware

  Parallel-with-anyone:
  (d) jobEditorialLanding extension
  (e) Nursing / Career / Profession extension
  (f) Orphan query canton-aware fallback
```

Sub-PRs (b), (c), (g) **must** wait for (a) to merge. (d), (e), (f) are independent.

---

## (a) Dedup invariant: (canton, locale, slug)

**Scope:** `build-plugins/jobsSeoPagesPlugin.ts` — replace the flat `(locale, slug)` dedup key with `(canton, locale, slug)`. Removes the Phase 3 band-aid.

**Files modified**
- `build-plugins/jobsSeoPagesPlugin.ts:1937-1965` (job-detail emit dedup key)
- `build-plugins/jobsSeoPagesPlugin.ts:1956` (key constant)
- `build-plugins/hreflangPostprocessPlugin.ts` — REVERT the Phase 3 drop-all-below-threshold logic
- `build-plugins/jobsSeoPagesPlugin.ts:~7607` — sitemap-emit consistency Phase 2 fix is preserved (still relevant; canton is now part of the natural dedup key)

**Files created**
- `tests/seo/cathedral-canton-dedup.test.ts` — assert that two jobs with identical (locale, slug) but different canton both emit HTML at their canton paths
- `tests/seo/cathedral-hreflang-full-cluster.test.ts` — assert every job-detail page has 5 hreflang entries (post-strip pass)

**Steps**

- [ ] **Step 1:** Write failing tests (TDD)
  ```bash
  npx vitest run tests/seo/cathedral-canton-dedup.test.ts
  npx vitest run tests/seo/cathedral-hreflang-full-cluster.test.ts
  ```
  Both should fail because dedup is still flat.

- [ ] **Step 2:** Change dedup key + accompanying set
  ```typescript
  // jobsSeoPagesPlugin.ts:~1937
  const emittedActiveJobPaths = new Set<string>();  // KEPT
  // Old key (line 1955): `${locale}:${perLocaleSlug[locale]}`
  // New key:
  const __activeJobKey = `${jobCanton}:${locale}:${perLocaleSlug[locale]}`;
  ```

- [ ] **Step 3:** Remove `emittedActiveCantonSectionPaths` Set (Phase 2 fix), redundant once the dedup key includes canton.
  - Sitemap push site at ~7607: keep the guard but use `emittedActiveJobPaths` directly with the same key.

- [ ] **Step 4:** Revert Phase 3 drop-all-below-threshold logic in `hreflangPostprocessPlugin.ts`:
  - Restore lines 122-148 (transformHreflang) and 244-262 (deprecated plugin) to pre-Phase-3 state.
  - The architectural fix should leave 5 valid alternates on every page; strip-broken should never need to fire on a job-detail page.

- [ ] **Step 5:** Verify ratchet on dist/.write-collisions.json: confirm count goes from ~24k → < 100 (genuine cross-canton collisions on shared brand hubs).

- [ ] **Step 6:** Live smoke — after deploy, curl a localsearch.ch job per-canton; every page must return 200 with full 5-hreflang cluster:
  ```bash
  for c in basilea zurigo argovia lucerna grigioni; do
    curl -sI "https://frontaliereticino.ch/cerca-lavoro-${c}/venditore-a-in-rete-localsearch-{city}/" | head -1
    curl -s "https://frontaliereticino.ch/cerca-lavoro-${c}/venditore-a-in-rete-localsearch-{city}/" | grep -c 'rel="alternate"'
  done
  ```

- [ ] **Step 7:** Commit
  ```
  fix(cathedral): dedup at (canton, locale, slug) — emit per-canton HTML

  Each cross-canton slug collision (21 localsearch.ch DE) now resolves
  to one HTML file per canton instead of one global winner; sibling
  hreflang alternates point at real files, no postprocess strip needed.

  Reverts the Phase 3 drop-all-below-threshold band-aid in
  hreflangPostprocessPlugin: original strip-broken behaviour returns
  but should fire near zero times on job-detail pages.

  Trade-off: more dist HTML files (~21k extra at steady state) but
  every page now has SEO-correct canton-specific canonical and
  hreflang signals.
  ```

---

## (b) previousSlugs bridges canton-aware

**Depends on:** (a) merged.

**Scope:** `build-plugins/jobsSeoPagesPlugin.ts:9544-9635` + `services/previousSlugWinners.ts`.

**Files modified**
- `build-plugins/jobsSeoPagesPlugin.ts:9609` — `oldPath` builder
- `build-plugins/jobsSeoPagesPlugin.ts:7385` — sitemap entry path
- `services/previousSlugWinners.ts` — `makeKey` and `WinnersFile` shape
- `data/previous-slug-winners.json` — migrate to include canton in key

**Files created**
- `tests/seo/cathedral-previous-slug-canton.test.ts`
- `scripts/migrate-previous-slug-winners-add-canton.mjs`

**Steps**

- [ ] **Step 1:** Update `previousSlugWinnerKey` signature:
  ```typescript
  // services/previousSlugWinners.ts
  export const makeKey = (canton: string, locale: string, oldSlug: string) =>
    `${canton}::${locale}::${oldSlug}`;
  ```
  Add `canton` field to `WinnerEntry`.

- [ ] **Step 2:** Migration script:
  ```bash
  node scripts/migrate-previous-slug-winners-add-canton.mjs
  ```
  For every existing entry, infer canton from the winner's `jobIdentifier` (lookup in jobs.json) and add to the key + entry. Fallback to TI.

- [ ] **Step 3:** Bridge emit in jobsSeoPagesPlugin.ts:9609:
  ```typescript
  const oldPath = `${localePrefix[locale]}/${buildCantonAwareSection(locale, job.canton)}/${oldSlug}`
    .replace(/\/+/g, '/');
  ```
  (Drop `sectionByLocale[locale]` — that was the bug.)

- [ ] **Step 4:** previousSlugClaimants pre-scan also keyed by canton (line 9481-9512).

- [ ] **Step 5:** Test: a job that was previously in BS (now ZH after a refresh) emits its bridge at `/de/jobs-im-basel/{oldSlug}/`, NOT `/de/jobs-im-tessin/{oldSlug}/`.

- [ ] **Step 6:** Commit
  ```
  fix(cathedral): previousSlugs bridges live at the job's canton path

  Replaces hardcoded sectionByLocale[locale] (always TI) with
  buildCantonAwareSection(locale, job.canton). Bridge URLs now match
  the active job's actual canton, so the canonical inside the bridge
  HTML resolves correctly for Google.

  previousSlugWinners migration: adds canton to the winner-key so
  same-oldSlug-different-canton collisions resolve to distinct
  winners instead of overwriting each other.
  ```

---

## (c) Expired soft-landing tracking canton-aware

**Depends on:** (a) merged.

**Scope:** `build-plugins/jobsSeoPagesPlugin.ts:7996-8002` + `data/all-known-job-slugs.json` migration.

**Files modified**
- `build-plugins/jobsSeoPagesPlugin.ts:7999` — `tracking[job.slug][locale]` builder
- `build-plugins/jobsSeoPagesPlugin.ts:9609`-adjacent — existence-of-active check (line ~9613)
- `data/all-known-job-slugs.json` — migrate paths in place

**Files created**
- `scripts/migrate-all-known-job-slugs-canton-aware.mjs`
- `tests/seo/cathedral-expired-tracking-canton.test.ts`

**Steps**

- [ ] **Step 1:** Migration script — for every key in `all-known-job-slugs.json`:
  1. Look up the job in jobs.json (by slug or previousSlug)
  2. Replace `/cerca-lavoro-ticino/` → `/cerca-lavoro-{canton}/` (and per-locale equivalents)
  3. Fallback: keep TI path if job lookup fails

- [ ] **Step 2:** Modify `tracking[job.slug][locale]` line 7999:
  ```typescript
  const jobCantonForTracking = sharedResolveJobCanton(job as any);
  const relPath = `${localePrefix[locale]}/${buildCantonAwareSection(locale, jobCantonForTracking)}/${localizedSlug(job, locale)}`
    .replace(/\/+/g, '/');
  tracking[job.slug][locale] = relPath;
  ```

- [ ] **Step 3:** Verify `activeJobDirs.has(oldRelPath.replace(/\/+$/, ''))` at line 9613 still matches correctly — the active-job paths set IS canton-aware after (a) lands.

- [ ] **Step 4:** Commit
  ```
  fix(cathedral): expired-job tracking uses job's canton path

  When a non-TI job expires, its soft-landing now fires at the canton
  path that the active page used to occupy — eliminates the
  expired-vs-active path mismatch that left ZH active pages
  unguarded against a TI-path soft-landing overwrite.
  ```

---

## (d) jobEditorialLanding extension — today/sector/nursing/parttime per canton

**Independent of (a).**

**Scope:** `build-plugins/jobEditorialLanding.ts` + emit loop in `build-plugins/jobsSeoPagesPlugin.ts:3940` (and 4 sibling editorial branches around lines 4105, 4265, 4438, 4618).

**Files modified**
- `build-plugins/jobEditorialLanding.ts` — `JOB_TODAY_LANDING_SLUGS_BY_CANTON`, `getJobTodayLandingSlug` (already canton-aware for slugs but section is TI-hardcoded in emit caller)
- `build-plugins/jobsSeoPagesPlugin.ts:~3940-4071` — `for (const editorialCanton of EDITORIAL_CANTONS)` — extend from TI-only to all cantons with N > threshold
- Sibling editorial branches: nurses, parttime, care variants, breadcrumb-variants

**Steps**

- [ ] **Step 1:** Define `EDITORIAL_CANTONS` constant — cantons with enough jobs to justify a today-landing (threshold ~10):
  ```typescript
  const EDITORIAL_MIN_JOBS = 10;
  const editorialCantons = [...ALL_CANTON_CODES, AGGREGATE_KEY]
    .filter((c) => (cantonJobCounts.get(c) ?? 0) >= EDITORIAL_MIN_JOBS);
  ```

- [ ] **Step 2:** Each editorial-emit loop iterates editorialCantons instead of `[DEFAULT_CANTON]`. The section in the path comes from `buildCantonAwareSection(locale, editorialCanton)` — **not** `sectionByLocale[locale]`.

- [ ] **Step 3:** today-landing path becomes `/cerca-lavoro-{canton}/oggi/` (or per-locale equivalent: `/{lang}/find-jobs-{canton}/today/`). Today's path `/cerca-lavoro-ticino/offerte-di-lavoro-{canton}-oggi/` stays in `getJobTodayLandingSlug` ONLY for the TI canton (preserves the legacy URL). For non-TI cantons, the new short-form slug applies: `oggi` (it), `today` (en), `heute` (de), `aujourdhui` (fr).

- [ ] **Step 4:** **TI invariance check:** for `editorialCanton === 'TI'`, the path output **must** equal the pre-Phase-8 path byte-for-byte. Snapshot test.

- [ ] **Step 5:** Commit
  ```
  feat(cathedral): editorial landings extend to all editorial-eligible cantons

  Today, sector, nursing, part-time, and care editorial landings now
  emit at /cerca-lavoro-{canton}/{slug}/ for every canton with ≥10
  jobs. TI URLs unchanged.
  ```

---

## (e) Nursing / Career / Profession plugin extension

**Independent of (a).**

**Scope:** Three plugins. All three currently emit only at `/cerca-lavoro-ticino/{profession-slug}/`.

**Files modified**
- `build-plugins/nursingLandingsPlugin.ts`
- `build-plugins/careerLandingsPlugin.ts`
- `build-plugins/professionLandingsPlugin.ts`

**Steps (per plugin)**

- [ ] **Step 1:** Add `cantonsWithJobs` derivation at plugin entry — iterate jobs, count per canton+profession-match. Keep cantons above threshold (e.g. 5 jobs in the relevant profession).

- [ ] **Step 2:** Loop emit per (canton, locale): `/{prefix}/{cantonAwareSection}/{profession-slug}/`. Use the existing `buildCantonAwareSection` helper (import from `cantonSection.ts`).

- [ ] **Step 3:** Each emitted page renders the profession content scoped to that canton's jobs (filter list).

- [ ] **Step 4:** Hreflang cluster — all 4 locales + x-default, all pointing to canton-specific URLs.

- [ ] **Step 5:** Sitemap entries per profession × canton × locale.

- [ ] **Step 6:** Commit per plugin (3 commits in one PR):
  - `feat(nursing-landings): per-canton infermieri hubs`
  - `feat(career-landings): per-canton career page matrix`
  - `feat(profession-landings): per-canton profession hubs`

---

## (f) Orphan query landing canton-aware fallback

**Independent of (a).**

**Scope:** `build-plugins/orphanQueryLandingPlugin.ts`.

**Files modified**
- `build-plugins/orphanQueryLandingPlugin.ts:~510` — fallback hard-coded `/cerca-lavoro-ticino/`

**Steps**

- [ ] **Step 1:** Infer the canton from the orphan query when possible (query contains canton name or city → `resolveJobCanton`-style lookup). Fallback to the aggregator (`/cerca-lavoro-svizzera/`) instead of TI.

- [ ] **Step 2:** Orphan landing layout includes a canton-nav (link to all 26 hubs) so visitors that hit the wrong canton can self-correct.

- [ ] **Step 3:** Commit
  ```
  fix(cathedral): orphan query fallback → aggregator + canton nav

  Orphan queries from GSC that don't map cleanly to a canton now land
  on /cerca-lavoro-svizzera/ with a 26-canton picker instead of
  defaulting to TI. Canton-named queries route to the matching hub.
  ```

---

## (g) Canton search engine richness parity with TI

**Depends on:** (a) merged.

**Scope:** `build-plugins/jobsSeoPagesPlugin.ts:7754-7935` (canton landing emit) — bring the static HTML up to TI-hub parity.

**What TI has that cathedral cantons don't (today):**
- Full editorial intro (~150 words AI-extractable definition block)
- Deep-link archive navigator (Pagina N/N anchors)
- FAQ block
- Domain authority box (sources cited)
- Per-canton commuter context (Como ↔ Lugano border guide → equivalent: Varese ↔ Lugano for TI, Milano ↔ Basel for BS, etc.)

**Steps**

- [ ] **Step 1:** Extract the TI editorial blocks from `staticPagesPlugin.ts` into a shared helper: `buildCantonHubEditorial(cantonCode, locale)`.

- [ ] **Step 2:** Parametrize per-canton:
  - Border crossings list per canton (TI: Como/Varese; BS: Lörrach/St-Louis; GR: Tirano; etc.)
  - Commuter prose template uses canton + neighbouring Italian regions

- [ ] **Step 3:** Inject the editorial blocks in canton landing body (after `tileGrid`, before `subPageNav`).

- [ ] **Step 4:** Verify text/HTML ratio per canton hub ≥ 12 % (target gate).

- [ ] **Step 5:** Verify SPA hydration: post-hydrate, the React JobBoard renders the search UI filtered by `initialFilterCanton`. Browser test on `/cerca-lavoro-zurigo/` — search bar, filters, pagination must work.

- [ ] **Step 6:** Commit
  ```
  feat(cathedral): canton hubs reach TI-hub editorial parity

  Each /cerca-lavoro-{canton}/ landing now ships the same editorial
  package TI has had since launch: 150-word definition block, FAQ,
  deep-link archive navigator, canton-specific commuter context. The
  SPA bundle still hydrates on top so the React JobBoard search
  engine renders post-hydration.
  ```

---

## Execution mode

**Recommended (parallel subagent-driven dispatch):**

1. **Pre-flight (orchestrator):** worktree per sub-PR via `EnterWorktree`. Copy `data/jobs.json` into each. Pass `isolation: "worktree"` to every spawned Agent.

2. **Wave 1 (parallel):**
   - Sub-PR (a) — `claude` (general-purpose) — blocks (b), (c), (g)
   - Sub-PR (d) — `claude` (general-purpose)
   - Sub-PR (e) — `claude` (general-purpose) — could be 3 sub-agents if speed matters
   - Sub-PR (f) — `claude` (general-purpose)

3. **Wave 2 (after (a) merges, parallel):**
   - Sub-PR (b) — `claude`
   - Sub-PR (c) — `claude`
   - Sub-PR (g) — `claude`

4. **Per sub-PR contract (orchestrator passes to each subagent):**
   - Read this plan section
   - Implement the listed steps
   - Run `npx tsc --noEmit && npx vitest run tests/seo/`
   - Open PR via `gh pr create`
   - Merge via `gh pr merge --admin` (orchestrator-mode authorized in CLAUDE.md)

**Estimated wall time:** 4-6 hours including 2 CI cycles (~50 min) waiting on merges.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Dedup change in (a) explodes dist size (21× expansion on shared slugs) | Measure first: pre-build count of cross-canton slug collisions. Target stays under 50% growth. |
| TI invariance violated by editorial extension (d) | Snapshot test on TI canton: byte-for-byte HTML diff vs pre-Phase-8 build. |
| previousSlugWinners.json migration loses winner history | Migration runs in dry-run first; commit baseline JSON. |
| `audit:max-bfs-depth` baseline regresses on new sub-page hubs | Each plugin adds internal links to its own landings from a reachable hub (cathedral canton-nav). |
| Canton hubs without enough jobs ship thin content | Threshold gate (≥10 jobs for editorial, ≥5 for profession). Below threshold: noindex but page still emits for direct visits. |

## Self-review

- **Spec coverage:** Every TI-hardcoded plugin in the audit has a corresponding sub-PR. ✅
- **Invariants:** TI invariance, slug-registry immutability, canonical self-reference, hreflang completeness — all called out. ✅
- **Order of operations:** Dependencies between sub-PRs documented; (b/c/g) gated on (a). ✅
- **Roll-back path:** Each sub-PR is its own commit — `git revert <sha>` recovers any single change. ✅
