import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseAssembleCliArgs } from '../scripts/assemble-jobs-dataset.mjs';

/**
 * `--no-summaries` skips the SECOND full read of every job slice that
 * assembleSummaries() performs (once to list the crawler summary slices, once
 * more to recompute computeCrawlerQualityAggregate per crawler). Measured
 * 131-209 s, median 169,1 — 34 % of the cascade's fixed setup cost in
 * translate-pending-logic.yml (workspace issue 34).
 *
 * Two things have to stay true and neither is visible from the other:
 *
 *  1. The flag is OPT-IN. `assemble-jobs-dataset.mjs` has ~30 callers — the npm
 *     scripts (predev/prebuild/prepush:fast/jobs:assemble), the crawler
 *     update-*.mjs modules that import it, the vitest background step and three
 *     other steps of the translate job. A default of `withSummaries: false`
 *     would silently stop regenerating data/jobs-crawler-summaries.json for all
 *     of them, and the file feeds the job-board quality surface.
 *
 *  2. Exactly ONE step passes it. The re-assemble after the Argos bulk is the
 *     only one whose output nothing downstream reads before the commit; the
 *     Phase 2c mop-up re-assemble and the true-final re-assemble MUST keep
 *     rebuilding summaries, or the file ships stale.
 *
 * The assembly itself is not exercised here on purpose: running it writes into
 * tracked data/ files, which a test must never do.
 */

const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'scripts/assemble-jobs-dataset.mjs'), 'utf8');
const LOGIC_WORKFLOW = path.join(ROOT, '.github/workflows/translate-pending-logic.yml');
const CORPUS_ARTIFACT = path.join(ROOT, '.github/corpus-workflows/translate-pending.yml');

/** Every `node scripts/assemble-jobs-dataset.mjs …` run line, with its flags. */
function assembleRunLines(workflowPath: string): string[] {
  const yaml = fs.readFileSync(workflowPath, 'utf8');
  return [...yaml.matchAll(/^\s*run: node scripts\/assemble-jobs-dataset\.mjs(.*)$/gm)]
    .map((m) => m[1].trim());
}

describe('assemble-jobs-dataset --no-summaries is opt-in', () => {
  it('defaults to assembling summaries when no flag is passed', () => {
    expect(parseAssembleCliArgs([])).toEqual({ withStats: false, withSummaries: true });
  });

  it('turns off summaries only for --no-summaries', () => {
    expect(parseAssembleCliArgs(['--no-summaries']).withSummaries).toBe(false);
    expect(parseAssembleCliArgs(['--stats']).withSummaries).toBe(true);
    expect(parseAssembleCliArgs(['--summaries']).withSummaries).toBe(true);
    expect(parseAssembleCliArgs(['--no-stats']).withSummaries).toBe(true);
  });

  it('keeps --stats orthogonal to --no-summaries', () => {
    expect(parseAssembleCliArgs(['--stats', '--no-summaries']))
      .toEqual({ withStats: true, withSummaries: false });
  });

  it('declares the option default as true in assembleJobsDataset()', () => {
    expect(SOURCE).toMatch(
      /export async function assembleJobsDataset\(\{[^}]*withSummaries = true[^}]*\} = \{\}\)/,
    );
  });

  it('gates the summaries block — and only the summaries block — on the option', () => {
    const summariesCall = SOURCE.indexOf('const summaryStore = assembleSummaries()');
    expect(summariesCall).toBeGreaterThan(-1);
    const guard = SOURCE.lastIndexOf('if (withSummaries) {', summariesCall);
    expect(guard).toBeGreaterThan(-1);
    // The guard must be adjacent to the call, not some far-away earlier block.
    expect(SOURCE.slice(guard, summariesCall)).not.toContain('\n  }\n');
    // assembleSummaries() is CALLED from nowhere else (its declaration and the
    // comment above the guard mention it, no other call site does).
    expect(SOURCE.match(/assembleSummaries\(\);/g)).toHaveLength(1);
  });

  it('keys the assemble cache on the option', () => {
    // Without this the snapshot of a --no-summaries run (which copies the
    // PREVIOUS summaries file verbatim) would be restored by a later full run
    // with the same input fingerprint, and the stale file would survive.
    expect(SOURCE).toMatch(/const cacheKey = `\$\{inputFingerprint\}_.*withSummaries \?/);
  });
});

describe('translate-pending: only the post-Argos re-assemble skips summaries', () => {
  it('passes --no-summaries exactly once in the source workflow', () => {
    const runs = assembleRunLines(LOGIC_WORKFLOW);
    expect(runs.length).toBeGreaterThanOrEqual(4);
    expect(runs.filter((flags) => flags.includes('--no-summaries'))).toHaveLength(1);
  });

  it('attaches it to the step whose output nothing downstream reads', () => {
    const yaml = fs.readFileSync(LOGIC_WORKFLOW, 'utf8');
    const step = yaml.slice(yaml.indexOf('- name: Re-assemble dataset after Argos bulk'));
    const runLine = step.slice(0, step.indexOf('- name:', 1));
    expect(runLine).toContain('run: node scripts/assemble-jobs-dataset.mjs --no-summaries');
  });

  it('leaves the Phase 2c and true-final re-assembles rebuilding summaries', () => {
    const yaml = fs.readFileSync(LOGIC_WORKFLOW, 'utf8');
    for (const stepName of [
      '- name: Re-assemble dataset after Phase 2c mop-up',
      '- name: Re-assemble true-final translation dataset',
    ]) {
      const at = yaml.indexOf(stepName);
      expect(at, `${stepName} not found — was the step renamed?`).toBeGreaterThan(-1);
      const step = yaml.slice(at, yaml.indexOf('- name:', at + 1));
      expect(step).not.toContain('--no-summaries');
    }
  });

  it('carries the flag into the generated corpus artifact', () => {
    // The corpus runs the ARTIFACT, not the logic file. Editing the logic
    // without re-running generate-crawler-group-workflows.mjs would ship a
    // saving that never reaches the pool.
    expect(assembleRunLines(CORPUS_ARTIFACT).filter((f) => f.includes('--no-summaries')))
      .toHaveLength(1);
  });
});
