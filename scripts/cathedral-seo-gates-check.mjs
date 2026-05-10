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

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

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
 * @property {string} notes
 */

/** @type {GateSpec[]} */
const GATES = [
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
    extractCurrent: (parsed) => {
      const p = /** @type {Record<string, unknown>} */ (parsed);
      const offenders = /** @type {unknown[]|undefined} */ (p.offenders);
      if (Array.isArray(offenders)) return offenders.length;
      const total = Number(p.total ?? 0);
      return Number.isFinite(total) ? total : 0;
    },
    extractBaseline: (baseline) => {
      const b = /** @type {Record<string, unknown>} */ (baseline);
      return Number(b.total ?? 0);
    },
    notes: 'Pages with text-to-HTML ratio <= 10% (Semrush threshold).',
  },
  {
    name: 'orphan-sitemap-pages',
    cmd: ['node', 'scripts/audit-orphan-pages-in-sitemaps.mjs'],
    auditCmd: 'npm run audit:orphan-sitemap-pages',
    rebaselineCmd: 'npm run audit:orphan-sitemap-pages:rebaseline',
    baselineFile: 'data/orphan-pages-baseline.json',
    extractCurrent: (parsed, raw) => {
      const m = raw.match(/total[^:]*orphans?\s*[:=]?\s*(\d+)/i);
      if (m) return Number(m[1]);
      const m2 = raw.match(/(\d+)\s+orphan/i);
      return m2 ? Number(m2[1]) : 0;
    },
    extractBaseline: (baseline) => {
      const b = /** @type {Record<string, unknown>} */ (baseline);
      return Number(b.totalOrphans ?? 0);
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
    extractCurrent: (parsed) => {
      const p = /** @type {Record<string, unknown>} */ (parsed);
      const offenders = /** @type {unknown[]|undefined} */ (p.offenders);
      if (Array.isArray(offenders)) return offenders.length;
      return Number(p.total ?? 0);
    },
    extractBaseline: (baseline) => {
      const b = /** @type {Record<string, unknown>} */ (baseline);
      return Number(b.total ?? 0);
    },
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
    extractCurrent: (parsed) => {
      const p = /** @type {Record<string, unknown>} */ (parsed);
      const offenders = /** @type {unknown[]|undefined} */ (p.offenders);
      if (Array.isArray(offenders)) return offenders.length;
      return Number(p.total ?? 0);
    },
    extractBaseline: (baseline) => {
      const b = /** @type {Record<string, unknown>} */ (baseline);
      return Number(b.total ?? 0);
    },
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
async function evaluateGate(gate) {
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

  if (!parsed) {
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

  if (current < baselineValue) {
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

main().catch((err) => {
  console.error('[seo-gates-check] fatal:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
