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

async function runRecovery({ body = 'failure', status = 'completed', conclusion = 'failure', changedHead = false, changedAttempt = false, finishing = false, olderFailed = false, workflowRuns = 'existing' } = {}) {
  const reruns: number[] = [];
  const dispatches: unknown[] = [];
  let reads = 0;
  const run = { id: 42, status, conclusion, run_attempt: 1, event: 'pull_request' };
  const manualRun = { ...run, id: 43, event: 'workflow_dispatch' };
  const github = {
    rest: {
      pulls: { get: async () => ({ data: { state: 'open', head: { sha: ++reads > 1 && changedHead ? 'new' : 'head', ref: 'fork-branch' }, base: { ref: 'main' } } }) },
      actions: {
        listWorkflowRuns: 'runs', listJobsForWorkflowRun: 'jobs',
        getWorkflowRun: async ({ run_id }: { run_id: number }) => ({ data: { ...run, id: run_id, status: finishing ? 'completed' : status, conclusion: finishing ? 'failure' : conclusion, run_attempt: changedAttempt ? 2 : 1 } }),
        reRunWorkflow: async ({ run_id }: { run_id: number }) => { reruns.push(run_id); },
        createWorkflowDispatch: async (input: unknown) => { dispatches.push(input); },
      },
    },
    paginate: async (endpoint: string) => endpoint === 'runs'
      ? workflowRuns === 'none'
        ? []
        : workflowRuns === 'mixed'
          ? [run, manualRun]
          : olderFailed
            ? [run, { id: 41, status: 'completed', conclusion: 'failure', run_attempt: 1, event: 'pull_request' }]
            : [run]
      : [{ conclusion, steps: [{ name: 'PR-body completeness + multi-issue Closes (no checkout, all events)', conclusion: body }] }],
  };
  await new AsyncFunction('github', 'context', 'core', script)(github, {
    repo: { owner: 'owner', repo: 'repo' }, payload: { pull_request: { number: 1, head: { sha: 'head' } } },
  }, { info: () => undefined });
  return { reruns, dispatches };
}

