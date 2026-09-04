#!/usr/bin/env node
/**
 * seo-gates-rebaseline.mjs — apply the rebaseline of every IMPROVED cathedral
 * SEO gate, but only when the rewrite is provably a tightening.
 *
 * Context. `cathedral-seo-gates-check.yml` detects a gate whose current value
 * is below the committed baseline and files `chore(seo-gates): possible
 * rebaseline opportunity`, whose whole content is "a human should run
 * `npm run audit:*:rebaseline`". Nobody can: the command needs the rehydrated
 * `dist/` of a deploy run, which only that workflow materialises (~2.5 h,
 * `--max-old-space-size=8192`). So the issue is refiled with the same numbers
 * every time (#5983 on 2026-08-17, #7354 on 2026-09-04), three agent runs died
 * on it with `needs-human`, and meanwhile the ratchet stays parked at the loose
 * value — `text-html-ratio` at 6912 while the site measures 2618, i.e. a 4294
 * page regression could land undetected.
 *
 * The reason it was left to a human is real and documented (docs/SEO-GATES.md
 * §4b): the `:rebaseline` scripts overwrite the committed file with the current
 * measurement and compare NOTHING, so a truncated measurement freezes a worse
 * state in forever. This script performs exactly that missing comparison
 * (`scripts/ci/lib/baseline-ratchet.mjs`): snapshot the committed file, run the
 * gate's own rebaseline script, and keep the result only if every bucket is at
 * least as strict as before and the scanned corpus did not shrink. Otherwise
 * the committed file is restored byte for byte and the gate keeps its old
 * baseline — the status quo, never worse than it.
 *
 * It still never lands on `main` by itself: the workflow opens a PR with the
 * diff, which goes through the normal review + `## LGTM` gate.
 *
 * Usage:
 *   node scripts/ci/seo-gates-rebaseline.mjs [--verdict=<path>] [--report=<path>] [--dry-run]
 *
 * Exit codes:
 *   0 — done (whether or not anything was applied; a refusal is not a failure)
 *   1 — could not run at all (missing/invalid verdict file)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { GATES } from '../cathedral-seo-gates-check.mjs';
import { assertBaselineRatchet, formatRatchetVerdict } from './lib/baseline-ratchet.mjs';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), '..', '..');

/**
 * `rebaselineCmd` is a string in a data file, so it is never handed to a
 * shell. Only the `npm run <script>` form is accepted, the script name is
 * matched against a conservative charset, and it is spawned as argv.
 * Everything else (`N/A - zero-tolerance gate`, anything exotic) is skipped.
 *
 * @param {string} cmd
 * @returns {string|null} the npm script name, or null when unusable
 */
export function npmScriptOf(cmd) {
  const m = /^npm run ([A-Za-z0-9:._-]+)$/.exec(String(cmd ?? '').trim());
  return m ? m[1] : null;
}

/**
 * The gates this script may touch: an improved gate that owns a baseline file
 * and a well-formed `npm run` rebaseline script.
 *
 * @param {{gates?: Array<Record<string, unknown>>}} verdict
 * @returns {Array<{name: string, baselineFile: string, npmScript: string, skipped?: string}>}
 */
export function candidatesFrom(verdict) {
  const out = [];
  for (const gate of verdict.gates ?? []) {
    if (gate.status !== 'improved') continue;
    const spec = GATES.find((g) => g.name === gate.name);
    const baselineFile = spec?.baselineFile ?? null;
    const npmScript = npmScriptOf(spec?.rebaselineCmd ?? gate.rebaselineCmd);
    if (!baselineFile || !npmScript) {
      out.push({
        name: String(gate.name),
        baselineFile: baselineFile ?? '',
        npmScript: npmScript ?? '',
        skipped: !baselineFile
          ? 'gate owns no baseline file (zero-tolerance gate)'
          : `rebaseline command is not a plain \`npm run <script>\`: ${spec?.rebaselineCmd ?? gate.rebaselineCmd}`,
      });
      continue;
    }
    out.push({ name: String(gate.name), baselineFile, npmScript });
  }
  return out;
}

/**
 * @param {string} script npm script name
 * @returns {Promise<{code: number, stderr: string}>}
 */
function runNpmScript(script) {
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', script], {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ['ignore', 'inherit', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      process.stderr.write(chunk);
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stderr: stderr.slice(-4000) }));
  });
}

