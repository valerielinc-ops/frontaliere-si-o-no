import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import {
  EVENT_DESCRIPTION_WORKFLOW_PATH,
  hasNewerEventDescriptionRun,
  isEventDescriptionRunCandidate,
  isUnstartedEventDescriptionRun,
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
    expect(steps[0].with['sparse-checkout']).toBe('scripts/ci/event-description-startup-recovery.mjs');
    expect(steps.at(-1).uses).toBe('actions/github-script@v9');
    expect(steps.at(-1).with.script).toContain('shouldRetryEventDescriptionRun');
    expect(steps.at(-1).with.script).toContain('reRunWorkflow');
  });
});
