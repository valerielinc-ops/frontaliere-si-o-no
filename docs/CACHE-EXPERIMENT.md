# Build-plugin cache experiment (Apr–May 2026)

This document records why we tried plugin-level caching, what the data showed,
and why we reverted to plain regeneration. Keep it so we don't redo the same
mistake.

## TL;DR

- Plugin-level cache was added in waves: salary-hub + health-premiums first,
  then 5 SEO landings, then 8 job-data-driven plugins (16 cached plugins
  total).
- After full rollout, real-world deploy timings showed the cache was costing
  **~11 minutes per deploy more than just regenerating from scratch**.
- Root causes: the I/O of restoring 200,000+ HTML files from cache was slower
  than fresh generation, the GH Actions cache `Post Cache` step took ~6 min
  to tar+upload the 982 MB tarball, and the largest plugin (`jobs-seo-pages`)
  invalidated every ~3 hours via the GSC orphan-sync cron.
- Removed the plugin cache entirely. Kept the assemble-jobs cache (small,
  fast, net-positive).

## What we measured (deploy 25330605362, May 4 2026)

GH Actions deploy run with the **fix** that finally made `actions/cache@v5`
upload after every run (key included `${{ github.run_id }}`). Build wall-clock
in steady state: 638s.

| Step | Wall-clock |
|---|---:|
| Restore build-plugin tarball (download 982 MB) | 106s |
| Build (plugins run, with HIT/MISS mix) | 638s |
| Pack `dist/` into Pages tar | 46s |
| Upload Pages artifact | 120s |
| Deploy to GitHub Pages | 168s |
| **Post Cache build-plugin** (tar + zstdmt + upload 982 MB) | **~360s (~6 min)** |
| **Total deploy wall-clock** | **~29 min** |

### Per-plugin behavior on a typical mixed deploy

8 HIT, 8 MISS. The 8 MISS were all jobs-data-driven plugins (jobs.json or
GSC orphan files churned between deploys).

```
[cache] salary-hub-seo:        HIT  (3,473 files restored in 438s)
[cache] health-premiums:       HIT  (733 files restored in 303s)
[cache] profession-landings:   HIT  (81 files in 36s)
[cache] career-landings:       HIT  (33 files in 36s)
[cache] cost-of-living:        HIT  (49 files in 38s)
[cache] nursing-landings:      HIT  (25 files in 36s)
[cache] faq-hub:               HIT  (9 files in 36s)
[cache] fr-salaire-net:        HIT  (3 files in 32s)
[cache] jobs-seo-pages:        MISS  (snapshot 204,899 files in 472s)
[cache] weekly-employers:      MISS  (snapshot 237 files in 286s — anomalous, normally 49s)
[cache] job-market-snapshot:   MISS  (snapshot 93 files in 44s)
[cache] market-report:         MISS  (snapshot 9 files in 34s)
[cache] annual-report:         MISS  (snapshot 11 files in 38s)
[cache] comparisons-hub:       MISS  (snapshot 9 files in 35s)
[cache] job-sector-pages:      MISS  (snapshot 81 files in 35s)
[cache] job-recency-pages:     MISS  (snapshot 17 files in 35s)
```

### Comparison with no cache (estimated)

| Plugin | HIT restore | Fresh generate (estimated) | Cache benefit? |
|---|---:|---:|:--:|
| salary-hub-seo | 438s | ~370s | ❌ slower with cache |
| jobs-seo-pages | ~470s (when HIT) | ~300s (gen only, no snapshot) | ❌ slower with cache |
| health-premiums | 303s | ~290s | ≈ break-even |
| 13 small plugins (≤100 files each) | 30–50s avg | 30–50s | ≈ break-even |

The two largest plugins were **slower on cache HIT than fresh generate**: the
disk I/O of restoring thousands of small files dominated, and beat the actual
rendering work.

## Why MISSes were so frequent

Every plugin's cache key was a SHA-256 of:
1. esbuild bundle hash of the plugin's `.ts` entry (catches TS edits)
2. Content hash + length of every runtime data file declared in
   `runtimeFiles`
3. An optional `extraKey` (used for day-granular date stamps)

