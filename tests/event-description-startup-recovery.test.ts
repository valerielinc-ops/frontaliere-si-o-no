import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import {
  EVENT_DESCRIPTION_WORKFLOW_PATH,
  hasNewerEventDescriptionRun,
  isEventDescriptionRunCandidate,
  isUnstartedEventDescriptionRun,
  listRecentEventDescriptionRuns,
  shouldRetryEventDescriptionRun,
} from '../scripts/ci/event-description-startup-recovery.mjs';

const RECOVERY_WORKFLOW_PATH = path.resolve(
  import.meta.dirname,
  '../.github/workflows/recover-event-description-startup-failure.yml',
);

const sourceRun = {
  id: 42671592875,
  conclusion: 'failure',
  event: 'workflow_dispatch',
  head_branch: 'main',
  path: EVENT_DESCRIPTION_WORKFLOW_PATH,
  created_at: '2026-11-10T14:53:19Z',
  run_attempt: 1,
};

const skippedDependentJobs = [
  { id: 1, name: 'rewrite', conclusion: 'skipped', steps: [] },
  { id: 2, name: 'merge', conclusion: 'skipped', steps: [] },
];

describe('bounded event-description startup recovery', () => {
  it('recognizes the observed failure where only skipped dependents exist', () => {
    expect(isUnstartedEventDescriptionRun(skippedDependentJobs)).toBe(true);
    expect(shouldRetryEventDescriptionRun({
      run: sourceRun,
      jobs: skippedDependentJobs,
      workflowRuns: [sourceRun],
    })).toBe(true);
  });

  it('also recognizes a genuinely empty jobs payload for the same run', () => {
    expect(isUnstartedEventDescriptionRun([])).toBe(true);
    expect(shouldRetryEventDescriptionRun({
      run: sourceRun,
      jobs: [],
      workflowRuns: [sourceRun],
    })).toBe(true);
  });

  it('does not replay a real job failure or a run whose plan job exists', () => {
    expect(isUnstartedEventDescriptionRun([
      { name: 'rewrite', conclusion: 'failure', steps: [{ name: 'Rewrite', conclusion: 'failure' }] },
    ])).toBe(false);
    expect(isUnstartedEventDescriptionRun([
      { name: 'plan', conclusion: 'failure', steps: [] },
      ...skippedDependentJobs,
    ])).toBe(false);
    expect(shouldRetryEventDescriptionRun({
      run: sourceRun,
      jobs: [{ name: 'rewrite', conclusion: 'failure', steps: [] }],
      workflowRuns: [sourceRun],
    })).toBe(false);
  });

  it('keeps the candidate and newer-run guards fail-closed', () => {
    expect(isEventDescriptionRunCandidate({ ...sourceRun, run_attempt: 2 })).toBe(false);
    expect(isEventDescriptionRunCandidate({ ...sourceRun, event: 'push' })).toBe(false);
    expect(isEventDescriptionRunCandidate({ ...sourceRun, path: '.github/workflows/other.yml' })).toBe(false);
    expect(hasNewerEventDescriptionRun(sourceRun, [
      sourceRun,
      { ...sourceRun, id: sourceRun.id + 1 },
    ])).toBe(true);
    expect(shouldRetryEventDescriptionRun({
      run: sourceRun,
      jobs: skippedDependentJobs,
      workflowRuns: [{ ...sourceRun, id: sourceRun.id + 1 }],
    })).toBe(false);
    expect(shouldRetryEventDescriptionRun({
      run: sourceRun,
      jobs: skippedDependentJobs,
      workflowRuns: null,
    })).toBe(false);
  });

  it('does not replay after the same run has advanced to a newer attempt', () => {
    expect(shouldRetryEventDescriptionRun({
      run: {
        id: 7,
        run_attempt: 1,
        conclusion: 'failure',
        path: EVENT_DESCRIPTION_WORKFLOW_PATH,
        head_branch: 'main',
        event: 'schedule',
      },
      workflowRuns: [{
        id: 7,
        run_attempt: 2,
        head_branch: 'main',
        path: EVENT_DESCRIPTION_WORKFLOW_PATH,
      }],
      jobs: [],
    })).toBe(false);
  });

  it('uses the bounded shared run listing for transient GitHub failures', async () => {
    let attempts = 0;
    const waits: number[] = [];
    const github = {
      rest: {
        actions: {
          listWorkflowRuns: async () => {
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
    await expect(listRecentEventDescriptionRuns({
      github,
      repo: { owner: 'valerielinc-ops', repo: 'frontaliere-si-o-no' },
      run: sourceRun,
      core: { warning: () => {} },
      sleep: async (milliseconds: number) => waits.push(milliseconds),
    })).resolves.toEqual([]);
    expect(attempts).toBe(2);
    expect(waits).toEqual([500]);
  });

  it('pins the observer to the source workflow and grants only bounded Actions write access', () => {
    const workflow = parse(fs.readFileSync(RECOVERY_WORKFLOW_PATH, 'utf8')) as any;
    expect(workflow.on.workflow_run).toEqual({
      workflows: ['Rewrite event descriptions (Codex Luna Max)'],
      types: ['completed'],
    });
    expect(workflow.permissions).toMatchObject({ actions: 'write', contents: 'read' });
    expect(workflow.jobs.retry.if).toContain("run_attempt == 1");
    const steps = workflow.jobs.retry.steps;
    expect(steps[0]).toMatchObject({ uses: 'actions/checkout@v7' });
    expect(steps[0].with['sparse-checkout']).toContain('scripts/ci/event-description-startup-recovery.mjs');
    expect(steps[0].with['sparse-checkout']).toContain('scripts/ci/lib/workflow-run-list-recovery.mjs');
    expect(steps[0].with['sparse-checkout']).toContain('scripts/load-rc-env.mjs');
    expect(steps[0].with['sparse-checkout']).toContain('scripts/lib/google-service-account-token.mjs');
    expect(steps[0].with['sparse-checkout']).toContain('scripts/lib/fetch-with-ref-timeout.mjs');
    expect(steps[0].with['sparse-checkout']).toContain('scripts/lib/remote-config-template-url.mjs');
    const loadRecoveryToken = steps.find((step: any) => step.name === 'Load recovery API token from Remote Config');
    expect(loadRecoveryToken?.run).toContain('node scripts/load-rc-env.mjs --only-env=GITHUB_PAT');
    const recovery = steps.at(-1).with.script;
    expect(recovery).toContain("getOctokit(recoveryToken)");
    expect(recovery).toContain('process.env.GITHUB_PAT');
    expect(recovery).toContain('recoveryGithub.rest.actions.listJobsForWorkflowRunAttempt');
    expect(recovery).toContain('recoveryGithub.rest.actions.reRunWorkflow');
    expect(recovery).not.toContain('github.rest.actions.listJobsForWorkflowRunAttempt');
    expect(steps.at(-1).uses).toBe('actions/github-script@v9');
    expect(recovery).toContain('listRecentEventDescriptionRuns');
    expect(recovery).toContain('shouldRetryEventDescriptionRun');
    expect(recovery).toContain('reRunWorkflow');
  });
});
