# Pipeline optimization — remaining plan

Authored 2026-05-10 after the autonomous loop that shipped 5 commits and saved
~14 minutes off `closeBundle` (cluster -607s, jobs-seo -171s, post-walk -23s).
This document describes the optimizations **not yet shipped** with enough
detail to execute them in a future session, including risk assessment, exact
file changes, and rollback procedures.

## Cumulative state today

| Phase | Today (post-loop) | Default mode |
|---|---:|---|
| `closeBundle` total (sum of plugin walls) | ~417 s | parallel (just flipped) |
| Build job wall-clock | ~634 s expected (was 716 s sequential) | parallel |
| Top plugins | jobs-seo 187 s, cluster 117 s, post-walk 46 s | — |

Iron law (must hold for every change below):
- Same number of files in `dist/` — verified via `find dist/ -type f | wc -l`.
- Byte-identical content for SEO-relevant pages — verified via sha256 sample.
- All 6 SEO content gates pass (`audit:title-length`, `audit:text-html-ratio`,
  `audit:image-object-license`, `audit:max-bfs-depth`,
  `audit:title-no-disambig-hash`, `audit:orphan-sitemap-pages`).
- Live site renders identically — verified via `gstack` browser before/after.

Measurement protocol for every change:
```bash
gh workflow run deploy.yml --ref main \
  -f profile_sequential=true \
  -f parallel_plugins=true   # only when measuring parallel; omit for clean per-plugin numbers
```
Watch `[profile]` lines + `[profile-total]` summary + `Build job wall-clock`.

Rollback: every plan below is contained in 1-3 commits. Revert via `git revert`.

---

## Plan A — Post-walk targeted refactor

**Save**: ~30-40 s (post-walk 46 s → 5-10 s).
**Risk**: medium. Cross-cutting on 3 files; output is byte-identical because
the targeted plugins do exactly the same transforms, just on a tiny subset of
files instead of scanning all 348k.

### Why it works

`postWalkCoordinatorPlugin` today scans **every** `.html` file in `dist/`
(348k) across 4 worker threads. It applies three transforms:

| Transform | Files actually touched | Files scanned to find them |
|---|---:|---:|
| Flat-redirect bridge conversion | ~158 k (now mostly fast-path skip) | 348 k |
| Blog contextual links injection | 1,902 | 348 k |
| Hreflang strip/rewrite | 4 | 348 k |

The bridge work is now ~free thanks to the fast-path discriminator
(commits 7a00222681 + 2bb900a615). The remaining 46 s wall is spent
**reading the other 188 k files just to confirm they need no work**.

Blog has a known set of paths (`blogIndexHtmlByPath` map, ~1.9 k entries
already computed at build time). Hreflang touches only files containing
specific `<link rel="alternate">` tags — likely a small known subset
(localised landing pages).

If we replace the full scan with two targeted plugins:

- `blogContextualLinksPlugin`: iterate the known 1,902 blog paths, read each,
  inject, write. Cost: ~2 s.
- `hreflangPostprocessPlugin`: iterate only the locale-prefixed
  `cerca-lavoro-ticino` / `find-jobs-ticino` / `find-job-ticino` /
  `cherchez-emploi-ticino` subtrees (where hreflang lives), or even better,
  a path manifest emitted by jobsSeoPagesPlugin. Cost: ~1-3 s.

Net post-walk: **~5 s total** (just the targeted runs, no full-dist scan).

### Implementation steps

1. **Extract blogContextualLinksPlugin into a standalone closeBundle plugin.**
   - It already computes `blogIndexHtmlByPath` in `postWalkCoordinatorPlugin.ts`.
   - Move that computation + per-path read/inject/write into
     `build-plugins/blogContextualLinksPlugin.ts` (file already exists; expand
     it with a closeBundle hook).
   - Use `WriteCollector` for the writes so collisions are tracked.
   - `enforce: 'post'`, `closeBundle.order: 'post'`, `sequential: false`
     (parallel-safe — different paths than other plugins).

