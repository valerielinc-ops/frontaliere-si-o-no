# Audit-runner worker_threads parallelism — design doc

**Status**: Designed, not implemented. Documented as actionable TODO.

## Goal

Reduce `audit:all` wall time on CI (currently 363 s on the ubuntu-latest free
runner, 650 k HTML files) by parallelizing the per-file collect phase across
N `worker_threads`. Projected: 363 s → ~120-150 s with 4 workers (~50-60 %
reduction). Net validate-dist wall time: 11.5 min → ~8.5-9 min.

## Why not implemented now (2026-05-19)

Three real costs vs the projected benefit:

1. **Merge protocol surface**: each of the 11 audits needs a `merge(partials)`
   method. Most are concat-based and trivial, but two are subtle:
   - `text-html-ratio`: per-feature offender counts trigger baseline ratchets.
     Partials need to surface per-feature breakdowns AND raw byte counts so
     main can recompute `byFeature` deterministically.
   - `content-duplicates`: cross-file state (hash → paths map). Workers each
     produce their own partial map. Merge must union them THEN re-cluster
     (a hash that appears in 2 workers each with 1 page is actually a
     2-page duplicate cluster). Cluster threshold check moves from
     collect to merge.

2. **Baseline-ratchet false-positive risk**: if any merge has an off-by-one
   bug (per-feature counts), the deploy fails with a baseline-regression
   that wasn't in the dist. Hard to debug from CI logs alone.

3. **Diminishing returns**: validate-dist is already 60 % faster than
   pre-L3 (29 min → 11.5 min). The remaining 3 min saved here is real but
   the engineering cost (~4-7 hours including testing on real CI) is high
   relative to the user-facing benefit.

## Architecture (when ready)

### Worker entry script: `scripts/lib/audit-runner-worker.mjs`

```mjs
import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { sharedExtract } from './audit-runner.mjs';

const { files, auditorFactoriesByName } = workerData;

// Reconstruct auditors from their factory module paths (sent as strings
// because functions aren't structured-clone-able).
const auditors = await Promise.all(
  auditorFactoriesByName.map(async ({ name, modulePath }) => {
    const mod = await import(modulePath);
    return mod.factory();
  }),
);

for (const file of files) {
  let html;
  try { html = await readFile(file, 'utf8'); }
  catch { continue; }
  for (const auditor of auditors) {
    try { auditor.collect(file, html); } catch (err) {
      parentPort.postMessage({ type: 'error', auditor: auditor.name, file, error: err.message });
    }
  }
}

const partialReports = [];
for (const auditor of auditors) {
  partialReports.push({ name: auditor.name, partial: await auditor.report() });
}
parentPort.postMessage({ type: 'done', partialReports });
```

### Main runner: `scripts/lib/audit-runner.mjs` updates

```mjs
export async function runAudits({ distDir, auditors, workers = 0, ... }) {
  const N = Number(process.env.AUDIT_WORKERS ?? workers ?? 0);
  if (N <= 0) {
    // Original single-process path (unchanged).
    return runAuditsSingleProcess({ distDir, auditors, ... });
  }
  // Verify every auditor has merge() before splitting work.
  for (const a of auditors) {
    if (typeof a.merge !== 'function') {
      throw new Error(`auditor ${a.name} missing merge(partials) — refusing to run with AUDIT_WORKERS=${N}`);
    }
  }
  const files = await walkHtmlFiles(distDir);
  const chunks = chunkBySize(files, N);
  const workersResults = await Promise.all(
    chunks.map((chunk) => runWorker(chunk, auditorFactoriesByName)),
  );
  // Group partials by audit name
  const byAudit = new Map();
  for (const result of workersResults) {
    for (const { name, partial } of result.partialReports) {
      if (!byAudit.has(name)) byAudit.set(name, []);
      byAudit.get(name).push(partial);
    }
  }
  // Merge per audit
  const finalReports = [];
  for (const a of auditors) {
    const partials = byAudit.get(a.name) ?? [];
    const merged = a.merge(partials);
    finalReports.push({ name: a.name, ...merged });
  }
  return { reports: finalReports, /* ... timing aggregates ... */ };
}
```

### Auditor.merge protocol

Every Auditor MUST implement `merge(partials: AuditorResult[]): AuditorResult`
when `AUDIT_WORKERS > 0`. Protocol:

