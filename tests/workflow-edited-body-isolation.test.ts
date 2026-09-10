import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { VITEST_CHECK_NAME, VITEST_EXECUTION_JOB_NAME } from '../scripts/ci/lib/constants.mjs';

const readWorkflow = (name: string) => YAML.parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
const workflow = readWorkflow('tests.yml');
const job = workflow.jobs.vitest;
const recovery = readWorkflow('retry-code-check-after-body-edit.yml');
const script = recovery.jobs.recover.steps[0].with.script;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function runRecovery({ body = 'failure', status = 'completed', conclusion = 'failure', changedHead = false, changedAttempt = false, finishing = false } = {}) {
  const reruns: number[] = [];
  let reads = 0;
  const run = { id: 42, status, conclusion, run_attempt: 1 };
  const github = {
    rest: {
      pulls: { get: async () => ({ data: { state: 'open', head: { sha: ++reads > 1 && changedHead ? 'new' : 'head' } } }) },
      actions: {
        listWorkflowRuns: 'runs', listJobsForWorkflowRun: 'jobs',
        getWorkflowRun: async () => ({ data: { ...run, status: finishing ? 'completed' : status, conclusion: finishing ? 'failure' : conclusion, run_attempt: changedAttempt ? 2 : 1 } }),
        reRunWorkflow: async ({ run_id }: { run_id: number }) => { reruns.push(run_id); },
      },
    },
    paginate: async (endpoint: string) => endpoint === 'runs' ? [run] : [{ conclusion, steps: [{ name: 'PR-body completeness + multi-issue Closes (no checkout, all events)', conclusion: body }] }],
  };
  await new AsyncFunction('github', 'context', 'core', script)(github, {
    repo: { owner: 'owner', repo: 'repo' }, payload: { pull_request: { number: 1, head: { sha: 'head' } } },
  }, { info: () => undefined });
  return reruns;
}

describe('one code verdict and selective body recovery', () => {
  it('has exactly one unconditional required execution job and no metadata triggers', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['vitest']);
    expect(job.name).toBe(VITEST_CHECK_NAME);
    expect(job.name).toBe(VITEST_EXECUTION_JOB_NAME);
    expect(job.if).toBeUndefined();
    expect(workflow.on.pull_request.types).not.toContain('edited');
    expect(workflow.on.pull_request.types).not.toContain('labeled');
    expect(workflow.on.pull_request.types).toContain('synchronize');
  });

  it('rejects the current PR body before checkout and guards independent steps after failure', () => {
    const first = job.steps[0];
    expect(first.id).toBe('body_contract');
    expect(first.uses).toBe('actions/github-script@v8');
    expect(first.with.script).toContain('github.rest.pulls.get');
    expect(first.with.script).toContain('currentPr.body');
    expect(job.steps.findIndex((step: { uses?: string }) => step.uses?.startsWith('actions/checkout@'))).toBeGreaterThan(0);
    for (const step of job.steps.slice(1)) {
      if (step.if) expect(step.if).toContain("steps.body_contract.outcome != 'failure'");
    }
    expect(job.steps.some((step: { name?: string }) => step.name === 'Require approving Claude review')).toBe(true);
    expect(job.steps.some((step: { name?: string }) => step.name === 'Fail when required review gate is skipped')).toBe(true);
  });

  it('runs only API recovery from trusted main, without publishing a PR-head check', () => {
    expect(recovery.on).toEqual({ pull_request_target: { types: ['edited'] } });
    expect(recovery.jobs.recover.if).toBe('github.event.changes.body != null');
    expect(recovery.jobs.recover.steps).toHaveLength(1);
    expect(script).not.toContain('createCheckRun');
    expect(script).not.toContain('exec(');
  });

  it('retries a failed body preflight after an edit', async () => {
    expect(await runRecovery()).toEqual([42]);
  });

  it('preserves passing body verdicts, running tests and failures later in the pipeline', async () => {
    expect(await runRecovery({ body: 'success' })).toEqual([]);
    expect(await runRecovery({ body: 'success', status: 'in_progress', conclusion: '' })).toEqual([]);
    expect(await runRecovery({ body: 'success', conclusion: 'success' })).toEqual([]);
    expect(await runRecovery({ body: 'skipped' })).toEqual([]);
  });

  it('recovers an edit arriving while the failed preflight is finishing', async () => {
    expect(await runRecovery({ status: 'in_progress', conclusion: '', finishing: true })).toEqual([42]);
  });

  it('does not restart an old head or an attempt already retried', async () => {
    expect(await runRecovery({ changedHead: true })).toEqual([]);
    expect(await runRecovery({ changedAttempt: true })).toEqual([]);
  });
});
