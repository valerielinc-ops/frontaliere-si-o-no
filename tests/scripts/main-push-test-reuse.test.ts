import { describe, expect, it } from 'vitest';
import {
  decideMainPushTestReuse,
  hasSuccessfulRelatedVitest,
  hasTestPolicyChanges,
  latestPullRequestTestRun,
  RELATED_VITEST_STEP_NAME,
  testedMergeTreeFromAnnotations,
  TESTED_MERGE_TREE_ANNOTATION_TITLE,
} from '../../scripts/ci/lib/main-push-test-reuse.mjs';
import { VITEST_EXECUTION_JOB_NAME } from '../../scripts/ci/lib/constants.mjs';

const successfulJobs = () => [{
  name: VITEST_EXECUTION_JOB_NAME,
  status: 'completed',
  conclusion: 'success',
  completed_at: '2026-11-01T11:30:00Z',
  steps: [{
    name: RELATED_VITEST_STEP_NAME,
    status: 'completed',
    conclusion: 'success',
  }],
}];

const validEvidence = () => ({
  pushSha: 'merge-sha',
  pushSize: 1,
  pushCommits: [{ id: 'merge-sha' }],
  pullRequest: {
    state: 'closed',
    merged_at: '2026-11-01T12:00:00Z',
    merge_commit_sha: 'merge-sha',
    head: { sha: 'head-sha' },
    changed_files: 2,
  },
  pushTreeSha: 'same-tree',
  testedTreeSha: 'same-tree',
  changedFiles: [{ filename: 'src/example.ts' }, { filename: 'tests/example.test.ts' }],
  latestRun: {
    event: 'pull_request',
    head_sha: 'head-sha',
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-11-01T11:00:00Z',
    updated_at: '2026-11-01T11:30:00Z',
  },
  jobs: successfulJobs(),
});

describe('riuso del Vitest PR sui push a main', () => {
  it('accetta soltanto un merge singolo con tree e run PR identici e verdi', () => {
    expect(decideMainPushTestReuse(validEvidence())).toEqual({
      reuse: true,
      reason: 'exact PR-tested merge tree already passed the required Vitest run',
    });
  });

  it('non riusa su push multipli o payload commit non completo', () => {
    expect(decideMainPushTestReuse({
      ...validEvidence(),
      pushSize: 2,
      pushCommits: [{ id: 'merge-sha' }, { id: 'another-sha' }],
    }).reuse).toBe(false);
    expect(decideMainPushTestReuse({
      ...validEvidence(),
      pushCommits: [],
    }).reuse).toBe(false);
  });

  it('richiede la PR mergiata associata esattamente al commit pushato', () => {
    const evidence = validEvidence();
    expect(decideMainPushTestReuse({
      ...evidence,
      pullRequest: { ...evidence.pullRequest, merge_commit_sha: 'other-sha' },
    }).reuse).toBe(false);
    expect(decideMainPushTestReuse({
      ...evidence,
      pullRequest: { ...evidence.pullRequest, state: 'open' },
    }).reuse).toBe(false);
  });

  it('richiede la lista completa dei file della PR e rifiuta modifiche alla policy test', () => {
    const evidence = validEvidence();
    expect(decideMainPushTestReuse({
      ...evidence,
      changedFiles: evidence.changedFiles.slice(0, 1),
    }).reuse).toBe(false);
    expect(decideMainPushTestReuse({
      ...evidence,
      changedFiles: [...evidence.changedFiles, { filename: '.github/workflows/tests.yml' }],
    }).reuse).toBe(false);
    expect(hasTestPolicyChanges([{ filename: 'scripts/ci/lib/select-max-workers.mjs' }])).toBe(true);
    expect(hasTestPolicyChanges([{ filename: 'scripts/ci/verify-main-push-test-reuse.mjs' }])).toBe(true);
    for (const filename of [
      'tests/ci-vitest-check-name.test.ts',
      'tests/dataset-test-partition.test.ts',
      'tests/scripts/main-push-test-reuse.test.ts',
      'tests/scripts/select-max-workers.test.ts',
    ]) {
      expect(hasTestPolicyChanges([{ filename }]), filename).toBe(true);
    }
    expect(hasTestPolicyChanges([{
      filename: 'scripts/ci/new-runner.mjs',
      previous_filename: '.github/actions/ci-npm-setup/action.yml',
    }])).toBe(true);
    expect(hasTestPolicyChanges([{ filename: 'tests/example.test.ts' }])).toBe(false);
  });

  it('non riusa quando il tree del push non e quello testato sulla PR', () => {
    expect(decideMainPushTestReuse({
      ...validEvidence(),
      pushTreeSha: 'different-tree',
    }).reuse).toBe(false);
  });

  it('estrae il tree solo da un marker unico, valido e completo del check-run', () => {
    const marker = {
      title: TESTED_MERGE_TREE_ANNOTATION_TITLE,
      message: `tested-tree=${'a'.repeat(40)}`,
    };
    expect(testedMergeTreeFromAnnotations([marker])).toBe('a'.repeat(40));
    expect(testedMergeTreeFromAnnotations([[{ title: 'other', message: 'notice' }, marker]])).toBe('a'.repeat(40));
    expect(testedMergeTreeFromAnnotations([marker, marker])).toBeNull();
    expect(testedMergeTreeFromAnnotations([{
      ...marker,
      message: 'tested-tree=not-a-tree',
    }])).toBeNull();
    expect(testedMergeTreeFromAnnotations([])).toBeNull();
  });

  it('richiede l ultima run PR esatta, completata prima del merge e con Vitest verde', () => {
    const evidence = validEvidence();
    expect(decideMainPushTestReuse({
      ...evidence,
      latestRun: { ...evidence.latestRun, conclusion: 'failure' },
    }).reuse).toBe(false);
    expect(decideMainPushTestReuse({
      ...evidence,
      latestRun: { ...evidence.latestRun, updated_at: '2026-11-01T12:01:00Z' },
    }).reuse).toBe(true);
    expect(decideMainPushTestReuse({
      ...evidence,
      jobs: [{ ...successfulJobs()[0], completed_at: '2026-11-01T12:01:00Z' }],
    }).reuse).toBe(false);
    expect(decideMainPushTestReuse({ ...evidence, jobs: [] }).reuse).toBe(false);
    expect(hasSuccessfulRelatedVitest([{
      ...successfulJobs()[0],
      steps: [{ name: RELATED_VITEST_STEP_NAME, status: 'completed', conclusion: 'failure' }],
    }])).toBe(false);
  });

  it('seleziona la run PR piu recente per quell HEAD e rifiuta pagine incomplete', () => {
    const runs = [
      {
        id: 1,
        event: 'pull_request',
        head_sha: 'head-sha',
        created_at: '2026-11-01T10:00:00Z',
      },
      {
        id: 2,
        event: 'pull_request',
        head_sha: 'head-sha',
        created_at: '2026-11-01T11:00:00Z',
      },
      {
        id: 3,
        event: 'push',
        head_sha: 'head-sha',
        created_at: '2026-11-01T12:00:00Z',
      },
    ];
    expect(latestPullRequestTestRun({ total_count: 3, workflow_runs: runs }, 'head-sha')?.id).toBe(2);
    expect(latestPullRequestTestRun({ total_count: 4, workflow_runs: runs }, 'head-sha')).toBeNull();
    expect(latestPullRequestTestRun({ total_count: 3, workflow_runs: runs }, 'other-head')).toBeNull();
  });
});