2. **Extract hreflangPostprocessPlugin into a targeted standalone plugin.**
   - Identify the subtrees that need hreflang processing. Probably:
     - `dist/{it,en,de,fr}/cerca-lavoro-ticino/...` (jobs-seo emit roots)
     - `dist/{it,en,de,fr}/find-jobs-ticino/...`
     - `dist/{it,en,de,fr}/find-job-ticino/...`
     - `dist/{it,en,de,fr}/cherchez-emploi-ticino/...`
   - Even better: have jobsSeoPagesPlugin push a list of "needs-hreflang-pass"
     paths into a shared module, post-walk reads it.
   - Hreflang transform reads file → checks for `<link rel="alternate">` →
     rewrites if needed. Targeted scan: ~few hundred files at most.

3. **Delete `postWalkCoordinatorPlugin` after blog + hreflang are extracted.**
   - The bridge fast-path is also done — but bridges are already correctly
     emitted by cluster + jobs-seo (commit 45399c0779). Verify: dispatch
     a build with the coordinator removed, check that
     `dist/.write-collisions.json` shows no collisions, run all SEO gates,
     spot-check a sample of cluster + jobs-seo flat .html for the bridge
     content.
   - Remove the 4-worker spawn machinery, the round-robin chunker, the
     IPC postMessage boilerplate (`postWalkWorker.mjs`).

### Validation

- `npm run build:ci` locally (FAST_BUILD= for full SEO plugins) — verify
  exit 0 and `dist/` file count matches pre-change.
- Run all 6 SEO gates against the new `dist/`:
  ```bash
  npm run audit:text-html-ratio
  npm run audit:orphan-sitemap-pages
  npm run audit:image-object-license
  npm run audit:max-bfs-depth
  npm run audit:title-length
  npm run audit:title-no-disambig-hash
  ```
- Sample sha256 diff of 100 random `.html` files vs. a pre-change `dist/`
  snapshot — any diff is a regression to investigate before committing.
- Profile dispatch run: `gh workflow run deploy.yml -f profile_sequential=true`
  and confirm post-walk drops from ~46 s to <10 s.

### Rollback

Single commit per step. `git revert` restores the coordinator + worker.
The old code stays compatible because the new plugins are additive until
the coordinator is removed in step 3.

### Files touched

- `build-plugins/blogContextualLinksPlugin.ts` (expand with closeBundle hook)
- `build-plugins/hreflangPostprocessPlugin.ts` (expand with closeBundle hook)
- `build-plugins/postWalkCoordinatorPlugin.ts` (remove)
- `build-plugins/postWalkWorker.mjs` (remove)
- `vite.config.ts` (swap coordinator for the two new plugins)

---

## Plan B — worker_threads in jobsSeoPagesPlugin (soft-landing render)

**Save**: ~30-50 s (jobs-seo 187 s → ~140-150 s).
**Risk**: high. 63k iterations of HTML rendering moved to workers; shared
state (writtenPaths, slugRegistry, expiredSoftLandingCache) must be carefully
serialised at the boundary.

### Why it works

The jobsSeoPagesPlugin generation phase splits into:

| Phase | Pages | CPU |
|---|---:|---:|
| Active job pages | 7,612 | ~20 s |
| Company landings | 804 | ~20 s |
| Paginated + category | 184 | ~4 s |
| Fuzzy orphan match | 7,170 | ~7 s |
| **Soft-landing for expired** | **63,475** | **~50-60 s** |
| Previous-slug bridges | 21,359 | ~10 s |
| Cross-locale reconciliation | 28,208 | ~8 s |

The soft-landing phase is by far the largest: 63k pages × ~1 ms render each.
Each page is independent (data lookup + JSON-LD + HTML interpolation) — perfect
for workers.

