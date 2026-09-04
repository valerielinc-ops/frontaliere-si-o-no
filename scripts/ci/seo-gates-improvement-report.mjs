#!/usr/bin/env node
/**
 * seo-gates-improvement-report.mjs — decide whether a cathedral SEO gate that
 * IMPROVED deserves an issue, or only a line in the job summary.
 *
 * Why this exists (issue #7354, #5983 before it). When a gate's current value
 * lands below its committed baseline, `cathedral-seo-gates-check.yml` filed
 * `chore(seo-gates): possible rebaseline opportunity`, an issue whose entire
 * content is "a human should run `npm run audit:*:rebaseline`". For every gate
 * this workflow can actually report as improved, that request is one the
 * owner has already refused:
 *
 *   VISION.md driver D9 (owner instruction 2026-08-25, on issue #5983, naming
 *   these very gates and these very numbers — text-html-ratio 6912→2562,
 *   max-bfs-depth 26398→11108): a "nice-to-have" SEO gate — an opportunistic
 *   content-quality heuristic Google does not require for indexing or ranking
 *   — is NOT tightened when the measurement improves. The ratchet would make
 *   the gate ever stricter on a metric Google does not care about. The right
 *   direction is to make the gate advisory (issue #6462), and an improvement
 *   issue on such a gate "si chiude senza toccare il file di baseline, citando
 *   questo driver — mai `npm run audit:*:rebaseline`". Mirrored as the second
 *   delimited exception to AGENTS.md non-negotiable #1.
 *
 * So the issue asked for work that is forbidden the moment it is filed. It was
 * refiled unchanged with a stable title (#5983 on 2026-08-17, #7354 on
 * 2026-09-04), and each time it was routed to the autonomous fixer, which
 * burned a run rediscovering D9 and closed it `needs-human`. This script cuts
 * the loop at the source: improvements on nice-to-have gates are reported in
 * the job summary and nothing else happens.
 *
 * It is NOT a blanket silencer. The bucket comes from `QUALITY_GATES` in
 * `classify-validate-dist-failures.mjs` — the same table that decides which
 * gate may not sequester `publish`, so the two answers to "is this gate a
 * Google requirement?" cannot drift apart. A gate outside that table (a
 * structured-data field, a markup error, a broken status code) still gets its
 * issue, because for a hard gate the ratchet is doing work Google rewards.
 * Regressions are untouched by this file: `current > baseline` remains
 * root-cause-first and still opens an issue per gate.
 *
 * Usage:
 *   node scripts/ci/seo-gates-improvement-report.mjs \
 *     [--verdict=<path>] [--issue-body=<path>]
 *
 * Outputs (GITHUB_OUTPUT): `file_issue=0|1`, `actionable_count`, `advisory_count`.
 * Always exits 0 unless the verdict file is unreadable (exit 1): an
 * improvement is never a failure.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { QUALITY_GATES } from './classify-validate-dist-failures.mjs';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), '..', '..');

/**
 * A cathedral gate is named `text-html-ratio`; the same gate appears in
 * `QUALITY_GATES` under the name the validate-dist pipeline uses for it,
 * either `audit:<name>` (standalone audit) or `audit:all/<name>` (bundled
 * sub-auditor). Both prefixes are tried, so neither table has to repeat the
 * other's naming.
 *
 * @param {string} gateName cathedral gate name
 * @returns {boolean} true when the gate is an opportunistic heuristic (D9)
 */
export function isNiceToHaveGate(gateName) {
  const name = String(gateName ?? '');
  return (
    Object.hasOwn(QUALITY_GATES, `audit:${name}`) ||
    Object.hasOwn(QUALITY_GATES, `audit:all/${name}`)
  );
}

/**
 * Split the improved gates of a verdict into the ones that still warrant an
 * issue and the ones D9 covers.
 *
 * @param {{gates?: Array<Record<string, unknown>>}} verdict
 * @returns {{actionable: Array<Record<string, unknown>>, advisory: Array<Record<string, unknown>>}}
 */
