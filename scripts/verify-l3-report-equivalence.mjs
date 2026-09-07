#!/usr/bin/env node
/**
 * verify-l3-report-equivalence.mjs
 *
 * Validates that the unified runner (`npm run audit:all`) produces the
 * SAME audit reports as the legacy per-audit `npm run audit:<name>` calls
 * when both run against the same dist artifact.
 *
 * Strategy:
 *   1. Save the legacy report files (if any) in dist/audit-reports/ into
 *      reports_legacy/.
 *   2. Run `npm run audit:all`. The runner writes fresh JSON reports to
 *      dist/audit-reports/.
 *   3. Compare report-by-report:
 *      - `passed` flag identical
 *      - `offendersTotal` identical
 *      - `topOffenders[].path` set identical (order may differ; we compare sets)
 *      - `byFeature` counts identical (ignoring keys with 0 in either side,
 *        and skipping the buckets a `byFeatureTruncated` fold makes
 *        non-comparable — reported as notes, not failures)
 *      - `baselineDelta.regression` identical
 *      Non-deterministic fields (`ranAt`) are stripped before compare.
 *   4. Print pass/fail per audit + first 3 differences for any failure.
 *
 * Usage:
 *   # Sequence 1 — capture legacy reports from individual audit runs
 *   npm run audit:text-html-ratio && npm run audit:h1-title-duplicates && …
 *   cp -r dist/audit-reports /tmp/reports_legacy
 *
 *   # Sequence 2 — run unified, then verify
 *   npm run audit:all
 *   node scripts/verify-l3-report-equivalence.mjs --legacy=/tmp/reports_legacy
 *
 * Exit:
 *   0 — every report matches
 *   1 — at least one report differs (paths + first diffs printed)
 *   2 — missing inputs or fatal error
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs() {
  const out = new Map();
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out.set(k, v ?? true);
    }
  }
  return out;
}

function normalizeReport(r) {
  if (!r || typeof r !== 'object') return r;
  const { ranAt, ...rest } = r;
  // Drop non-deterministic timestamp; keep everything else.
  return rest;
}

function setOfOffenderPaths(report) {
  const arr = Array.isArray(report?.topOffenders) ? report.topOffenders : [];
  return new Set(arr.map((o) => (typeof o?.path === 'string' ? o.path : '')).filter(Boolean));
}

/**
 * The sentinel key an audit folds its `byFeature` tail into once the breakdown
 * exceeds its own group cap (`audit-spa-bundle-injection`'s GROUP_OVERFLOW_KEY).
 * `byFeature` keys are opaque labels, not paths — see the schema note in
 * scripts/lib/auditReport.mjs.
 */
const OVERFLOW_KEY = '<other>';

/** True when a report declares its `byFeature` breakdown folded. */
function isFolded(report) {
  return report?.byFeatureTruncated === true
    || typeof report?.byFeature?.[OVERFLOW_KEY] === 'number';
}

/**
 * Compare two `byFeature` breakdowns.
 *
 * A per-key delta only means something when both sides put that key in the SAME
 * bucket, and a folded breakdown breaks that (same reasoning as the baseline
 * comparison in scripts/audit-spa-bundle-injection.mjs, follow-up of #7679):
 *
 *   • `<other>` folds the tail of THIS run's key set; the other side folded the
 *     tail of a different one, so the two buckets never describe the same
 *     areas. Against an unfolded side there is no `<other>` entry at all and
 *     `?? 0` reads the whole fold as a difference.
 *   • a key ABSENT from a folded side means either "0 there" or "inside that
 *     side's own `<other>`", and the report cannot tell the two apart.
 *
 * Neither is a legacy-vs-unified divergence, so both are reported as notes and
 * never fail the run. Keys present on both sides carry exact retained counts
 * and are still compared exactly as before.
 *
 * @returns {{ issues: string[], notes: string[] }}
 */
function diffByFeature(af, bf, aFolded, bFolded) {
  const issues = [];
  const notes = [];
  const allKeys = new Set([...Object.keys(af), ...Object.keys(bf)]);
  for (const k of allKeys) {
    if ((aFolded || bFolded) && k === OVERFLOW_KEY) {
      notes.push(`byFeature["${OVERFLOW_KEY}"]: not compared — the two overflow buckets fold different key sets`);
      continue;
    }
    const inA = typeof af[k] === 'number';
    const inB = typeof bf[k] === 'number';
    if (!inA && aFolded) {
      notes.push(`byFeature["${k}"]: not compared — absent from a folded legacy breakdown (0 or inside its ${OVERFLOW_KEY})`);
      continue;
    }
    if (!inB && bFolded) {
      notes.push(`byFeature["${k}"]: not compared — absent from a folded current breakdown (0 or inside its ${OVERFLOW_KEY})`);
      continue;
    }
    const av = af[k] ?? 0;
    const bv = bf[k] ?? 0;
    if (av !== bv) issues.push(`byFeature["${k}"]: legacy=${av} current=${bv}`);
  }
  return { issues, notes };
}

