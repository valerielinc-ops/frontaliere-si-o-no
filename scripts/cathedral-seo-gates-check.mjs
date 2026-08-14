#!/usr/bin/env node
/**
 * cathedral-seo-gates-check.mjs — detect rebaseline opportunities + regressions.
 *
 * Runs each of the 6 SEO content gates against the freshly built `dist/` and
 * compares the current value against the committed baseline (where one
 * exists). Emits a single JSON verdict to stdout + writes
 * `data/cathedral-seo-gates-verdict.json` for the workflow to consume.
 *
 * Verdict shape:
 *   {
 *     "checkedAt": "<ISO>",
 *     "summary": { "passed": N, "improved": N, "regressed": N, "errors": N },
 *     "gates": [
 *       {
 *         "name": "text-html-ratio",
 *         "status": "pass" | "improved" | "regressed" | "error",
 *         "baseline": <number>,
 *         "current":  <number>,
 *         "delta":    <number>,        // negative = improvement
 *         "rebaselineCmd": "npm run audit:...:rebaseline",
 *         "auditCmd":     "npm run audit:...",
 *         "notes":        "..."
 *       },
 *       ...
 *     ]
 *   }
 *
 * Per CLAUDE.md non-negotiables #1 + #5, baseline widening is a deliberate
 * human action — this script NEVER mutates baselines. It only detects + reports.
 *
 * Exit codes:
 *   0 — all gates pass or improved (no regressions)
 *   1 — runtime error (missing dist, bad JSON, etc.)
 *   2 — at least one gate regressed
 */

import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Wall-clock at module load, used to reject a stale on-disk audit report.
// Floored to whole seconds because `generatedAt` is an ISO string with ms
// precision but the file can be written in the same millisecond we start.
const PROCESS_STARTED_AT = Math.floor(Date.now() / 1000) * 1000;

const VERDICT_PATH = path.join(PROJECT_ROOT, 'data', 'cathedral-seo-gates-verdict.json');

/**
 * @typedef {Object} GateSpec
 * @property {string} name
 * @property {string[]} cmd               argv to spawn
 * @property {string} auditCmd
 * @property {string} rebaselineCmd
 * @property {string|null} baselineFile   relative to repo root
 * @property {(parsed: unknown, rawStdout: string) => number} extractCurrent
 * @property {(baseline: unknown) => number} extractBaseline
 * @property {boolean} [usesOwnRatchet] true when the underlying audit script
 *   already runs its own composition-shift-aware regression check (see the
 *   doc comment on the `title-length` gate spec below) and its exit code
 *   should decide regressed/pass instead of a raw current-vs-baseline count
 *   comparison.
 * @property {boolean} [readsOwnReport] true when the underlying audit script
 *   emits no JSON to stdout at all and extractCurrent instead reads a report
 *   file directly (see the `orphan-sitemap-pages` gate spec below) —
 *   evaluateGate() must not bail out on a failed stdout JSON parse for these.
 * @property {string} notes
 */

/**
 * Offender count out of an audit's `--json` payload.
 *
 * Issue #5169: the original readers assumed `offenders` is an ARRAY and fell
 * back to `p.total`. Three of the six audits emit `offenders` as a NUMBER
 * (`result.offendersTotal` / `offenders.length` — audit-title-length.mjs:394,
 * audit-text-html-ratio.mjs:499, audit-title-no-disambig-hash.mjs:307) and
 * emit no `total` key at all, so `Array.isArray` was false, `p.total` was
 * undefined, and `current` was **0 on every run**. Paired with
 * {@link baselineOffenders} (which read `b.total`, while every baseline file
 * stores `totalOffenders`) the comparison was `0 === 0` → status `pass`,
 * permanently, whatever dist/ actually contained. Four of the six gates were
 * inert. Accept every shape the audits actually emit, and treat a payload that
 * carries none of them as an ERROR rather than silently scoring 0.
 * @param {unknown} parsed
 * @returns {number}
 */