```ts
interface AuditorResult {
  passed: boolean;
  offendersTotal: number;
  offenders: any[];
  threshold?: { metric, value, comparator } | null;
  baselineFile?: string | null;
  baselineDelta?: { before, after, regression } | null;
  byFeature?: Record<string, number>;
  extra?: Record<string, unknown>;
  humanSummary?: string;
}

interface Auditor {
  name: string;
  collect(file: string, html: string): void;
  report(): AuditorResult;
  merge?(partials: AuditorResult[]): AuditorResult;  // ← NEW (optional)
}
```

### Per-audit merge implementations

| Audit | Merge complexity | Logic |
|---|---|---|
| footer-root-presence | trivial | concat offenders, sum extra.scanned |
| jsonld-no-nested-scripts | trivial | concat offenders, sum extra.scanned |
| salary-landing-template | trivial | concat offenders, sum extra.scanned |
| page-weight | low | concat structured offenders, sum byFeature |
| faqpage-validity | low | concat offenders, UNION filesByDefect sets |
| image-object-license | low | concat offenders, UNION fileSet |
| title-length | medium | concat offenders, SUM byFeature + byLocale, recompute baselineDelta from total |
| title-no-disambig-hash | medium | same as title-length |
| h1-title-duplicates | medium | same as title-length |
| **text-html-ratio** | **high** | partials must carry raw sample counts + byFeature; recompute baselineDelta |
| **content-duplicates** | **high** | partials carry hash → paths arrays; UNION maps, re-cluster, recount |

## Implementation checklist (for future agent)

- [ ] Add `merge?(partials)` to scripts/lib/audit-runner.mjs Auditor JSDoc type
- [ ] Implement worker entry script
- [ ] Add `AUDIT_WORKERS` env handling in runAudits
- [ ] Write `chunkBySize(files, N)` helper
- [ ] Implement merge() in 11 audit files (start with trivials, end with text-html-ratio + content-duplicates)
- [ ] Unit tests for each merge() — compare worker output vs single-process output on identical fixtures
- [ ] Integration test: run audit:all with AUDIT_WORKERS=4 vs AUDIT_WORKERS=0 on local dist, verify per-audit report deep-equal
- [ ] Update post-deploy-validate-dist.yml: set AUDIT_WORKERS env (start 2, then 4 if stable)
- [ ] Document `AUDIT_WORKERS` in CLAUDE.md alongside `npm run audit:all`

## Estimated effort

- Infrastructure (worker spawn, chunking, message passing): 1-2 h
- Trivial-merge audits (6 audits): 1 h
- Medium-merge audits (3 audits): 1-2 h
- text-html-ratio + content-duplicates: 1-2 h
- Tests + CI integration: 1-2 h

**Total: 5-9 hours focused work** by an agent familiar with all 11 audit
report shapes.

## Verification harness

`scripts/verify-l3-worker-equivalence.mjs` should compare:
- audit:all single-process report (control)
- audit:all with AUDIT_WORKERS=4 report (treatment)

Bar: every audit's `passed`, `offendersTotal`, `byFeature` counts and
`baselineDelta.regression` must be identical. Differences indicate merge
bugs.

## Why this design defers per-audit-tier worker support

A simpler design would be: some audits run in workers, some in main.
Skip the complex ones (text-html-ratio, content-duplicates) for now.

Rejected because:
1. The "complex" audits are the slowest. Running them in main while
   workers handle the simple ones means the wall time is bounded by
   the complex audits — the same single-process bottleneck we have today.
2. Split execution doubles the code surface (two collect loops, two
   report aggregators) for incremental benefit.
3. Once merge() exists for the complex audits, the simple-audit merges
   are nearly free. All-or-nothing is the cleaner architecture.

## Open questions for the implementer

- Should workers share a SQLite or LMDB for the content-duplicates hash
  map, or pass raw arrays through postMessage? Raw arrays at 650k files
  × ~256 bytes per record = 170 MB IPC payload. SQLite might be cheaper
  but adds a runtime dep.
- AUDIT_STRICT mutation detection per worker or only in main? Probably
  per worker (cheap), with a final cross-worker consistency check.
- What if a worker crashes mid-walk? Retry the chunk, fail the run, or
  partial-succeed? Probably fail-fast with the chunk index logged.

---

This design captures the 5-9 hour TODO so the next agent (human or AI)
can pick it up without re-discovering the architecture.
