# Build + audit optimization — baseline measurements (2026-05-19)

Baseline numbers locked in **before** L1+L2+L3 optimization rollout. Each
phase commits a delta against these.

## Environment

- Local dev machine (Darwin 25.2.0, Apple Silicon)
- Cores: `sysctl hw.ncpu` (Mac default 8-10 perf+efficiency)
- Storage: APFS local SSD
- `dist/`: 81.684 HTML files / 2.1 GB (local FAST_BUILD output, partial coverage)
- Production `dist/`: 650.257 HTML files / 8.2 GB (downloaded artifact reference)
- Linear scaling factor local→prod: ~8× on file count, ~4× on bytes

CI runner (estimated, from `post-deploy-validate-dist.yml` comments):
- ubuntu-latest free, 7 GB RAM, 2-4 vCPU
- Memory-constrained: forced `MAX_PARALLEL=1` to avoid OOM when running
  multiple dist-walking audits concurrently (1-3 GB RSS per process)

## L3 — Audit pipeline baseline

Six audits running sequentially as independent Node processes (current
behavior of `post-deploy-validate-dist.yml`):

| Audit | Local wall time (s) |
|---|---|
| `audit-text-html-ratio` | 58.34 |
| `audit-title-length` | 36.05 |
| `audit-h1-title-duplicates` | 29.20 |
| `audit-footer-root-presence` | 28.96 |
| `audit-title-no-disambig-hash` | 28.60 |
| `audit-jsonld-no-nested-scripts` | 28.17 |
| **Sequential total (6 audits)** | **209.32** |

Extrapolated to CI dist (650k files):
- Local: ~30s per audit average on 82k files
- CI scaling: ~8× file count → ~240s per audit → ~24 min total sequential

Matches the empirical "10-12 min chain" reported in `post-deploy-validate-dist.yml`
since the chain only runs 4-7 audits with OS page-cache warm-up amortizing
the walk cost across consecutive audits in the same shell.

## L3 — Phase 1 measurement (3 audits migrated)

Migrated to unified runner (`scripts/audit-all.mjs`):
- `audit-footer-root-presence`
- `audit-jsonld-no-nested-scripts`
- `audit-title-length`

Run via `node scripts/audit-all.mjs`:

| Mode | Wall time (s) | Notes |
|---|---|---|
| Sequential (baseline sum, warm cache) | **93.18** | sum of standalone runs |
| Unified runner (warm cache) | **39.73** | single Node process, single walk |
| **Speedup** | **2.35×** | with 3 audits |

Walk breakdown:
- File walk (`readdir` traversal): 13.36s
- File read + collect (`readFile` + 3 audit regex per file): 26.25s

The walk is roughly equivalent to ONE original audit's wall time. Adding
more audits to the unified runner barely increases total time (each audit's
regex is microseconds per file in memory, dominated by file I/O which is
already done once).

## Extrapolated win (full 6-audit migration)

Linear projection: with 6 audits in the unified runner, wall time stays ≈
walk time + N×regex (where N×regex is tiny). Expected:

| Audits in runner | Sequential baseline | Unified runner | Speedup |
|---|---|---|---|
| 2 | 57.13s | ~31s | ~1.8× |
| 3 | 93.18s | **39.73s (measured)** | **2.35×** |
| 6 (projected) | 209.32s | ~45-50s | **~4-5×** |

CI estimate post-full-migration (650k files):
- Today: ~25-45 min for the dist-walking chain
- After L3 full: ~5-8 min
- **Wall-time reduction: -70/80%**

## L1 + L2 baselines (TODO — measured in subsequent phases)

- `closeBundle` per-plugin timing (top-5 plugins): not yet instrumented
- `dist/` artifact total size: 8.2 GB (production reference)
- Average HTML page size: ~25 KB

These get committed when L1 and L2 ship.

## How baseline was measured

```bash
mkdir -p /tmp/audit-baseline-2026-05-19
for audit in audit-title-length audit-title-no-disambig-hash \
             audit-footer-root-presence audit-jsonld-no-nested-scripts \
             audit-h1-title-duplicates audit-text-html-ratio; do
  /usr/bin/time -p node "scripts/${audit}.mjs" \
    > "/tmp/audit-baseline-2026-05-19/${audit}.stdout" \
    2> "/tmp/audit-baseline-2026-05-19/${audit}.timing"
done
awk '/^real/ {s+=$2} END {printf "%.2f sec\n", s}' /tmp/audit-baseline-2026-05-19/*.timing
```

Unified runner measurement after cache warm-up:
```bash
node -e "import('./scripts/lib/audit-runner.mjs').then(m => m.walkHtmlFiles('dist'))" > /dev/null
/usr/bin/time -p node scripts/audit-all.mjs
```
