import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';

const WORKFLOW = join(process.cwd(), '.github/workflows/audit-dist-from-run.yml');
const REHYDRATE_STEP = 'Rehydrate locale then section shards into dist/ (when sharding active)';

function rehydrateStepScript(): string {
  const workflow = YAML.parse(readFileSync(WORKFLOW, 'utf8')) as {
    jobs?: { audit?: { steps?: Array<{ name?: string; run?: string }> } };
  };
  const step = workflow.jobs?.audit?.steps?.find(({ name }) => name === REHYDRATE_STEP);
  expect(step?.run, `step "${REHYDRATE_STEP}" not found`).toBeTruthy();
  return String(step?.run);
}

function observerBlock(): string {
  const run = rehydrateStepScript();
  const start = run.indexOf('rehydrateRuntimeBudgetObserved()');
  const end = run.indexOf('# Same order and same failure contract', start);
  expect(start, 'runtime observer function is missing').toBeGreaterThanOrEqual(0);
  expect(end, 'runtime observer block is not bound to the rehydrate step').toBeGreaterThan(start);
  return run.slice(start, end);
}

function observe(localeRc: number, sectionRc: number): string {
  const directory = mkdtempSync(join(tmpdir(), 'audit-dist-rehydrate-budget-'));
  const summaryPath = join(directory, 'summary.md');
  try {
    execFileSync(
      'bash',
      [
        '-c',
        `${observerBlock()}\nrehydrateRuntimeBudgetObserved "$(( $(date +%s) - 7 ))" "${localeRc}" "${sectionRc}"`,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: summaryPath,
          REHYDRATE_MAX_PARALLEL: '1',
        },
        stdio: 'ignore',
      },
    );
    return readFileSync(summaryPath, 'utf8');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runRehydrateStep(sectionScript: string, localeScript = 'exit 0'): { status: number; summary: string } {
  const directory = mkdtempSync(join(tmpdir(), 'audit-dist-rehydrate-step-'));
  const runnerTemp = join(directory, 'runner-temp');
  const scriptsDirectory = join(directory, 'scripts', 'lib');
  const summaryPath = join(directory, 'summary.md');
  mkdirSync(runnerTemp, { recursive: true });
  mkdirSync(scriptsDirectory, { recursive: true });
  mkdirSync(join(directory, 'dist'), { recursive: true });
  writeFileSync(join(scriptsDirectory, 'rehydrate-locale-shards.sh'), `#!/usr/bin/env bash\n${localeScript}\n`);
  writeFileSync(join(scriptsDirectory, 'rehydrate-section-shards.sh'), `#!/usr/bin/env bash\n${sectionScript}\n`);

  let status = 0;
  try {
    execFileSync('bash', ['-c', rehydrateStepScript()], {
      cwd: directory,
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summaryPath,
        REHYDRATE_MAX_PARALLEL: '1',
        REPO_VARS_JSON: '{}',
        RUNNER_TEMP: runnerTemp,
      },
      stdio: 'ignore',
    });
  } catch (error) {
    status = (error as { status?: number }).status ?? 1;
  }

  const summary = readFileSync(summaryPath, 'utf8');
  rmSync(directory, { recursive: true, force: true });
  return { status, summary };
}

describe('audit-dist-from-run rehydrate runtime budget observer', () => {
  it('records duration, outcome, active parallelism, and the comparison baseline', () => {
    const summary = observe(0, 0);

    expect(summary).toContain('### Rehydrate runtime budget');
    expect(summary).toMatch(/elapsed_seconds \| `\d+`/);
    expect(summary).toContain('outcome | `success`');
    expect(summary).toContain('REHYDRATE_MAX_PARALLEL | `1`');
    expect(summary).toContain('baseline `4`');
    expect(summary).toContain('workflow timeout `350 minutes`');
  });

  it('distinguishes locale failure from section degradation without changing the observer contract', () => {
    expect(observe(1, 0)).toContain('outcome | `locale-failed`');
    expect(observe(0, 1)).toContain('outcome | `sections-degraded`');
  });

  it('is called after both rehydrate commands and before the locale gate exit', () => {
    const run = rehydrateStepScript();
    const locale = run.indexOf('bash scripts/lib/rehydrate-locale-shards.sh 2>&1');
    const sections = run.indexOf('bash scripts/lib/rehydrate-section-shards.sh || SECTION_RC=$?');
    const observer = run.indexOf('rehydrateRuntimeBudgetObserved "$REHYDRATE_STARTED_AT" "$LOCALE_RC" "$SECTION_RC"');
    const exit = run.indexOf('if [ "$LOCALE_RC" -ne 0 ]; then exit "$LOCALE_RC"; fi');

    expect(locale).toBeGreaterThanOrEqual(0);
    expect(sections).toBeGreaterThan(locale);
    expect(observer).toBeGreaterThan(sections);
    expect(exit).toBeGreaterThan(observer);
  });

  it('hard-fails before the next audit step when the section rehydrate reports unsound dist', () => {
    const result = runRehydrateStep([
      'trunk_guard_verdict() { return 1; }',
      'if ! trunk_guard_verdict "section shard rehydrate"; then exit 1; fi',
    ].join('\n'));

    expect(result.status).toBe(1);
    expect(result.summary).toContain('outcome | `sections-degraded`');
  });

  it('keeps a documented nonfatal section degradation on the soft path', () => {
    const result = runRehydrateStep('echo "::warning::section shard clone failed"');

    expect(result.status).toBe(0);
    expect(result.summary).toContain('outcome | `success`');
    expect(result.summary).toContain('locale_rehydrate_completed | `true`');
    expect(result.summary).toContain('locale_rehydrate_enospc | `not-observed`');
  });

  it('records locale completion and ENOSPC while preserving the locale hard-fail', () => {
    const result = runRehydrateStep(
      'echo "section rehydrate reached"',
      'echo "No space left on device" >&2; exit 1',
    );

    expect(result.status).toBe(1);
    expect(result.summary).toContain('locale_rehydrate_completed | `false`');
    expect(result.summary).toContain('locale_rehydrate_enospc | `observed`');
    expect(result.summary).toContain('outcome | `locale-failed`');
  });
});
