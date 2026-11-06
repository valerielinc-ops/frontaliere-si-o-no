/**
 * Verdict hand-off for the `RUN_DIST_GATES=1` mirrors of audit-all auditors.
 *
 * `tests/seo/breadcrumb-coverage.test.ts`, `tests/seo/faqpage-validity.test.ts`
 * and `tests/seo/image-object-license-fields.test.ts` assert the SAME
 * invariant as the auditors `breadcrumb-coverage`, `faqpage-validity` and
 * `image-object-license` in `scripts/audit-all.mjs`. Since #14517 the report
 * job (`audit-dist-from-run.yml`) sets `RUN_DIST_GATES=1` for every step, so
 * `gate:seo-source` turned the three mirrors back on against the rehydrated
 * corpus: 6.2M HTML files, a second, third and fourth full walk of a tree the
 * auditor had already judged in the single shared walk. Breadcrumb aborted on
 * its 240s budget after 751k files; the other two "timed out" at 300s, which
 * for a synchronous body is how vitest reports a PASS (see distHtmlScan.ts).
 *
 * The mirrors must neither skip nor lie. When `audit:all` has already written
 * its report for THIS dist (`dist/audit-reports/<auditor>.json`, newer than
 * the dist itself), the mirror asserts that verdict — same invariant, same
 * files, measured once — and prints sample rate and offender count. Without a
 * report it scans the tree itself, bounded (a local post-build dist is small).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface AuditAllVerdict {
  readonly audit: string;
  readonly ranAt: string;
  readonly passed: boolean;
  readonly offendersTotal: number;
  readonly sampleRate: number;
  readonly topOffenders: readonly unknown[];
}

/**
 * The audit-all report for `auditor` written against `distDir`, or null when
 * there is none (or it predates the dist, i.e. it judged another build).
 */
export function readAuditAllVerdict(distDir: string, auditor: string): AuditAllVerdict | null {
  const file = join(distDir, 'audit-reports', `${auditor}.json`);
  if (!existsSync(file)) return null;
  let report: Partial<AuditAllVerdict>;
  try {
    report = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
  if (report.audit !== auditor || typeof report.passed !== 'boolean') return null;
  const ranAt = Date.parse(String(report.ranAt ?? ''));
  if (!Number.isFinite(ranAt)) return null;
  const marker = join(distDir, 'index.html');
  if (existsSync(marker) && ranAt < statSync(marker).mtimeMs) return null;
  return {
    audit: auditor,
    ranAt: String(report.ranAt),
    passed: report.passed,
    offendersTotal: Number(report.offendersTotal ?? 0),
    sampleRate: Number(report.sampleRate ?? 1),
    topOffenders: Array.isArray(report.topOffenders) ? report.topOffenders : [],
  };
}

/** One-line, always-printed account of the verdict the mirror relied on. */
export function describeAuditAllVerdict(v: AuditAllVerdict): string {
  return (
    `[${v.audit}] audit:all verdict on this dist (ranAt ${v.ranAt}): ` +
    `passed=${v.passed} offenders=${v.offendersTotal} sampleRate=${v.sampleRate}`
  );
}