/** @returns {{ issues: string[], notes: string[] }} */
export function diffReports(legacy, current) {
  const issues = [];
  const notes = [];
  const a = normalizeReport(legacy);
  const b = normalizeReport(current);
  if (a.passed !== b.passed) issues.push(`passed: legacy=${a.passed} current=${b.passed}`);
  if (a.offendersTotal !== b.offendersTotal) {
    issues.push(`offendersTotal: legacy=${a.offendersTotal} current=${b.offendersTotal}`);
  }
  // byFeature: same set of keys with same counts (zero-count keys may differ),
  // minus the buckets a fold made non-comparable.
  const af = a.byFeature || {};
  const bf = b.byFeature || {};
  const aFolded = isFolded(a);
  const bFolded = isFolded(b);
  if (aFolded !== bFolded) {
    notes.push(`byFeature: only the ${aFolded ? 'legacy' : 'current'} breakdown is folded (byFeatureTruncated) — per-key coverage differs`);
  }
  const feature = diffByFeature(af, bf, aFolded, bFolded);
  issues.push(...feature.issues);
  notes.push(...feature.notes);
  // baselineDelta.regression
  const ar = a.baselineDelta?.regression ?? 0;
  const br = b.baselineDelta?.regression ?? 0;
  if (ar !== br) issues.push(`baselineDelta.regression: legacy=${ar} current=${br}`);
  // topOffenders path-set parity (top 100 cap from auditReport.mjs)
  const aPaths = setOfOffenderPaths(a);
  const bPaths = setOfOffenderPaths(b);
  const onlyLegacy = [...aPaths].filter((p) => !bPaths.has(p));
  const onlyCurrent = [...bPaths].filter((p) => !aPaths.has(p));
  if (onlyLegacy.length > 0 || onlyCurrent.length > 0) {
    issues.push(
      `topOffenders paths differ: ` +
      `only-in-legacy=${onlyLegacy.length} (e.g. ${onlyLegacy.slice(0, 3).join(', ')}); ` +
      `only-in-current=${onlyCurrent.length} (e.g. ${onlyCurrent.slice(0, 3).join(', ')})`,
    );
  }
  return { issues, notes };
}

async function listReports(dir) {
  const out = new Map();
  let entries;
  try { entries = await readdir(dir); } catch { return out; }
  for (const e of entries) {
    if (!e.endsWith('.json')) continue;
    const name = basename(e, '.json');
    out.set(name, join(dir, e));
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const legacyDir = args.get('legacy');
  const currentDir = args.get('current') ?? 'dist/audit-reports';

  if (!legacyDir) {
    console.error('Usage: verify-l3-report-equivalence.mjs --legacy=<dir> [--current=dist/audit-reports]');
    console.error('First capture legacy by running standalone audits, then `cp -r dist/audit-reports /tmp/reports_legacy`.');
    process.exit(2);
  }
  for (const d of [legacyDir, currentDir]) {
    const s = await stat(d).catch(() => null);
    if (!s || !s.isDirectory()) { console.error(`missing report dir: ${d}`); process.exit(2); }
  }

  const legacy = await listReports(legacyDir);
  const current = await listReports(currentDir);
  console.log(`[verify-l3] legacy reports: ${legacy.size}; current reports: ${current.size}`);

  const allNames = new Set([...legacy.keys(), ...current.keys()]);
  let failures = 0;
  const failingDetail = [];

  for (const name of [...allNames].sort()) {
    const legacyPath = legacy.get(name);
    const currentPath = current.get(name);
    if (!legacyPath) { console.log(`⚠️  ${name}: missing in legacy — skipped`); continue; }
    if (!currentPath) { console.log(`⚠️  ${name}: missing in current — skipped`); continue; }
    const a = JSON.parse(await readFile(legacyPath, 'utf8'));
    const b = JSON.parse(await readFile(currentPath, 'utf8'));
    const { issues, notes } = diffReports(a, b);
    for (const n of notes.slice(0, 5)) console.log(`   ℹ️  ${name}: ${n}`);
    if (notes.length > 5) console.log(`   ℹ️  ${name}: … and ${notes.length - 5} more non-comparable bucket(s)`);
    if (issues.length === 0) {
      console.log(`✅ ${name}: identical (passed=${b.passed}, offenders=${b.offendersTotal})`);
    } else {
      console.log(`❌ ${name}: ${issues.length} difference(s)`);
      failures++;
      failingDetail.push({ name, issues });
    }
  }

  console.log('');
  if (failures === 0) {
    console.log('PASS: every audit report is equivalent between legacy and unified runner.');
    process.exit(0);
  }

  console.error('Differences:');
  for (const { name, issues } of failingDetail) {
    console.error(`\n  ${name}`);
    for (const i of issues.slice(0, 5)) console.error(`    - ${i}`);
    if (issues.length > 5) console.error(`    ... and ${issues.length - 5} more`);
  }
  process.exit(1);
}

// Only run as a CLI. Importing the module (tests do) must not start a walk or
// call process.exit().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('verify-l3-report-equivalence: fatal', err);
    process.exit(2);
  });
}