async function main() {
  const args = new Map(
    process.argv.slice(2).map((a) => {
      const [k, ...rest] = a.replace(/^--/, '').split('=');
      return [k, rest.length ? rest.join('=') : 'true'];
    }),
  );
  const dryRun = args.get('dry-run') === 'true';
  const verdictPath = path.resolve(
    PROJECT_ROOT,
    args.get('verdict') ?? 'data/cathedral-seo-gates-verdict.json',
  );
  const reportPath = args.get('report') ? path.resolve(PROJECT_ROOT, args.get('report')) : null;

  let verdict;
  try {
    verdict = JSON.parse(await fs.readFile(verdictPath, 'utf8'));
  } catch (err) {
    console.error(`[seo-gates-rebaseline] cannot read verdict ${verdictPath}: ${err.message}`);
    process.exit(1);
  }

  const candidates = candidatesFrom(verdict);
  /** @type {string[]} */
  const report = [];
  /** @type {string[]} */
  const applied = [];

  if (candidates.length === 0) {
    console.log('[seo-gates-rebaseline] no improved gate to rebaseline.');
  }

  for (const candidate of candidates) {
    if (candidate.skipped) {
      report.push(`### \`${candidate.name}\` — skipped\n\n- ${candidate.skipped}\n`);
      console.log(`[seo-gates-rebaseline] ${candidate.name}: skipped — ${candidate.skipped}`);
      continue;
    }
    const absolute = path.resolve(PROJECT_ROOT, candidate.baselineFile);
    const committed = await fs.readFile(absolute, 'utf8');

    if (dryRun) {
      report.push(
        `### \`${candidate.name}\` — dry-run\n\n- would run \`npm run ${candidate.npmScript}\` and ratchet-check \`${candidate.baselineFile}\`\n`,
      );
      continue;
    }

    console.log(`[seo-gates-rebaseline] ${candidate.name}: npm run ${candidate.npmScript}`);
    const { code, stderr } = await runNpmScript(candidate.npmScript);

    const regenerated = await fs.readFile(absolute, 'utf8');
    if (regenerated === committed) {
      // The audit exits non-zero on a real regression; either way, a rebaseline
      // that changed nothing is not an opportunity.
      report.push(
        `### \`${candidate.name}\` — no change\n\n- \`npm run ${candidate.npmScript}\` exited ${code} and left \`${candidate.baselineFile}\` byte-identical\n`,
      );
      continue;
    }

    let verdictForGate;
    try {
      verdictForGate = assertBaselineRatchet(JSON.parse(committed), JSON.parse(regenerated));
    } catch (err) {
      verdictForGate = {
        ok: false,
        violations: [`regenerated baseline is not valid JSON: ${err.message}`],
        newBuckets: [],
        tightenedBuckets: 0,
        oldOffenders: 0,
        newOffenders: 0,
        oldScanned: 0,
        newScanned: 0,
        corpusDeltaPct: 0,
      };
    }
    if (code !== 0 && verdictForGate.ok) {
      verdictForGate.ok = false;
      verdictForGate.violations.push(
        `\`npm run ${candidate.npmScript}\` exited ${code} — the measurement it wrote is not trustworthy${stderr ? ` (stderr tail: ${stderr.split('\n').slice(-3).join(' ')})` : ''}`,
      );
    }

    report.push(formatRatchetVerdict(candidate.name, verdictForGate));

    if (verdictForGate.ok) {
      applied.push(candidate.baselineFile);
      console.log(
        `[seo-gates-rebaseline] ${candidate.name}: ACCEPTED (${verdictForGate.oldOffenders} → ${verdictForGate.newOffenders} offenders)`,
      );
    } else {
      await fs.writeFile(absolute, committed, 'utf8');
      console.log(
        `::warning::seo-gates rebaseline REFUSED for ${candidate.name}: ${verdictForGate.violations.join('; ')}`,
      );
    }
  }

  const markdown = report.join('\n');
  if (reportPath) await fs.writeFile(reportPath, markdown, 'utf8');
  if (markdown) console.log(`\n${markdown}`);

  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      `applied_count=${applied.length}\napplied_files=${applied.join(' ')}\n`,
      'utf8',
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY && markdown) {
    await fs.appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## SEO gates rebaseline\n\n${markdown}\n`,
      'utf8',
    );
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === __filename;
if (invokedDirectly) {
  await main();
}