For job-data-driven plugins, `runtimeFiles` always included `data/jobs.json`
(or one of its derivatives like `data/jobs-stats.json`,
`data/all-known-job-slugs.json`, `data/orphan-indexed-job-slugs.json`,
`data/seo-404-compat-paths.json`). Those files churned via:

- `chore: sync GSC orphan slugs and reconcile job data` cron (~every 3h)
- `🌐 Auto-translate pending jobs` cron (5×/day)
- New article publishes (every 15 min, but only invalidate jobs-seo if blog
  data was in `runtimeFiles`)
- Crawler runs (`orchestrate-crawlers`, twice/day)

Net result: jobs-seo and the 7 sibling job-data-driven plugins MISSed on a
~3-hour cadence even with everything else identical.

## The bugs we fixed along the way

The following fixes are still valuable lessons even now that the cache is
gone — they apply to the assemble-jobs cache and any future caching attempt:

1. **`actions/cache@v5` skips upload when the key already exists** —
   commit `ec50c708a5`. Without `${{ github.run_id }}` appended to the key,
   every deploy after the first one with a given hashFiles result computes
   the same key, sees it in the cache backend, and silently skips upload.
   Locally-snapshotted MISS results were thrown away with the runner. Always
   add `${{ github.run_id }}` (or another always-unique discriminator) and
   use `restore-keys` for fallback.

2. **Content-hash, not mtime+size** — commit `c202e80d5e`. The
   assemble-jobs fingerprint originally hashed `mtimeMs + size` of the 475
   slice files. `actions/checkout@v4` resets every file's mtime to checkout
   time on every CI run, so the key changed on every deploy regardless of
   content. Always content-hash files in CI cache keys.

3. **Day-quantize timestamps that get committed back** — commit
   `54f1c35137`. `data/previous-slug-winners.json` was committed back to the
   repo at every deploy with millisecond-precision `lastSeenAt` timestamps.
   Even with content hashing, every entry "changed" on every deploy → cache
   churn. Round to UTC midnight.

4. **Preserve mtime when restoring cached outputs** — commit `5901f104fe`.
   Even with content-hash fingerprinting, leaving fresh mtimes on
   restored files trips up downstream tools that watch mtime. Cheap to
   preserve, harmless when not needed.

## What we kept

`scripts/assemble-jobs-dataset.mjs` still has its content-addressable cache:

- **Inputs**: 475 crawler slice files in `data/jobs/by-crawler/`,
  `data/jobs/expired/by-crawler/`, `data/jobs-crawler-summaries/by-crawler/`.
  Total ~47 MB.
- **Outputs**: 5–7 derived JSON files (`data/jobs.json`, `expired-jobs.json`,
  `jobs-meta.json`, `jobs-crawler-summaries.json`, optionally
  `jobs-stats.json` and 2 public/ copies). Total ~28 MB tarball.
- **Hit cost**: 0.03s restore, 1s download.
- **Miss cost**: ~60s assembly + 1s upload.
- **Hit rate in practice**: high (~90%+ when slices unchanged between deploys).

Net win: ~60s saved per HIT day, no harm on MISS days. Keep it.

## What was deleted

- `build-plugins/shared/buildCache.ts` — entire helper module
- `tests/build-plugins/buildCache.test.ts` — test for the helper
- `.github/workflows/verify-build-cache.yml` — drift-detection workflow that
  built twice per week and diffed `dist/` byte-by-byte
- `.github/workflows/deploy.yml` `Cache build-plugin snapshots` step — the
  GH Actions cache wrapper for `.cache/build-plugins/`
- `WriteCollectorOptions.pathRecorder` in `build-plugins/batchWrite.ts` —
  optional callback used only by the cache to track plugin outputs
- `runCached(...)` wrapper calls in 16 plugin files (mass unwrap)
- 4 dead `*RuntimeFiles(rootDir)` helpers in
  `annualReportPlugin.ts`, `marketReportPlugin.ts`,
  `jobMarketSnapshotPlugin.ts`, `weeklyEmployersPlugin.ts`

## When (if ever) to revisit caching

A future caching attempt should only consider it when **at least one** of
these is true:

- Plugin generation is genuinely expensive (>60s of CPU work, not just I/O)
- Plugin output is small (<100 files, total <50 MB) so restore is faster
  than regenerate
