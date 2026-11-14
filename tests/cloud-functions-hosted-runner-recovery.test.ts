import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import {
  HOSTED_RUNNER_ALLOCATION_MESSAGE,
  isHostedRunnerAllocationFailure,
  isUnstartedCloudFunctionsRun,
  isCloudFunctionsRunCandidate,
  listRecentCloudFunctionsRuns,
  shouldRetryCloudFunctionsRun,
} from '../scripts/ci/cloud-functions-hosted-runner-recovery.mjs';

const WORKFLOW_PATH = path.resolve(
  import.meta.dirname,
  '../.github/workflows/recover-cloud-functions-hosted-runner.yml',
);
const DEPLOY_WORKFLOW_PATH = path.resolve(
  import.meta.dirname,
  '../.github/workflows/deploy-cloud-functions.yml',
);
const RULES_DEPLOY_WORKFLOW_PATH = path.resolve(
  import.meta.dirname,
  '../.github/workflows/deploy-firestore-rules.yml',
);

const sourceRun = {
  id: 37517850000,
  conclusion: 'failure',
  event: 'push',
  head_branch: 'main',
  path: '.github/workflows/deploy-cloud-functions.yml',
  created_at: '2026-11-10T14:53:19Z',
  run_attempt: 1,
};

const unassignedJob = {
  id: 111948517226,
  name: 'deploy-functions',
  conclusion: 'cancelled',
  runner_id: 0,
  runner_name: '',
  steps: [],
};

const runnerAnnotation = [{ message: HOSTED_RUNNER_ALLOCATION_MESSAGE }];