With 4 workers on the GH 4-vCPU runner:
- Theoretical: 60 s / 4 = 15 s (4× parallelism).
- Realistic (worker spawn + IPC + GC pressure): 60 s → 25-30 s, save **30-35 s**.

### Implementation steps

1. **Identify the per-iteration work.**
   See `build-plugins/jobsSeoPagesPlugin.ts:7395-7522` (the soft-landing
   for-loop). Each iteration takes:
   - `slugByLocale[locale]` (Map lookup)
   - `ejData = expiredJobMap.get(...)` (Map lookup)
   - `buildJobPostingSchema(...)` (pure function)
   - `JSON.stringify(jp)` (CPU)
   - `buildSoftLandingHtml(...)` (template interpolation)
   - `writeSoftLandingPage(...)` → `_qwFlat(flatFile, html)` → collector + bridge

2. **Snapshot the worker input upfront.**
   The shared inputs the soft-landing loop reads are:
   - `expiredJobMap`: `Map<id, ExpiredJobData>` (~19k entries)
   - `slugRegistryByLocale`: `Map<locale, Map<slug, ...>>`
   - `localeShells[locale]`: prebuilt shell HTML
   - `RESERVED_HUB_SLUGS`: Set
   - `activeJobDirs`: Set (~7.6k entries)
   - `expiredCacheKeys`, `emittedSoftLandingPaths`: state mutated DURING the loop

   The mutated sets need careful handling. Two options:

   **Option B.1 (per-locale chunking, lower coordination cost):**
   Split the 63k iterations by locale (4 chunks). Each worker handles one
   locale. Worker-local Sets for `emittedSoftLandingPaths` (per-locale
   namespaced — locale + slug uniqueness is preserved by the path prefix
   `/{localePrefix[locale]}/...`). After all workers return, merge their
   emitted-content arrays into the main collector + writtenPaths.

   **Option B.2 (full N-way parallel, higher coordination):**
   Round-robin chunk of the full slug list, each worker emits its own
   collector buffer, main thread merges via `_qw` or directly into the
   shared collector. emittedSoftLandingPaths becomes a `SharedArrayBuffer`
   bitmap or each worker's local Set + post-merge dedup.

   **Recommendation**: B.1. Simpler. Locale-bound work matches the natural
   data shard. ~16k pages per worker × 4 workers = balanced.

3. **Build the worker.**
   - `build-plugins/jobsSeoSoftLandingWorker.mjs` (new file, plain ESM
     mirroring `postWalkWorker.mjs` style).
   - Worker receives: `{ locale, expiredJobs[], slugRegistrySnapshot,
     localeShell, activeJobDirsSet, reservedHubSlugs, baseUrl, ... }`.
   - Worker returns: `{ writes: [{ relPath, html }], emittedPaths: Set,
     legacyBridges: [...], stats: { rendered, skipped, ... } }`.
   - Worker uses `--import tsx` for TS imports (same pattern as
     `postWalkCoordinatorPlugin`).
   - Worker should NOT use `WriteCollector` directly (the registry is
     thread-local). Worker accumulates into a plain array, main thread
     calls `_qwFlat` for each entry to feed the registry.

4. **Coordinate from the main plugin.**
   Replace the soft-landing for-loop with a `Promise.all` over 4 workers.
   - Pre-compute the per-locale work units.
   - Spawn 4 workers via `worker_threads`.
   - Main thread accepts results and feeds `_qwFlat` (cheap loop, just
     pushes into the collector).

5. **Cross-locale reconciliation phase still uses `expiredSoftLandingCache`.**
   That phase reads the rendered HTML for the base locale and clones it
   with a bridgeScript injection. Workers must populate
   `expiredSoftLandingCache` via their returned writes.

### Validation

- Local test against fixture data (a small slice of `data/jobs.json` +
  expired jobs JSON). Compare output to the sequential baseline byte-for-byte.