- Plugin inputs are stable across the typical deploy frequency

The right model for high-volume per-item plugins (like jobs-seo with 200k
pages) is per-item incremental cache, not whole-plugin cache. That was the
"Phase 3" we deferred — and may still be the right answer if the SEO HTML
generation becomes a real bottleneck. Until then, full regeneration is the
simplest correct thing.

---

## Round 2 — `cluster-pages` cache (May 9 2026)

The `relatedSearchClustersPlugin` had its own GH Actions cache wrapper around
`.cache/related-search-clusters/` (added independently of the Apr–May
plugin-level rollout). Profiling 5 recent deploys showed the same anti-pattern
returning under a different name.

### What we measured (deploy 25581472175, May 8 2026)

Build job total: **2968s = 49m 28s** (cluster-pages cache MISS).

| Step | Wall-clock |
|---|---:|
| Cluster-pages cache RESTORE | 265s |
| Vite transform + bundle | 133s |
| `related-search-clusters` plugin (52,773 cluster pages emitted) | 652s |
| `jobs-seo-pages` plugin | 349s |
| `post-walk-coordinator` (555k file scan, 4 workers) | 99s |
| Other 42 closeBundle plugins combined | ~82s |
| Pages artifact tar + upload (1.87 GB) | 188s |
| **Cluster-pages cache POST (tar+zstd of ~106k files → 844 MB)** | **~1020s (17 min)** |

The cache POST alone was longer than the plugin's own emit phase.

### Why HIT-rate is structurally low

The GH Actions cache key hashes `data/jobs.json` (among other inputs).
`data/jobs.json` is regenerated by `scripts/assemble-jobs-dataset.mjs` on
every build — and the slice files it reads are touched by the cron crawlers
multiple times per day. **Only blog/code-only pushes can produce a HIT**;
those are ≈20% of all pushes.

Hot run (25578242561): plugin emit drops to 28s via the in-process hash-skip.
Cold runs (4/5): 652s emit + ~17 min POST = ~28 min net penalty per build.

### Net cost model

Expected per-build overhead =
0.2 × (3 min cache I/O − 10 min skipped emit) +
0.8 × (4.4 min restore + 17 min POST + 0 work avoided)
= **+15.6 min/build mediated**

### The accumulation bug (worth noting)

`saveToCache` in `relatedSearchClustersPlugin.ts` only wipes the same-key
subdirectory before writing; it never prunes sibling subdirectories from
prior runs. Combined with `restore-keys: cluster-pages-${{ runner.os }}-`,
each MISS run inherits the previous run's `{old-key}/files/` AND adds a new
`{new-key}/files/`, so the tarball compressed by Post Cache was effectively
**two complete cluster trees, not one**. This explained the 844 MB compressed
size vs. the ~422 MB you would expect for a single tree, and the 17-min POST
duration. We did not fix this bug — instead removed the cache entirely
(below).

### What we did (May 9 2026)

- Removed the `Cache related-search cluster pages` step from
  `.github/workflows/deploy.yml`.
- Set `RELATED_SEARCH_CLUSTERS_NO_CACHE=1` in the Build env so the plugin's
  internal `tryRestoreFromCache`/`saveToCache` paths are short-circuited on
  CI (the on-disk `.cache/...` directory is throwaway on the ephemeral
  runner; writing 106k cached HTML copies via `fs.copyFileSync` is pure
  waste). Local dev still benefits from the internal cache because the env
  flag is unset there.
- Added a build-job wall-clock total to the GH summary so this kind of
  regression is visible without parsing logs by hand.

### Lesson reinforced

The `cluster-pages` case is a **carbon copy** of the May 4 finding:
- High file count (~106k) inflates tar+zstd cost beyond regeneration cost.
- Frequent input churn (`data/jobs.json`) drives HIT rate below 50%.
- High-frequency MISS × expensive POST = strictly worse than no cache.

The "When to revisit caching" rules above already covered this case; we
just didn't apply them to a cache that pre-dated the Apr 2026 rollout.
Future addition: any new GH Actions cache step that wraps a directory with
>10k files OR >100 MB compressed output requires an explicit ROI memo
referencing this doc before it can ship.