describe('bounded Cloud Functions hosted-runner recovery', () => {
  it('recognizes the observed unassigned-runner signature', () => {
    expect(isCloudFunctionsRunCandidate(sourceRun)).toBe(true);
    expect(isHostedRunnerAllocationFailure(unassignedJob, runnerAnnotation)).toBe(true);
    expect(shouldRetryCloudFunctionsRun({
      run: sourceRun,
      jobs: [unassignedJob],
      annotationsByJob: { [String(unassignedJob.id)]: runnerAnnotation },
      workflowRuns: [],
    })).toBe(true);
  });

  it('recognizes a workflow that failed before Actions created its deploy job', () => {
    expect(isCloudFunctionsRunCandidate({ ...sourceRun, conclusion: 'startup_failure' })).toBe(true);
    expect(isUnstartedCloudFunctionsRun([])).toBe(true);
    expect(isUnstartedCloudFunctionsRun([
      { name: 'report', conclusion: 'skipped', steps: [] },
    ])).toBe(true);
    expect(shouldRetryCloudFunctionsRun({
      run: { ...sourceRun, conclusion: 'startup_failure' },
      jobs: [],
      annotationsByJob: {},
      workflowRuns: [],
    })).toBe(true);
  });

  it('does not replay a normal deploy failure or a concurrency cancellation', () => {
    const deployedFailure = {
      ...unassignedJob,
      conclusion: 'failure',
      runner_id: 42,
      runner_name: 'GitHub Actions 42',
      steps: [{ name: 'Deploy Cloud Functions', conclusion: 'failure' }],
    };
    expect(isHostedRunnerAllocationFailure(deployedFailure, runnerAnnotation)).toBe(false);
    expect(isUnstartedCloudFunctionsRun([deployedFailure])).toBe(false);
    expect(isHostedRunnerAllocationFailure(unassignedJob, [])).toBe(false);
    expect(isCloudFunctionsRunCandidate({ ...sourceRun, run_attempt: 2 })).toBe(false);
    expect(shouldRetryCloudFunctionsRun({
      run: sourceRun,
      jobs: [{ ...unassignedJob, conclusion: 'cancelled' }],
      annotationsByJob: { [String(unassignedJob.id)]: [] },
      workflowRuns: [],
    })).toBe(false);
  });

  it('does not treat a present deploy job as an unstarted run', () => {
    expect(isUnstartedCloudFunctionsRun([
      { name: 'deploy-functions', conclusion: 'skipped', steps: [] },
      { name: 'report', conclusion: 'skipped', steps: [] },
    ])).toBe(false);
    expect(shouldRetryCloudFunctionsRun({
      run: sourceRun,
      jobs: [{ name: 'deploy-functions', conclusion: 'failure', steps: [] }],
      annotationsByJob: {},
      workflowRuns: [],
    })).toBe(false);
  });

  it('refuses missing attempts and stale source SHAs when a newer main run exists', () => {
    expect(isCloudFunctionsRunCandidate({ ...sourceRun, run_attempt: undefined })).toBe(false);
    expect(isCloudFunctionsRunCandidate({ ...sourceRun, run_attempt: '1' })).toBe(false);
    expect(shouldRetryCloudFunctionsRun({
      run: sourceRun,
      jobs: [unassignedJob],
      annotationsByJob: { [String(unassignedJob.id)]: runnerAnnotation },
      workflowRuns: [{ id: sourceRun.id + 1, head_branch: 'main' }],
    })).toBe(false);
  });

  it('bounds the run listing and retries only transient GitHub server errors', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const waits: number[] = [];
    let attempts = 0;
    const github = {
      rest: {
        actions: {
          listWorkflowRuns: async (request: Record<string, unknown>) => {
            requests.push(request);
            attempts += 1;
            if (attempts === 1) {
              const error = new Error('Bad Gateway') as Error & { status?: number };
              error.status = 502;
              throw error;
            }
            return { data: { workflow_runs: [] } };
          },
        },
      },
    };

    await expect(listRecentCloudFunctionsRuns({
      github,
      repo: { owner: 'valerielinc-ops', repo: 'frontaliere-si-o-no' },
      run: sourceRun,
      core: { warning: () => {} },
      sleep: async (milliseconds: number) => waits.push(milliseconds),
    })).resolves.toEqual([]);

    expect(attempts).toBe(2);
    expect(waits).toEqual([500]);
    expect(requests[0]).toMatchObject({
      workflow_id: 'deploy-cloud-functions.yml',
      branch: 'main',
      created: '>=2026-11-10',
      per_page: 100,
    });
  });

  it('does not retry non-transient or exhausted run-list errors', async () => {
    let attempts = 0;
    const github = {
      rest: {
        actions: {
          listWorkflowRuns: async () => {
            attempts += 1;
            const error = new Error('Forbidden') as Error & { status?: number };
            error.status = 403;
            throw error;
          },
        },
      },
    };
    await expect(listRecentCloudFunctionsRuns({
      github,
      repo: { owner: 'valerielinc-ops', repo: 'frontaliere-si-o-no' },
      run: sourceRun,
      sleep: async () => {},
    })).rejects.toMatchObject({ status: 403 });
    expect(attempts).toBe(1);
  });

  it('pins the recovery workflow to the source workflow and keeps deploys newest-safe', () => {
    const recovery = parse(fs.readFileSync(WORKFLOW_PATH, 'utf8')) as any;
    const deploy = parse(fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8')) as any;
    expect(recovery.on.workflow_run).toEqual({
      workflows: ['Deploy Cloud Functions'],
      types: ['completed'],
    });
    expect(recovery.permissions).toMatchObject({ actions: 'write', checks: 'read' });
    expect(recovery.jobs.retry.if).toContain("run_attempt == 1");
    expect(recovery.jobs.retry.if).toContain("startup_failure");
    expect(recovery.jobs.retry.steps[0].with['sparse-checkout']).toContain('scripts/ci/lib/workflow-run-list-recovery.mjs');
    expect(recovery.jobs.retry.steps[0].with['sparse-checkout']).toContain('scripts/load-rc-env.mjs');
    expect(recovery.jobs.retry.steps[0].with['sparse-checkout']).toContain('scripts/lib/google-service-account-token.mjs');
    expect(recovery.jobs.retry.steps[0].with['sparse-checkout']).toContain('scripts/lib/fetch-with-ref-timeout.mjs');
    expect(recovery.jobs.retry.steps[0].with['sparse-checkout']).toContain('scripts/lib/remote-config-template-url.mjs');
    const recoveryTokenStep = recovery.jobs.retry.steps.find((step: any) => step.name === 'Load recovery API token from Remote Config');
    expect(recoveryTokenStep?.run).toContain('node scripts/load-rc-env.mjs --only-env=GITHUB_PAT');
    const recoveryScript = recovery.jobs.retry.steps.at(-1).with.script;
    expect(recoveryScript).toContain("getOctokit(recoveryToken)");
    expect(recoveryScript).toContain('process.env.GITHUB_PAT');
    expect(recoveryScript).toContain('recoveryGithub.rest.actions.listJobsForWorkflowRunAttempt');
    expect(recoveryScript).toContain('recoveryGithub.rest.checks.listAnnotations');
    expect(recoveryScript).toContain('recoveryGithub.rest.actions.reRunWorkflow');
    expect(recoveryScript).not.toContain('github.rest.actions.listJobsForWorkflowRunAttempt');
    expect(recovery.jobs.retry.steps.at(-1).uses).toBe('actions/github-script@v9');
    expect(recoveryScript).toContain('shouldRetryCloudFunctionsRun');
    expect(recoveryScript).toContain('startup/runner recovery signature');
    expect(recoveryScript).toContain('listRecentCloudFunctionsRuns');
    expect(recoveryScript).not.toContain('github.paginate(\n              github.rest.actions.listWorkflowRuns');
    expect(deploy.concurrency['cancel-in-progress']).toBe(false);
  });

  it.each([
    ['Cloud Functions', DEPLOY_WORKFLOW_PATH],
    ['Firestore/Storage rules', RULES_DEPLOY_WORKFLOW_PATH],
  ])('retries the %s sparse checkout once before deploy logic', (label, workflowPath) => {
    const workflow = parse(fs.readFileSync(workflowPath, 'utf8')) as any;
    const job = Object.values(workflow.jobs)[0] as any;
    const steps = job.steps as Array<Record<string, any>>;
    const primary = steps.find((step) => step.id === 'checkout_primary');
    const retry = steps.find((step) => step.id === 'checkout_retry');
    const backoff = steps.find((step) => step.name === 'Backoff 30s before checkout retry');
    const ready = steps.find((step) => step.id === 'checkout');
    const setupNodeIndex = steps.findIndex((step) => step.name === 'Setup Node.js');

    expect(primary).toMatchObject({
      uses: 'actions/checkout@v7',
      'continue-on-error': true,
    });
    if (label === 'Cloud Functions') {
      const profile = String(primary?.with?.['sparse-checkout']);
      expect(profile).toContain('/*');
      expect(profile).toContain('!/public/images/');
      expect(profile).toContain('!/data/jobs/');
      expect(primary?.with?.['sparse-checkout-cone-mode']).toBe(false);
    } else {
      expect(String(primary?.with?.['sparse-checkout'])).toContain('/*');
      expect(primary?.with?.['sparse-checkout-cone-mode']).toBe(false);
    }
    expect(retry).toMatchObject({
      uses: 'actions/checkout@v7',
      if: "steps.checkout_primary.outcome == 'failure'",
    });
    expect(retry?.['continue-on-error']).toBeUndefined();
    expect(retry?.with?.['sparse-checkout']).toBe(primary?.with?.['sparse-checkout']);
    expect(backoff).toMatchObject({
      if: "steps.checkout_primary.outcome == 'failure'",
    });
    expect(backoff?.run).toContain('sleep 30');
    expect(ready?.if).toContain('always()');
    expect(ready?.if).toContain("steps.checkout_retry.outcome == 'success'");
    expect(setupNodeIndex).toBeGreaterThan(steps.indexOf(ready));

    const report = steps.find((step) => step.name === 'Report failure to GitHub Issues');
    expect(report?.if).toContain("steps.checkout_primary.outcome == 'success'");
    expect(report?.if).toContain("steps.checkout_retry.outcome == 'success'");
  });
});