- Then full CI dispatch with `profile_sequential=true` to see
  `[profile] jobs-seo-pages` drop and `[jobs-seo-pages] Generated 63475
  soft-landing pages` matches.
- Check `dist/.write-collisions.json` shows no new collisions.

### Risks

- **Race on shared state**: solved by per-locale chunking + main-thread merge.
- **Worker spawn cost**: 4 workers with `--import tsx` cost ~2-3 s startup.
  Dwarfed by 30-35 s save.
- **Memory**: each worker holds a snapshot of expired jobs + slug registry +
  ~16k rendered HTML in flight. Estimated 100-200 MB per worker × 4 = ~500 MB.
  Within the 7 GB runner budget. If parallel_plugins is also on, total parallel
  memory pressure could approach 1.5 GB. Still safe.
- **Output ordering**: soft-landing page emit order doesn't affect on-disk
  content (each path is unique). But `emittedSoftLandingPaths` Set used for
  collision dedup needs the same membership across runs — verify by comparing
  the dedup count in the log.

### Files touched

- `build-plugins/jobsSeoPagesPlugin.ts` (replace soft-landing loop with
  worker dispatch)
- `build-plugins/jobsSeoSoftLandingWorker.mjs` (new, ~150 lines)

---

## Plan C — worker_threads in relatedSearchClustersPlugin (render+emit)

**Save**: ~40-60 s (cluster 117 s → ~60-75 s).
**Risk**: high. Same shape as Plan B but on cluster contexts.

### Why it works

After the inverted index optimization (commit 119475af96), the cluster
plugin spends:

| Phase | Wall | Notes |
|---|---:|---|
| Match filter (inverted index lookups) | ~5 s | Already heavily optimized |
| `byKeywordCity`, `byLocaleCity` index build | ~2 s | Pre-loop setup |
| Per-cluster render + emit | ~95 s | renderClusterPage × 52,774, ~1.8 ms each |
| Per-locale hub pages | ~5 s | renderHubPage × ~80 pages |
| Cache save | ~5 s | data/related-search-clusters.cache (?) |

The 95 s render+emit phase is parallelizable: each cluster context is
independent. Pre-computed shared inputs (hreflang Map, related Map, byLocale
sub-Maps) are read-only after the setup phase.

With 4 workers: 95 s / 4 ≈ 24 s ideal. Realistic: 35-40 s, save **55-60 s**.

### Implementation steps

1. **Snapshot the shared inputs.**
   The render loop at `relatedSearchClustersPlugin.ts:1335-1373` reads:
   - `byKeywordCity: Map<key, Map<Locale, ClusterContext>>`
   - `byLocaleCity: Map<Locale, Map<city, ClusterContext[]>>`
   - `enriched: Record<key, EnrichedEntry>` (loaded from JSON, ~1.5k entries)
   - `dateStamp: string`
   - `BASE_URL`, `buildClusterPath`, `renderClusterPage` (all pure)

   These snapshot cleanly across worker boundaries.

2. **Per-locale chunking (Plan B style).**
   - 4 workers, each handles one locale's contexts (~13k contexts each).
   - Worker returns `{ writes: [{ urlPath, html }], emittedFiles: [...],
     sitemapLocs: [...] }`.
   - Main thread: feed each write into `collector.add(indexPath, html)` +
     `_qwFlat-equivalent` for flat path (use `buildFlatBridgeFromSibling`
     directly — already imported in the plugin), accumulate
     `emittedFiles` and `sitemapLocs`.

3. **Worker file:**
   `build-plugins/relatedSearchClustersWorker.mjs`. Imports:
   - `renderClusterPage` from `relatedSearchClustersPlugin.ts` — but that
     function is not exported. **Refactor**: extract `renderClusterPage` +
     `buildClusterPath` + `buildJsonLd` into a separate module
     (`build-plugins/relatedSearchClustersRender.ts`), import from both
     the main plugin and the worker.