export function currentOffenders(parsed) {
  const p = /** @type {Record<string, unknown>} */ (parsed ?? {});
  const offenders = p.offenders;
  if (Array.isArray(offenders)) return offenders.length;
  for (const key of ['offenders', 'total', 'totalOffenders']) {
    const v = p[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  throw new Error(
    `audit payload carries no offender count (keys: ${Object.keys(p).join(', ') || 'none'})`,
  );
}

/**
 * Offender count out of a committed baseline file. Every rate-based baseline
 * writes `totalOffenders` (audit-title-length.mjs:199 and siblings); `total` is
 * accepted for any older/hand-written file. See {@link currentOffenders}.
 * @param {unknown} baseline
 * @returns {number}
 */
export function baselineOffenders(baseline) {
  const b = /** @type {Record<string, unknown>} */ (baseline ?? {});
  for (const key of ['totalOffenders', 'total']) {
    const v = b[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  throw new Error(
    `baseline carries no offender count (keys: ${Object.keys(b).join(', ') || 'none'})`,
  );
}

/** @type {GateSpec[]} */
export const GATES = [
  {
    name: 'text-html-ratio',
    cmd: [
      'node',
      'scripts/audit-text-html-ratio.mjs',
      '--baseline=data/text-html-ratio-baseline.json',
      '--json',
    ],
    auditCmd: 'npm run audit:text-html-ratio',
    rebaselineCmd: 'npm run audit:text-html-ratio:rebaseline',
    baselineFile: 'data/text-html-ratio-baseline.json',
    extractCurrent: currentOffenders,
    extractBaseline: baselineOffenders,
    // See the `usesOwnRatchet` doc comment on the `title-length` gate below —
    // this audit shares the exact same mixAdjustedRateGate.mjs machinery.
    usesOwnRatchet: true,
    notes: 'Pages with text-to-HTML ratio <= 10% (Semrush threshold).',
  },
  {
    name: 'orphan-sitemap-pages',
    cmd: ['node', 'scripts/audit-orphan-pages-in-sitemaps.mjs'],
    auditCmd: 'npm run audit:orphan-sitemap-pages',
    rebaselineCmd: 'npm run audit:orphan-sitemap-pages:rebaseline',
    baselineFile: 'data/orphan-pages-baseline.json',
    // This gate's stdout is never JSON (see readsOwnReport below), so
    // evaluateGate() must not bail out on a failed JSON parse before calling
    // extractCurrent.
    readsOwnReport: true,
    // audit-orphan-pages-in-sitemaps has no `--json` mode, but it always writes
    // its machine-readable report to data/orphan-pages-audit.json (line 804)
    // before exiting. Read THAT. The previous reader regexed the human table on
    // stdout for /total[^:]*orphans?/ — a pattern the padded `TOTAL` row
    // (line 627) does not contain, so it fell through to `/(\d+)\s+orphan/`,
    // which matches the first incidental "N orphan…" in the log. Issue #5169.
    extractCurrent: () => {
      const reportPath = path.join(PROJECT_ROOT, 'data', 'orphan-pages-audit.json');
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      // The report is git-TRACKED, so a run that crashed before writing would
      // leave the committed copy behind and this reader would score the gate
      // against a stale number — the exact class of silent-pass this fix
      // exists to remove. Require the file to have been written by THIS
      // process's audit spawn.
      const generatedAt = Date.parse(report?.generatedAt ?? '');
      if (!Number.isFinite(generatedAt) || generatedAt < PROCESS_STARTED_AT) {
        throw new Error(
          `data/orphan-pages-audit.json is stale (generatedAt=${report?.generatedAt ?? 'missing'}, ` +
            `this run started ${new Date(PROCESS_STARTED_AT).toISOString()}) — the audit did not write a fresh report`,
        );
      }
      const v = report?.totalOrphans;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error('data/orphan-pages-audit.json carries no numeric totalOrphans');
      }
      return v;
    },
    extractBaseline: (baseline) => {
      const b = /** @type {Record<string, unknown>} */ (baseline ?? {});
      const v = b.totalOrphans;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error('orphan baseline carries no numeric totalOrphans');
      }
      return v;
    },
    notes: 'Sitemap URLs not reachable by BFS from /.',
  },
  {
    name: 'image-object-license',
    cmd: ['node', 'scripts/audit-image-object-license.mjs', '--json'],
    auditCmd: 'npm run audit:image-object-license',
    rebaselineCmd: 'N/A - zero-tolerance gate (target: 0)',
    baselineFile: null,
    extractCurrent: (parsed) => {
      const p = /** @type {Record<string, unknown>} */ (parsed);
      return Number(p.total ?? 0);
    },
    extractBaseline: () => 0,
    notes: 'Must be 0. Every ImageObject must have license/creator fields.',
  },
  {
    name: 'max-bfs-depth',
    cmd: [
      'node',
      'scripts/audit-bfs-depth.mjs',
      '--baseline=data/bfs-depth-baseline.json',
      '--json',
    ],
    auditCmd: 'npm run audit:max-bfs-depth',
    rebaselineCmd: 'npm run audit:max-bfs-depth:rebaseline',
    baselineFile: 'data/bfs-depth-baseline.json',
    extractCurrent: (parsed) => {
      const p = /** @type {Record<string, unknown>} */ (parsed);
      const perSitemap = /** @type {Record<string, Record<string, unknown>>|undefined} */ (
        p.perSitemap
      );
      if (perSitemap && typeof perSitemap === 'object') {
        let total = 0;
        for (const v of Object.values(perSitemap)) {
          total += Number(v.atDepthGtMax ?? 0);
        }
        return total;
      }
      return Number(p.atDepthGtMax ?? 0);
    },
    extractBaseline: (baseline) => {
      const b = /** @type {Record<string, unknown>} */ (baseline);
      const perSitemap = /** @type {Record<string, Record<string, unknown>>|undefined} */ (
        b.perSitemap
      );
      if (perSitemap && typeof perSitemap === 'object') {
        let total = 0;
        for (const v of Object.values(perSitemap)) {
          total += Number(v.atDepthGtMax ?? 0);
        }
        return total;
      }
      return 0;
    },
    // audit-bfs-depth.mjs is invoked above with --baseline=data/bfs-depth-baseline.json
    // (a "mode": "rate" baseline, version >= 2) and runs its own composition-
    // aware ratchet (evaluateBfsGate() — same rate*(1+relPct)+absPp shape as
    // mixAdjustedRateGate.mjs, just a local reimplementation for the
    // per-sitemap-shard case), encoding the verdict in its exit code
    // (0 = pass, 1 = regressed). See the `usesOwnRatchet` doc comment on the
    // `title-length` gate below — without this flag, evaluateGate() re-derives
    // a raw current-vs-baseline count comparison on `atDepthGtMax` here, which
    // can flag `regressed` on organic sitemap growth alone — the exact #5528
    // bug class.
    usesOwnRatchet: true,
    notes: 'Pages reachable from / only via BFS depth > 4.',
  },
  {
    name: 'title-length',
    cmd: [
      'node',
      'scripts/audit-title-length.mjs',
      '--threshold=66',
      '--baseline=data/title-length-baseline.json',
      '--json',
    ],
    auditCmd: 'npm run audit:title-length',
    rebaselineCmd: 'npm run audit:title-length:rebaseline',
    baselineFile: 'data/title-length-baseline.json',
    extractCurrent: currentOffenders,
    extractBaseline: baselineOffenders,
    // Issue #5528: audit-title-length.mjs, audit-text-html-ratio.mjs and
    // audit-title-no-disambig-hash.mjs all run
    // scripts/lib/mixAdjustedRateGate.mjs's evaluateMixAdjustedTotalRegression()
    // internally — a composition-shift-aware ratchet that weights CURRENT
    // per-feature scanned counts against BASELINE per-feature RATES, so
    // organic growth in the scanned population does not, by itself, fail the
    // gate (see that module's header for the full rationale; it was written
    // for exactly this failure mode after incident #3232). Each of these
    // three scripts' own `--json` exit code already carries that verdict
    // (`process.exit(result.passed ? 0 : 1)`).
    //
    // Comparing raw offender COUNTS here (current > baseline) re-derives a
    // cruder, composition-shift-BLIND verdict on top of an audit that already
    // computed the correct one — reintroducing, one layer up, the exact bug
    // class evaluateMixAdjustedTotalRegression() exists to prevent. That is
    // what opened issue #5528: between the 2026-07-22 baseline and the
    // 2026-08-10 run, dist/'s blog-post population grew (organic content
    // growth, unrelated to title length), so the raw offender count grew with
    // it (4290 -> 4647) even though audit-title-length.mjs's own rate-adjusted
    // check reported `regression: false` — the offender RATE tracked
    // population growth, it did not regress. `usesOwnRatchet: true` tells
    // evaluateGate() below to trust the audit's own exit code for the
    // regressed/pass call instead of re-deriving one from the raw counts;
    // current/baseline/delta are still reported (job summary, `improved`
    // rebaseline-opportunity issues), just not used to fail the build.
    usesOwnRatchet: true,
    notes: '<title> length must be <= 66 (60 + 10% tolerance).',
  },
  {
    name: 'title-no-disambig-hash',
    cmd: [
      'node',
      'scripts/audit-title-no-disambig-hash.mjs',
      '--baseline=data/title-no-disambig-hash-baseline.json',
      '--json',
    ],
    auditCmd: 'npm run audit:title-no-disambig-hash',
    rebaselineCmd: 'npm run audit:title-no-disambig-hash:rebaseline',
    baselineFile: 'data/title-no-disambig-hash-baseline.json',
    extractCurrent: currentOffenders,
    extractBaseline: baselineOffenders,
    // See the `usesOwnRatchet` doc comment on the `title-length` gate above —
    // this audit shares the exact same mixAdjustedRateGate.mjs machinery.
    usesOwnRatchet: true,
    notes: 'Visible "(#hash)" disambiguator in <title> hurts CTR.',
  },
];

/**
 * Spawn a child process and capture stdout/stderr (text).
 * Never throws on non-zero exit -- caller inspects `code`.
 * @param {string[]} argv
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function run(argv) {
  return new Promise((resolve) => {
    const [bin, ...rest] = argv;
    const child = spawn(bin, rest, {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: stderr + String(err) });
    });
  });
}

/**
 * Try to parse JSON from the audit stdout. Audits print human text + JSON; the
 * JSON is the last `{...}` block. Returns null if no parseable block found.
 * @param {string} text
 * @returns {unknown|null}
 */
function tryParseJson(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through
    }
  }
  const lastBraceClose = trimmed.lastIndexOf('}');
  const lastBracketClose = trimmed.lastIndexOf(']');
  const lastClose = Math.max(lastBraceClose, lastBracketClose);
  if (lastClose < 0) return null;
  const openChar = lastClose === lastBraceClose ? '{' : '[';
  let depth = 0;
  for (let i = lastClose; i >= 0; i -= 1) {
    const ch = trimmed[i];
    if (ch === '}' || ch === ']') depth += 1;
    else if (ch === '{' || ch === '[') depth -= 1;
    if (depth === 0 && ch === openChar) {
      const slice = trimmed.slice(i, lastClose + 1);
      try {
        return JSON.parse(slice);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * @param {string|null} relPath
 * @returns {Promise<unknown|null>}
 */
async function readBaselineFile(relPath) {
  if (!relPath) return null;
  const full = path.join(PROJECT_ROOT, relPath);
  try {
    const txt = await fs.readFile(full, 'utf8');
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

/**
 * Evaluate one gate.
 * @param {GateSpec} gate
 * @returns {Promise<Record<string, unknown>>}
 */
export async function evaluateGate(gate) {
  const result = await run(gate.cmd);
  const parsed = tryParseJson(result.stdout) ?? tryParseJson(result.stderr);

  /** @type {Record<string, unknown>} */
  const entry = {
    name: gate.name,
    auditCmd: gate.auditCmd,
    rebaselineCmd: gate.rebaselineCmd,
    notes: gate.notes,
    exitCode: result.code,
  };

  // Gates whose extractCurrent reads its own report file (readsOwnReport)
  // never emit JSON to stdout by design — bailing out here on a failed parse
  // would mean extractCurrent, and the freshness check it performs, never
  // runs at all. Only bail for gates that actually depend on `parsed`.
  if (!parsed && !gate.readsOwnReport) {
    entry.status = 'error';
    entry.error = 'Could not parse audit output as JSON.';
    entry.tailStderr = result.stderr.split('\n').slice(-20).join('\n');
    return entry;
  }

  let current;
  try {
    current = gate.extractCurrent(parsed, result.stdout);
  } catch (err) {
    entry.status = 'error';
    entry.error = `Failed to extract current value: ${err instanceof Error ? err.message : String(err)}`;
    return entry;
  }

  const baseline = await readBaselineFile(gate.baselineFile);
  let baselineValue = 0;
  if (gate.baselineFile && !baseline) {
    entry.status = 'error';
    entry.error = `Baseline file ${gate.baselineFile} missing.`;
    return entry;
  }
  if (baseline) {
    baselineValue = gate.extractBaseline(baseline);
  } else {
    baselineValue = gate.extractBaseline(null);
  }

  entry.current = current;
  entry.baseline = baselineValue;
  entry.delta = current - baselineValue;

  if (gate.usesOwnRatchet) {
    // Trust the audit's own composition-shift-aware verdict (see the
    // `usesOwnRatchet` doc comment on the title-length gate spec) instead of
    // re-deriving one from a raw offender-count comparison. `improved` is
    // still count-based — it only ever suggests an optional rebaseline
    // (priority 4, human-reviewed), it never fails the build, so a naive
    // comparison there carries none of the false-positive risk this fix is
    // for.
    entry.status = result.code === 0 ? (current < baselineValue ? 'improved' : 'pass') : 'regressed';
  } else if (current < baselineValue) {
    entry.status = 'improved';
  } else if (current > baselineValue) {
    entry.status = 'regressed';
  } else {
    entry.status = 'pass';
  }
  return entry;
}

async function main() {
  const checkedAt = new Date().toISOString();
  /** @type {Array<Record<string, unknown>>} */
  const results = [];
  for (const gate of GATES) {
    process.stderr.write(`[seo-gates-check] running ${gate.name}...\n`);
    const r = await evaluateGate(gate);
    results.push(r);
    process.stderr.write(
      `[seo-gates-check]   ${gate.name}: status=${r.status} current=${r.current ?? '?'} baseline=${r.baseline ?? '?'}\n`,
    );
  }

  const summary = {
    passed: results.filter((r) => r.status === 'pass').length,
    improved: results.filter((r) => r.status === 'improved').length,
    regressed: results.filter((r) => r.status === 'regressed').length,
    errors: results.filter((r) => r.status === 'error').length,
  };

  const verdict = {
    checkedAt,
    summary,
    gates: results,
  };

  await fs.writeFile(VERDICT_PATH, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(verdict, null, 2));

  if (summary.regressed > 0) process.exit(2);
  if (summary.errors > 0) process.exit(1);
  process.exit(0);
}

// Run only when invoked as a script. `currentOffenders` / `baselineOffenders` /
// `GATES` are exported for tests/cathedral-seo-gates-extractors.test.ts, and an
// import must not spawn six audits over dist/ as a side effect.
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === __filename;
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[seo-gates-check] fatal:', err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
