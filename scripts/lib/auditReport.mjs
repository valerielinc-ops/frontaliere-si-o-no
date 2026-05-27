// scripts/lib/auditReport.mjs
//
// Shared writer for structured audit reports.
//
// Every `npm run audit:*` / `npm run validate:*` gate emits a JSON report at
// `dist/audit-reports/<audit-name>.json` (always — pass or fail) so:
//
//   1. CI workflows can upload `dist/audit-reports/**` as a single artifact
//      on failure, giving parallel debug agents a complete, structured signal
//      without needing to re-run scripts against a freshly-built dist.
//   2. Run-over-run diffs become trivial: each report has the same shape
//      regardless of which audit produced it.
//
// Purely additive — never changes exit codes, baselines, or fail/pass logic.
// The caller still owns the threshold + ratchet check; this module only
// receives the already-computed verdict and offender list and persists it.
//
// Schema (one file per audit, paired with its npm-script name):
//
//   {
//     "audit":         "page-weight",
//     "ranAt":         "2026-05-12T18:42:00.000Z",
//     "passed":        false,
//     "threshold":     { "metric": "bytes", "value": 204800, "comparator": "<=" } | null,
//     "baselineFile":  "data/page-weight-baseline.json" | null,
//     "baselineDelta": { "before": 0, "after": 12, "regression": 12 } | null,
//     "offendersTotal": 12,
//     "byFeature":     { "job-board": 7, "spa-locale": 5 },
//     "topOffenders":  [ { "path": "...", "feature": "...", "metric": 200157, "ratio": null }, ... ]
//   }
//
//   - `metric` carries whatever the audit measures (bytes for page-weight,
//     ratio for text-html-ratio, depth for bfs-depth, count for orphans).
//   - `ratio` is only set when meaningful (currently text-html-ratio).
//   - `topOffenders` is capped at 100 entries to keep individual report files
//     well under 1 MB even on regression-heavy runs.
//
// Performance: the writer does NOT walk dist/. Callers pass a pre-built
// offenders array — typically the same one they already iterate to print the
// human summary — so the additional cost is one JSON.stringify + write.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

export const AUDIT_REPORTS_DIR = join(ROOT, 'dist', 'audit-reports');

/** Cap on `topOffenders.length` written to disk. Keeps individual reports
 *  small enough to upload as artifacts cheaply on the GitHub Actions free
 *  tier. The full offender list still goes to stdout via each audit's own
 *  rich regression-dump block — this file is only the structured summary. */
const TOP_OFFENDERS_LIMIT = 100;

/**
 * Resolve the destination path for an audit's JSON report.
 * Exposed so callers can mention the path in their human-readable output.
 *
 * @param {string} audit
 * @returns {string} absolute path
 */
export function auditReportPath(audit) {
  if (!audit || typeof audit !== 'string') {
    throw new TypeError('auditReportPath: `audit` must be a non-empty string');
  }
  const safe = audit.replace(/[^a-z0-9_.-]/gi, '-');
  return join(AUDIT_REPORTS_DIR, `${safe}.json`);
}

/**
 * Write a structured report for one audit run.
 *
 * Always writes — both on pass and on fail — so CI can diff runs and so
 * `if: failure()` artifact uploads pick up *any* report that was produced
 * in the failing job, not just the one that failed.
 *
 * Never throws. If the filesystem write fails the error is logged to stderr
 * and the function resolves; an audit's exit code must never depend on the
 * report writer.
 *
 * @param {object} params
 * @param {string} params.audit                          npm-script name, e.g. "page-weight"
 * @param {boolean} params.passed                        gate verdict from the caller
 * @param {{ metric: string, value: number|string, comparator: string }|null} [params.threshold]
 * @param {string|null} [params.baselineFile]            repo-relative baseline path
 * @param {{ before: number, after: number, regression: number }|null} [params.baselineDelta]
 * @param {Array<{ path: string, feature?: string, metric: number|string, ratio?: number|null, [k:string]: unknown }>} [params.offenders]
 *        full offender list; the helper slices the worst N for `topOffenders`.
 *        Pre-sort by severity (worst first) — the helper preserves order.
 * @param {Record<string, number>} [params.byFeature]    optional pre-computed
 *        breakdown; if omitted, derived from `offenders[].feature`.
 * @param {object} [params.extra]                        free-form extra fields
 *        merged at the top level (e.g. `psiRaw` for CLS, sitemap names for
 *        bfs-depth). Reserved field names are not allowed.
 * @returns {Promise<string|null>} resolved path on success, null on write failure
 */
export async function writeAuditReport(params) {
  const {
    audit,
    passed,
    threshold = null,
    baselineFile = null,
    baselineDelta = null,
    offenders = [],
    byFeature: byFeatureOverride,
    extra = {},
  } = params || {};

  if (!audit || typeof audit !== 'string') {
    process.stderr.write('[auditReport] skipped — missing `audit` name\n');
    return null;
  }

  // Derive per-feature breakdown when the caller didn't provide one.
  /** @type {Record<string, number>} */
  let byFeature;
  if (byFeatureOverride && typeof byFeatureOverride === 'object') {
    byFeature = { ...byFeatureOverride };
  } else {
    byFeature = {};
    for (const o of offenders) {
      const f = (o && typeof o === 'object' && typeof o.feature === 'string') ? o.feature : 'unknown';
      byFeature[f] = (byFeature[f] ?? 0) + 1;
    }
  }

  const topOffenders = offenders.slice(0, TOP_OFFENDERS_LIMIT).map((o) => {
    if (!o || typeof o !== 'object') return { path: String(o), metric: null };
    const out = {
      path: typeof o.path === 'string' ? o.path : (typeof o.file === 'string' ? o.file : ''),
      feature: typeof o.feature === 'string' ? o.feature : null,
      metric: o.metric ?? null,
      ratio: typeof o.ratio === 'number' ? o.ratio : null,
    };
    // Carry through any extra per-offender fields (preserves richer context
    // like `missing`, `tag`, `sitemap`, `depth` etc.) without forcing every
    // audit through a rigid schema.
    for (const [k, v] of Object.entries(o)) {
      if (k in out) continue;
      if (k === 'file') continue; // already mapped to `path`
      out[k] = v;
    }
    return out;
  });

  const report = {
    audit,
    ranAt: new Date().toISOString(),
    passed: Boolean(passed),
    threshold: threshold ?? null,
    baselineFile: baselineFile ?? null,
    baselineDelta: baselineDelta ?? null,
    offendersTotal: offenders.length,
    byFeature,
    topOffenders,
    ...extra,
  };

  const outPath = auditReportPath(audit);
  try {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    return outPath;
  } catch (err) {
    process.stderr.write(`[auditReport] failed to write ${outPath}: ${err?.message ?? err}\n`);
    return null;
  }
}

/**
 * Resolve a baseline path (absolute or repo-relative) to a repo-relative
 * string suitable for the `baselineFile` field. Returns `null` for missing
 * inputs so callers can pass through without conditionals.
 *
 * @param {string|null|undefined} p
 * @returns {string|null}
 */
export function relBaseline(p) {
  if (!p || typeof p !== 'string') return null;
  const abs = isAbsolute(p) ? p : join(ROOT, p);
  return abs.startsWith(ROOT + '/') ? abs.slice(ROOT.length + 1) : abs;
}