describe('one code verdict and metadata-triggered review recovery', () => {
  it('has exactly one unconditional required execution job and reviews edited PR metadata', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['vitest']);
    expect(job.name).toBe(VITEST_CHECK_NAME);
    expect(job.name).toBe(VITEST_EXECUTION_JOB_NAME);
    expect(job.if).toBeUndefined();
    expect(workflow.on.pull_request.types).not.toContain('labeled');
    // Un `edited` lascia l'HEAD invariato: far ripartire questa run rimisura
    // codice identico. Erano 38 delle 116 run su PR (33%) nelle ultime 200,
    // 14 minuti l'una. La rivalidazione dopo una correzione del body resta a
    // retry-code-check-after-body-edit.yml, che riesegue la run fallita e solo
    // quella.
    expect(workflow.on.pull_request.types).not.toContain('edited');
    expect(workflow.on.pull_request.types).toContain('synchronize');
    expect(workflow.on.workflow_dispatch.inputs.head_sha).toEqual(expect.objectContaining({ type: 'string' }));
    expect(workflow.concurrency.group).toContain('inputs.head_sha');
    const guard = job.steps.find((step: { name?: string }) => step.name?.startsWith('Re-review guard')) as { env?: Record<string, string>; run?: string } | undefined;
    expect(guard?.run).toContain('node scripts/ci/lib/pr-review-admission.mjs skip');
    expect(guard?.run).toContain('gh api "repos/$REPO/pulls/$PR_NUMBER/reviews"');
    expect(guard?.run).not.toContain('PR metadata modificata → review piena sulla revisione corrente del review input.');
    expect(guard?.env?.EVENT_ACTION).toBeUndefined();
  });

  it('rejects the current PR body before checkout and guards independent steps after failure', () => {
    const first = job.steps[0];
    expect(first.id).toBe('body_contract');
    expect(first.uses).toBe('actions/github-script@v8');
    expect(first.with.script).toContain('github.rest.pulls.get');
    expect(first.with.script).toContain('currentPr.body');
    expect(job.steps.findIndex((step: { uses?: string }) => step.uses?.startsWith('actions/checkout@'))).toBeGreaterThan(0);
    for (const step of job.steps.slice(1)) {
      // This collector is deliberately unconditional: it must publish the
      // verdict of detached gates even when the body preflight failed.
      if (step.id === 'collect-independent-gates') {
        expect(step.if).toContain('always()');
        continue;
      }
      if (step.name === 'Classify cancelled run') {
        expect(step.if).toContain('always()');
        expect(step.if).toContain('cancelled()');
        continue;
      }
      if (step.if) expect(step.if).toContain("steps.body_contract.outcome != 'failure'");
    }
    expect(job.steps.some((step: { name?: string }) => step.name === 'Require approving Codex review')).toBe(true);
    expect(job.steps.some((step: { name?: string }) => step.name === 'Fail when required review gate is skipped')).toBe(true);
  });

  it('keeps a fail-closed roster for detached source gates', () => {
    const launcher = job.steps.find((step: { id?: string }) => step.id === 'independent-gates');
    const collector = job.steps.find((step: { id?: string }) => step.id === 'collect-independent-gates');
    expect(launcher?.run).toEqual(expect.any(String));
    expect(collector?.run).toEqual(expect.any(String));

    const launchScript = launcher.run as string;
    const collectScript = collector.run as string;
    expect(launchScript).toContain('expected_labels=()');
    expect(launchScript).toContain('expected_labels+=(tsc)');
    expect(launchScript).toContain('expected_labels+=(audit-markers)');
    expect(launchScript).toContain('expected_labels+=(action-runtimes)');
    expect(launchScript).toContain('expected_labels+=(input-injection)');
    expect(launchScript).toContain('expected_labels+=(locale-segments)');
    expect(launchScript).toContain('expected_labels+=(evergreen-topics)');
    expect(launchScript).not.toContain('>> "$state_dir/labels"');
    expect(collectScript).toContain('expected_file="$state_dir/expected-labels"');
    expect(collectScript).toContain('expected roster is missing or empty');
    expect(collectScript).toContain('done < "$expected_file"');
    expect(collectScript).not.toContain('if [ -s "$state_dir/labels" ]');
  });

  it('runs only API recovery from trusted main, without publishing a PR-head check', () => {
    expect(recovery.on).toEqual({ pull_request_target: { types: ['edited'] } });
    expect(recovery.jobs.recover.if).toBe('github.event.changes.body != null');
    expect(recovery.jobs.recover.steps).toHaveLength(1);
    expect(script).not.toContain('createCheckRun');
    expect(script).not.toContain('exec(');
  });

  it('retries a failed body preflight after an edit', async () => {
    expect(await runRecovery()).toEqual({ reruns: [42], dispatches: [] });
  });

  it('dispatches tests.yml on the trusted base ref and passes the exact PR head when no run exists', async () => {
    expect(await runRecovery({ workflowRuns: 'none' })).toEqual({
      reruns: [],
      dispatches: [{ owner: 'owner', repo: 'repo', workflow_id: 'tests.yml', ref: 'main', inputs: { pr_number: '1', head_sha: 'head' } }],
    });
  });

  it('preserves passing body verdicts, running tests and failures later in the pipeline', async () => {
    expect(await runRecovery({ body: 'success' })).toEqual({ reruns: [], dispatches: [] });
    expect(await runRecovery({ body: 'success', status: 'in_progress', conclusion: '' })).toEqual({ reruns: [], dispatches: [] });
    expect(await runRecovery({ body: 'success', conclusion: 'success' })).toEqual({ reruns: [], dispatches: [] });
    expect(await runRecovery({ body: 'skipped' })).toEqual({ reruns: [], dispatches: [] });
  });

  it('preserves a newer queued attempt instead of rerunning an older failed body', async () => {
    expect(await runRecovery({ status: 'queued', body: '', conclusion: '', olderFailed: true })).toEqual({ reruns: [], dispatches: [] });
  });

  it('recovers an edit arriving while the failed preflight is finishing', async () => {
    expect(await runRecovery({ status: 'in_progress', conclusion: '', finishing: true })).toEqual({ reruns: [42], dispatches: [] });
  });

  it('does not restart an old head or an attempt already retried', async () => {
    expect(await runRecovery({ changedHead: true })).toEqual({ reruns: [], dispatches: [] });
    expect(await runRecovery({ changedAttempt: true })).toEqual({ reruns: [], dispatches: [] });
  });

  it('does not dispatch when the head already has pull_request and manual runs', async () => {
    expect(await runRecovery({ workflowRuns: 'mixed' })).toEqual({ reruns: [43], dispatches: [] });
  });
});
