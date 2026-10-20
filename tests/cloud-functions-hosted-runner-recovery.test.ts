import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import {
  HOSTED_RUNNER_ALLOCATION_MESSAGE,
  isHostedRunnerAllocationFailure,
  isCloudFunctionsRunCandidate,
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

const sourceRun = {
  id: 37517850000,
  conclusion: 'failure',
  event: 'push',
  head_branch: 'main',
  path: '.github/workflows/deploy-cloud-functions.yml',
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

  it('does not replay a normal deploy failure or a concurrency cancellation', () => {
    const deployedFailure = {
      ...unassignedJob,
      conclusion: 'failure',
      runner_id: 42,
      runner_name: 'GitHub Actions 42',
      steps: [{ name: 'Deploy Cloud Functions', conclusion: 'failure' }],
    };
    expect(isHostedRunnerAllocationFailure(deployedFailure, runnerAnnotation)).toBe(false);
    expect(isHostedRunnerAllocationFailure(unassignedJob, [])).toBe(false);
    expect(isCloudFunctionsRunCandidate({ ...sourceRun, run_attempt: 2 })).toBe(false);
    expect(shouldRetryCloudFunctionsRun({
      run: sourceRun,
      jobs: [{ ...unassignedJob, conclusion: 'cancelled' }],
      annotationsByJob: { [String(unassignedJob.id)]: [] },
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

  it('pins the recovery workflow to the source workflow and keeps deploys newest-safe', () => {
    const recovery = parse(fs.readFileSync(WORKFLOW_PATH, 'utf8')) as any;
    const deploy = parse(fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8')) as any;
    expect(recovery.on.workflow_run).toEqual({
      workflows: ['Deploy Cloud Functions'],
      types: ['completed'],
    });
    expect(recovery.permissions).toMatchObject({ actions: 'write', checks: 'read' });
    expect(recovery.jobs.retry.if).toContain("run_attempt == 1");
    expect(recovery.jobs.retry.steps.at(-1).uses).toBe('actions/github-script@v9');
    expect(recovery.jobs.retry.steps.at(-1).with.script).toContain('shouldRetryCloudFunctionsRun');
    expect(deploy.concurrency['cancel-in-progress']).toBe(false);
  });
});
