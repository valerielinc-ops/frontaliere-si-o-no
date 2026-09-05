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
import { auditReportPath } from './lib/auditReport.mjs';

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
 * @property {string} [bundledAs] name this gate's audit is registered under in
 *   scripts/audit-all.mjs. Set it and the gate stops spawning `cmd`: it rides
 *   the single shared dist/ walk that {@link runBundle} performs once for all
 *   bundled gates, and reads its verdict from that run instead. See the
 *   "one walk, not six" comment on {@link runBundle}.
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
    bundledAs: 'text-html-ratio',
    readsOwnReport: true,
    extractCurrent: reportOffenders('text-html-ratio'),
    extractBaseline: baselineOffenders,
    // See the `usesOwnRatchet` doc comment on the `title-length` gate below —
    // this audit shares the exact same mixAdjustedRateGate.mjs machinery.
    usesOwnRatchet: true,
    notes: 'Pages with text-to-HTML ratio <= 10% (Semrush threshold).',
  },
  {
    name: 'orphan-sitemap-pages',
    // Issue #5972: audit-orphan-pages-in-sitemaps.mjs gained its own
    // composition-shift-aware RATE ratchet in #1604 (mirrors evaluateBfsGate())
    // and exposes it via `--gate=baseline` (exit 1 only on a real per-sitemap
    // rate regression, not on the corpus simply growing). This wrapper was
    // never updated to pass the flag or trust it — the same
    // usesOwnRatchet gap #5542 closed for text-html-ratio / title-length /
    // title-no-disambig-hash / max-bfs-depth, just missed here. Without
    // `--gate=baseline` the audit always exits 0, so evaluateGate() fell back
    // to a raw current-vs-baseline totalOrphans comparison — composition-shift
    // BLIND — and organic URL growth alone (more sitemap entries at a flat or
    // improved orphan RATE) tripped `status=regressed` (current=3474
    // baseline=1982, #5972). Passing --gate=baseline + usesOwnRatchet: true
    // makes this gate behave exactly like its four siblings.
    cmd: ['node', 'scripts/audit-orphan-pages-in-sitemaps.mjs', '--gate=baseline'],
    auditCmd: 'npm run audit:orphan-sitemap-pages',
    rebaselineCmd: 'npm run audit:orphan-sitemap-pages:rebaseline',
    baselineFile: 'data/orphan-pages-baseline.json',
    // This gate's stdout is never JSON (see readsOwnReport below), so
    // evaluateGate() must not bail out on a failed JSON parse before calling
    // extractCurrent.
    readsOwnReport: true,
    usesOwnRatchet: true,
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
    bundledAs: 'image-object-license',
    readsOwnReport: true,
    extractCurrent: reportOffenders('image-object-license'),
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
    // The registered auditor's factory() hard-codes the same `threshold: 66`
    // this gate's `cmd` passes (scripts/audit-title-length.mjs, factory()), so
    // riding the shared walk measures the same thing.
    bundledAs: 'title-length',
    readsOwnReport: true,
    extractCurrent: reportOffenders('title-length'),
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
    bundledAs: 'title-no-disambig-hash',
    readsOwnReport: true,
    extractCurrent: reportOffenders('title-no-disambig-hash'),
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
 * One walk, not six.
 * ------------------
 * Measured on run 33853154762, the last green run of this workflow, from the
 * `[seo-gates-check] running <name>...` lines it prints itself:
 *
 *   text-html-ratio        11:21:29 -> 12:01:59   40m 29s
 *   orphan-sitemap-pages   12:01:59 -> 12:11:17    9m 18s
 *   image-object-license   12:11:17 -> 12:43:56   32m 39s
 *   max-bfs-depth          12:43:56 -> 12:53:03    9m 07s
 *   title-length           12:53:03 -> 13:27:01   33m 58s
 *   title-no-disambig-hash 13:27:01 -> 13:58:08   31m 07s
 *   ------------------------------------------- 2h 36m 39s
 *
 * against a `timeout-minutes: 180` cap, i.e. 23 minutes of margin on a dist/
 * that grows daily. Three of the last four runs were then cancelled at 3h
 * (issue #7421); on run 33922555269 this step ran 00:23:10 -> 03:03:59.
 *
 * The two BFS gates are 18 of those 156 minutes. The other 138 belong to the
 * four gates above that are plain per-file scans -- and all four are already
 * registered in scripts/audit-all.mjs, whose runner walks dist/ ONCE and hands
 * every registered auditor the same file contents (scripts/lib/audit-runner.mjs).
 * Spawning them separately re-walks 4,380,688 HTML files four times over to
 * compute four numbers from the same bytes.
 *
 * So they now ride one spawn. Nothing about the gates themselves changes:
 * `runAudits()` runs the same auditor objects against the same baselines with
 * the same thresholds, writes each one's `dist/audit-reports/<name>.json`
 * exactly as the standalone scripts do, and prints the per-audit verdict line
 * `audit-all: failed-audits=<name>,<name>` that this function parses -- so a
 * bundled gate keeps its OWN pass/fail, it does not inherit the bundle's.
 *
 * @param {GateSpec[]} gates
 * @returns {Promise<{ failed: Set<string>, error?: string } | null>}
 */
export async function runBundle(gates) {
  const names = gates.map((g) => g.bundledAs).filter((n) => typeof n === 'string');
  if (names.length === 0) return null;
  // Timed on its own line so the shared walk keeps a stopwatch of its own —
  // see the note on the per-gate lines in main().
  const t0 = Date.now();
  process.stderr.write(
    `[seo-gates-check] one shared dist/ walk for ${names.length} gate(s): ${names.join(', ')}\n`,
  );
  // `--sample-rate=1` explicitly, not by relying on the default. audit-all
  // reads `AUDIT_SAMPLE_RATE` from the environment, and this checker spawns
  // with `env: process.env`; the CLI flag wins over the env var. Without it,
  // anyone adding that variable to the workflow — or exporting it upstream —
  // would put FOUR gates on a quarter of the corpus at once, reporting a
  // quarter of the offenders against unchanged baselines, with no code change
  // and no signal. That is a gate quietly loosened, which AGENTS.md
  // non-negotiable #1 forbids. This gate audits the whole corpus or it does
  // not run; the sampling lever belongs to post-deploy-validate-dist.yml,
  // which opts into it deliberately.
  const result = await run([
    'node', 'scripts/audit-all.mjs', `--audits=${names.join(',')}`, '--sample-rate=1',
  ]);
  // Exit 2 is "dist/ missing or fatal error": no audit produced a verdict, so
  // every bundled gate must report `error`, never a fabricated pass.
  if (result.code === 2) {
    return {
      failed: new Set(),
      error: `audit-all exited 2 (dist missing / fatal): ${result.stderr.split('\n').slice(-5).join(' ')}`,
    };
  }
  // The line is printed unconditionally on every completed run (issue #4828).
  // Its ABSENCE means the runner died before reporting, which is not the same
  // thing as "nothing failed" -- fail closed rather than read a green bundle
  // out of a truncated log.
  const m = /^audit-all: failed-audits=(.*)$/m.exec(`${result.stdout}\n${result.stderr}`);
  if (!m) {
    return {
      failed: new Set(),
      error: 'audit-all printed no `failed-audits=` line -- the shared walk did not complete',
    };
  }
  process.stderr.write(
    `[seo-gates-check] shared dist/ walk done in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`,
  );
  return { failed: new Set(m[1].split(',').map((s) => s.trim()).filter(Boolean)) };
}

/**
 * Read a bundled gate's offender count out of the report the shared walk wrote.
 * Same freshness contract as the `orphan-sitemap-pages` extractor below: the
 * reports live under dist/, so a run that died before writing would otherwise
 * be scored against whatever the previous run left on disk.
 * @param {string} name
 * @returns {() => number}
 */
export function reportOffenders(name) {
  return () => {
    // auditReportPath(), not a hand-built path: it is the same resolver the
    // writer uses, so an AUDIT_REPORTS_DIR override moves reader and writer
    // together instead of leaving this one reading a stale committed copy.
    const reportPath = auditReportPath(name);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const ranAt = Date.parse(report?.ranAt ?? '');
    if (!Number.isFinite(ranAt) || ranAt < PROCESS_STARTED_AT) {
      throw new Error(
        `${reportPath} is stale (ranAt=${report?.ranAt ?? 'missing'}, ` +
          `this run started ${new Date(PROCESS_STARTED_AT).toISOString()}) -- the shared walk did not write a fresh report`,
      );
    }
    const v = report?.offendersTotal;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`${reportPath} carries no numeric offendersTotal`);
    }
    return v;
  };
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
export async function evaluateGate(gate, bundle = null) {
  /** @type {Record<string, unknown>} */
  const entry0 = { name: gate.name };
  // A bundled gate does not spawn: its audit already ran inside the single
  // shared dist/ walk. Synthesise the same `{code, stdout, stderr}` shape the
  // rest of this function reads, with the per-audit exit code recovered from
  // `audit-all: failed-audits=` — see runBundle().
  let result;
  if (gate.bundledAs && bundle) {
    if (bundle.error) {
      return { ...entry0, auditCmd: gate.auditCmd, rebaselineCmd: gate.rebaselineCmd, notes: gate.notes, status: 'error', error: bundle.error };
    }
    result = { code: bundle.failed.has(gate.bundledAs) ? 1 : 0, stdout: '', stderr: '' };
  } else {
    result = await run(gate.cmd);
  }
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
  const bundle = await runBundle(GATES);
  for (const gate of GATES) {
    // These lines are the only per-gate stopwatch this workflow has — the
    // 2h 36m 39s breakdown that justified the bundle was timed off them. A
    // bundled gate no longer spawns anything, so saying "running" would credit
    // it ~0 s and dump the whole shared walk onto whichever gate happens to be
    // first, i.e. hand the next person a false measurement taken with the same
    // instrument. Say which ones rode the shared walk instead.
    const how = gate.bundledAs && bundle && !bundle.error ? 'bundled (shared walk)' : 'running';
    process.stderr.write(`[seo-gates-check] ${how} ${gate.name}...\n`);
    const r = await evaluateGate(gate, bundle);
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
