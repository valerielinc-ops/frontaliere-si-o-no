import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { latestCompletedRunByName } from '../scripts/ci/lib/vitestCheck.mjs';
import {
  VITEST_CHECK_NAME,
  VITEST_EXECUTION_JOB_NAME,
} from '../scripts/ci/lib/constants.mjs';

type WorkflowStep = {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: { script?: string };
};

type WorkflowJob = {
  name?: string;
  if?: string;
  needs?: string[] | string;
  steps?: WorkflowStep[];
};

const workflowText = readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8');
const workflow = YAML.parse(workflowText) as {
  concurrency?: { group?: string };
  jobs?: Record<string, WorkflowJob>;
};
const jobs = workflow.jobs ?? {};
const codeJob = jobs.vitest;
const requiredJob = jobs['vitest-required'];
const bodyJob = jobs['body-contract'];

const contractStep = (job: WorkflowJob | undefined) =>
  job?.steps?.find((step) => step.name?.startsWith('PR-body completeness + multi-issue Closes'));

describe('tests.yml: body edit isolation', () => {
  it('keeps edited reachable and partitions its concurrency from synchronize', () => {
    const types = workflowText.match(/^[ \t]+types:\s*\[([^\]]+)\]/m)?.[1]
      ?.split(',')
      .map((type) => type.trim());
    expect(types).toContain('edited');
    expect(types).toContain('synchronize');

    const group = workflow.concurrency?.group ?? '';
    const lane = group.match(
      /\$\{\{\s*github\.event\.action\s*==\s*'edited'\s*&&\s*'([^']+)'\s*\|\|\s*github\.event\.action\s*==\s*'labeled'\s*&&\s*'([^']+)'\s*\|\|\s*'([^']+)'\s*\}\}/,
    );
    expect(lane, 'concurrency.group must assign metadata and code events to different lanes').toBeTruthy();
    if (!lane) return;

    const renderGroup = (action: 'edited' | 'labeled' | 'synchronize') =>
      group.replace(lane[0], action === 'edited' ? lane[1] : action === 'labeled' ? lane[2] : lane[3]);
    expect(lane[1]).toBe('body');
    expect(lane[2]).toBe('label');
    expect(lane[3]).toBe('code');
    expect(renderGroup('edited')).not.toBe(renderGroup('synchronize'));
    expect(renderGroup('labeled')).not.toBe(renderGroup('synchronize'));
    expect(renderGroup('edited')).not.toBe(renderGroup('labeled'));
  });

  it('keeps edited body isolation while the required wrapper checks prior code verdicts', () => {
    expect(codeJob?.name).toBe(VITEST_EXECUTION_JOB_NAME);
    expect(requiredJob?.name).toBe(VITEST_CHECK_NAME);
    expect(bodyJob?.name).toBe('PR body contract');
    expect(bodyJob?.name).not.toBe(VITEST_CHECK_NAME);

    expect(String(codeJob?.if).replace(/\s+/g, '')).toBe(
      "${{github.event.action!='edited'&&(github.event.action!='labeled'||contains(github.event.pull_request.labels.*.name,'stale-review'))}}",
    );
    expect(bodyJob?.if).toContain("github.event_name == 'pull_request'");
    expect(bodyJob?.if).toContain("github.event.action == 'edited'");

    const heavyContract = contractStep(codeJob);
    const editedContract = contractStep(bodyJob);
    expect(heavyContract?.uses).toBe('actions/github-script@v8');
    expect(editedContract?.uses).toBe('actions/github-script@v8');
    expect(editedContract?.with?.script).toBe(heavyContract?.with?.script);
    expect(bodyJob?.steps).toHaveLength(1);
    expect(bodyJob?.steps?.[0]?.name).toContain('PR-body completeness');
    expect(bodyJob?.steps?.[0]?.if).toContain('github.event_name ==');
    expect(bodyJob?.steps?.[0]?.if).not.toContain("github.event.action != 'edited'");

    expect(String(requiredJob?.if).replace(/\s+/g, '')).toBe('${{always()}}');
    expect(requiredJob?.needs).toEqual(['vitest']);

    // Il wrapper required non deve fidarsi dello skip: sui percorsi body-only
    // deve verificare lo storico dei check-run dello SHA corrente.
    const requiredRun = requiredJob?.steps?.find(
      (step) => step.name === 'Require vitest execution job to complete',
    )?.run;
    expect(requiredRun).toContain('gh api --paginate --slurp');
    expect(requiredRun).toContain('vitest execution');
    expect(requiredRun).toContain('latest_execution');

    expect(codeJob?.steps?.some((step) => step.name === 'Require approving Claude review')).toBe(true);
    const skippedReviewGuard = codeJob?.steps?.find(
      (step) => step.name === 'Fail when required review gate is skipped',
    );
    expect(skippedReviewGuard?.if).toContain('always()');
    expect(skippedReviewGuard?.if).toContain("steps.resolve.outputs.should_review == 'true'");
    expect(skippedReviewGuard?.if).toContain("steps.guard.outputs.skip != 'true'");
    expect(skippedReviewGuard?.if).toContain("steps.review_gate.outcome == 'skipped'");
    expect(skippedReviewGuard?.run).toContain('exit 1');
    expect(codeJob?.steps?.some((step) => step.name === 'Rebase near-merge PRs after review or stale rescue')).toBe(true);
  });

  it('rende bloccanti skip/cancel senza un precedente execution success', () => {
    const requiredStep = requiredJob?.steps?.find(
      (step) => step.name === 'Require vitest execution job to complete',
    );
    expect(requiredStep?.if).toContain('always()');
    expect(requiredStep?.run).toContain('EXECUTION_RESULT');
    expect(requiredStep?.run).toContain('exit 1');

    const runRequiredCheck = (executionResult: string, conclusions: string[] = []) => execFileSync(
      'bash',
      ['-euo', 'pipefail', '-c', requiredStep?.run ?? ''],
      {
        env: {
          ...process.env,
          EXECUTION_RESULT: executionResult,
          HEAD_SHA: 'head-sha-fixture',
          REPO: 'owner/repo',
          CHECK_RUNS_JSON: JSON.stringify([
            {
              check_runs: conclusions.map((conclusion, index) => ({
                name: 'vitest execution',
                status: 'completed',
                conclusion,
                completed_at: `2026-09-08T08:2${index}:00Z`,
              })),
            },
          ]),
        },
        stdio: 'ignore',
      },
    );

    expect(() => runRequiredCheck('failure'), 'failure deve bloccare').toThrow();
    expect(() => runRequiredCheck('skipped'), 'skip senza storico deve bloccare').toThrow();
    expect(() => runRequiredCheck('skipped', ['failure']), 'skip dopo failure deve bloccare').toThrow();
    expect(() => runRequiredCheck('skipped', ['success', 'failure']), 'un rosso successivo deve bloccare').toThrow();
    expect(() => runRequiredCheck('skipped', ['failure', 'success']), 'un verde successivo può soddisfare').not.toThrow();
    expect(() => runRequiredCheck('cancelled', ['cancelled']), 'cancel dopo cancel deve bloccare').toThrow();
    expect(() => runRequiredCheck('skipped', ['skipped']), 'skip storico non è un verdetto').toThrow();
    expect(() => runRequiredCheck('skipped', ['success'])).not.toThrow();
    expect(() => runRequiredCheck('cancelled', ['success'])).not.toThrow();
    expect(() => runRequiredCheck('success')).not.toThrow();
  });

  it('non interpreta skipped o assenza del check required sulla HEAD come verdetto', () => {
    expect(latestCompletedRunByName([
      {
        name: VITEST_CHECK_NAME,
        status: 'completed',
        conclusion: 'skipped',
        completed_at: '2026-09-08T08:20:00Z',
      },
    ], VITEST_CHECK_NAME)).toBeNull();
    expect(latestCompletedRunByName([], VITEST_CHECK_NAME)).toBeNull();
  });

  it('does not let the edited body check replace a code verdict', () => {
    const completed = latestCompletedRunByName(
      [
        {
          name: requiredJob?.name,
          status: 'completed',
          conclusion: 'failure',
          completed_at: '2026-09-08T08:20:00Z',
        },
        {
          name: bodyJob?.name,
          status: 'completed',
          conclusion: 'success',
          completed_at: '2026-09-08T08:20:05Z',
        },
        {
          name: requiredJob?.name,
          status: 'completed',
          conclusion: 'skipped',
          completed_at: '2026-09-08T08:20:10Z',
        },
      ],
      VITEST_CHECK_NAME,
    );
    expect(completed?.conclusion).toBe('failure');
  });
});