4. **Hub pages stay on main thread.**
   ~80 hub pages, ~5 s. Not worth parallelizing. Run after workers return.

### Validation

Same as Plan B: byte-identical output via fixture test, full CI dispatch,
sha256 sample diff.

### Risks

- **renderClusterPage extraction**: it transitively pulls in many helpers
  (chrome copy, locale shells, memoization caches). Extraction touches a
  lot of code but is mechanical — move the function + dependencies to a
  new `.ts` module.
- **memoCommuterCtx cache cross-worker**: the memoization Map can't cross
  the worker boundary directly. Each worker rebuilds its own cache. With
  ~13k contexts per worker and ~560 unique commuter contexts (per the
  May 9 memoization), each worker builds ~140 unique outputs. Total work
  goes up 4× but each is cheap (~50 ms). Net cost: ~28 s extra. Still
  worth it because per-worker rendering happens in parallel.

### Files touched

- `build-plugins/relatedSearchClustersPlugin.ts` (replace render loop with
  worker dispatch)
- `build-plugins/relatedSearchClustersRender.ts` (new — extracted from
  the main plugin: renderClusterPage, buildClusterPath, buildJsonLd, all
  COPY/CHROME constants, buildHeadline, buildDescription, helpers)
- `build-plugins/relatedSearchClustersWorker.mjs` (new, ~120 lines)

---

## Plan D — Legacy bridge case in jobsSeoPagesPlugin:2629

**Save**: ~10-15 s (small).
**Risk**: medium. Touches SPA hydration behavior on legacy slug bridges.

### What it is

`jobsSeoPagesPlugin.ts:2629` emits `_qw(legacyFlat, legacyFlatHtml)` where
`legacyFlatHtml` is the full HTML with a custom `<script>window.__BRIDGE_TARGET_SLUG__=...</script>`
injected. Per the existing comment: this lets the SPA hydrate using the
TARGET (canonical) slug when the user lands on the LEGACY (old) slug URL.

Currently:
- The legacy `index.html` carries the bridge script and the SPA hydrates
  the canonical job's data on the user's screen — UX-correct.
- The legacy `flat.html` ALSO carries the script (~30 KB), and post-walk
  converts it to a tiny redirect bridge that location.replace's to
  CANONICAL/SLASH/ — at which point the SPA on the canonical URL hydrates
  the canonical job naturally.

The flat.html script injection is wasted work — post-walk replaces the
content with a redirect bridge that doesn't carry the script. The user
reaches the canonical URL where SPA hydration uses the canonical slug
from `parseSearchSlugFilter` directly.

### Implementation

Replace `_qw(legacyFlat, legacyFlatHtml)` with `_qwFlat(legacyFlat, legacyIndexHtml)`.

The `legacyIndexHtml` (with bridge script in `<head>`) is what gets read by
post-walk's `transformFlatRedirect` to derive title + og tags for the bridge.
Title/og extraction uses regex on `<meta>` and `<title>` — bridgeScript is a
`<script>`, not affected.

### Validation

- Compare current behavior: navigate to `/cerca-lavoro-ticino/old-slug` (no
  trailing slash) on production. Should redirect to canonical.
- After change: same URL should still redirect to canonical via bridge.
- Test the SPA bridge hydration: navigate to
  `/cerca-lavoro-ticino/old-slug/` (with slash). Should serve the legacy
  index.html with bridge script, SPA hydrates canonical job data. Behavior
  unchanged.

### Risks

- **`legacyIndexHtml` is reused as the sibling reference for transformFlatRedirect.**
  Need to confirm that the legacy index.html is what post-walk reads when
  building the bridge for the legacy flat.html. Sibling = `<flat-stem>/index.html`.
  If legacy URL is `/foo-old.html` and `/foo-old/index.html` exists, sibling
  is the latter. Read confirms that's `legacyIndexHtml`. Match.

### Files touched