export function partitionImprovements(verdict) {
  const improved = (verdict?.gates ?? []).filter((g) => g.status === 'improved');
  return {
    actionable: improved.filter((g) => !isNiceToHaveGate(g.name)),
    advisory: improved.filter((g) => isNiceToHaveGate(g.name)),
  };
}

/**
 * Body of the issue filed for the gates D9 does NOT cover.
 *
 * @param {Array<Record<string, unknown>>} actionable
 * @param {string} runUrl
 * @returns {string}
 */
export function renderIssueBody(actionable, runUrl) {
  const lines = [
    `Automated check detected **${actionable.length}** SEO content gate(s) where the`,
    'current value is BELOW the committed baseline, on gate(s) that VISION.md driver',
    'D9 does NOT cover — they verify data or markup Google requires, so tightening the',
    'ratchet is real work rather than optimising a heuristic Google ignores.',
    '',
    'Per CLAUDE.md non-negotiables #1 + #5, review the data before running the',
    'rebaseline command(s) below.',
    '',
    '## Improved gates',
    '',
  ];
  for (const gate of actionable) {
    lines.push(`### \`${gate.name}\``, '');
    lines.push(`- Current: **${gate.current}** (was ${gate.baseline}, delta ${gate.delta})`);
    lines.push(`- Rebaseline: \`${gate.rebaselineCmd}\``);
    lines.push(`- Notes: ${gate.notes}`, '');
  }
  lines.push('', '## Workflow run', '', runUrl);
  return lines.join('\n');
}

/**
 * Job-summary block for the improvements that are deliberately not filed.
 *
 * @param {Array<Record<string, unknown>>} advisory
 * @returns {string}
 */
export function renderAdvisorySummary(advisory) {
  if (advisory.length === 0) return '';
  const lines = [
    '## SEO gate improvements (no issue filed — VISION.md D9)',
    '',
    'These gates measure content-quality heuristics Google does not require for',
    'indexing or ranking. Per driver D9 (owner instruction 2026-08-25, issue #5983)',
    'their baseline is NOT tightened when the measurement improves, and no',
    'rebaseline issue is filed — the direction of travel is making the gate advisory',
    '(issue #6462), not making it ever stricter on a metric Google ignores.',
    '',
    '| Gate | Current | Baseline | Delta |',
    '|------|---------|----------|-------|',
  ];
  for (const gate of advisory) {
    lines.push(`| ${gate.name} | ${gate.current} | ${gate.baseline} | ${gate.delta} |`);
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const args = new Map(
    process.argv.slice(2).map((a) => {
      const [k, ...rest] = a.replace(/^--/, '').split('=');
      return [k, rest.length ? rest.join('=') : 'true'];
    }),
  );
  const verdictPath = path.resolve(
    PROJECT_ROOT,
    args.get('verdict') ?? 'data/cathedral-seo-gates-verdict.json',
  );
  const issueBodyPath = path.resolve(PROJECT_ROOT, args.get('issue-body') ?? '/tmp/issue-body.md');

  let verdict;
  try {
    verdict = JSON.parse(await fs.readFile(verdictPath, 'utf8'));
  } catch (err) {
    console.error(`[seo-gates-improvements] cannot read verdict ${verdictPath}: ${err.message}`);
    process.exit(1);
  }

  const { actionable, advisory } = partitionImprovements(verdict);
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${
    process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY ?? ''
  }/actions/runs/${process.env.GITHUB_RUN_ID ?? ''}`;

  for (const gate of advisory) {
    console.log(
      `[seo-gates-improvements] ${gate.name} improved ${gate.baseline} → ${gate.current} — nice-to-have gate, no issue filed (VISION.md D9)`,
    );
  }

  if (actionable.length > 0) {
    await fs.writeFile(issueBodyPath, renderIssueBody(actionable, runUrl), 'utf8');
  }

  const summary = renderAdvisorySummary(advisory);
  if (summary && process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, 'utf8');
  }

  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      `file_issue=${actionable.length > 0 ? 1 : 0}\nactionable_count=${actionable.length}\nadvisory_count=${advisory.length}\n`,
      'utf8',
    );
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === __filename;
if (invokedDirectly) {
  await main();
}