- `build-plugins/jobsSeoPagesPlugin.ts` (1-line change at line 2629)

---

## Plan E — Faster hash than sha1 in claim()

**Save**: ~7-10 s (small).
**Risk**: low. Internal-only hash — never exposed in any output.

### Why

`sharedWriteRegistry.ts:158` uses sha1 to detect idempotent re-claims and
collision content. Sha1 of ~30 KB content costs ~50 μs × 200 k claims ≈ 10 s.
xxhash3 is ~5× faster on the same input.

### Implementation

```bash
npm install xxhash-wasm  # ~6 KB, no native bindings
```
```ts
import xxhash from 'xxhash-wasm';
const h = await xxhash();
function hashContent(content: string): string {
  return h.h64ToString(content);
}
```

Or use `node:crypto`'s `BLAKE2b` (built-in, no dep):
```ts
function hashContent(content: string): string {
  return createHash('blake2b512').update(content).digest('hex').slice(0, 16);
}
```

BLAKE2 is ~2× faster than sha1, no dependency. Recommended.

### Validation

- 19/19 tests in `tests/shared-write-registry.test.ts` must pass.
- `dist/.write-collisions.json` schema unchanged (hash field is opaque to
  external consumers).

### Risks

None material — hash is internal.

### Files touched

- `build-plugins/sharedWriteRegistry.ts` (single function `hashContent`)

---

## Plan F — Memoize buildJobPostingSchema in soft-landing

**Save**: estimated 10-15 s. **NOT recommended** unless other plans saturate.
**Risk**: low.

### Why marginal

`buildJobPostingSchema` is called per-soft-landing (~63 k calls). Each output
is unique because it interpolates locale + canonical URL + per-job dates.
Cache hit rate would be ≈0% unless we memoize at the granularity of
"job × locale" (~19 k unique combos × 4 locales = 76 k). The current call
volume (~63 k) is already lower than that — memo doesn't help.

A more targeted micro-opt: pre-compute `expiredDatePosted` once per job
(currently per-locale × per-job). Save ~2 s. Sub-threshold.

**Skip this plan unless A+B+C are all done and you still want more.**

---

## Recommended sequencing

1. **Validate parallel default first.** After this commit lands, watch the
   next 2-3 cron deploys via `gh run watch`. Confirm:
   - No OOM (`exit code 137` or `Killed`).
   - Build job wall < 700 s.
   - All SEO gates pass in `validate-dist`.
   - If anything regresses, revert this commit and the others stay safe.

2. **Plan D** (legacy bridge, 1-line change, ~10-15 s save). Lowest risk;
   ship as a quick sanity-check that the bridge-direct refactor still
   works correctly with this last edge case.

3. **Plan E** (BLAKE2 hash, single-function change, ~7-10 s save).
   Trivial, no dependencies.

4. **Plan A** (post-walk targeted refactor, ~30-40 s save). Medium effort,
   biggest single win after parallel.

5. **Plan B** (workers in jobs-seo soft-landing, ~30-50 s save). Big lift
   but biggest theoretical win on the heaviest plugin.

6. **Plan C** (workers in cluster, ~40-60 s save). Last because cluster is
   already the most-optimized plugin from the inverted index work; the
   incremental win is diminishing.

Total potential additional save: **~120-180 s** on top of today's ~835 s
already shipped. Build job wall: 634 s → ~450-510 s = **~7-8 minutes**
total for the full deploy job.

## What stays in production after this loop

- Inverted index in cluster plugin (commit 119475af96).
- Cheap callSite placeholder in claim() (commit 6bc5ce76da).
- Bridge-direct emit, 17 sites + cluster (commit 45399c0779).
- Post-walk worker fast-path (commits 7a00222681 + 2bb900a615).
- Parallel plugin scheduling default (this commit).

All commits are atomic — `git revert <sha>` restores the prior behavior on
any single one. No coupling between them.
