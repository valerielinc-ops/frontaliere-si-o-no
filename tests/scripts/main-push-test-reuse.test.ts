import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
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
  it('carica i dettagli della PR prima di richiedere il conteggio file completo', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'main-push-test-reuse-'));
    try {
      const pushSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const pushTreeSha = execFileSync('git', ['rev-parse', `${pushSha}^{tree}`], { encoding: 'utf8' }).trim();
      const headSha = 'b'.repeat(40);
      const mergeAt = '2026-11-12T09:30:00Z';
      const associatedPr = {
        number: 42,
        state: 'closed',
        merged_at: mergeAt,
        merge_commit_sha: pushSha,
        head: { sha: headSha },
        // GET /commits/{sha}/pulls does not return changed_files.
        changed_files: null,
      };
      const detailedPr = { ...associatedPr, changed_files: 2 };
      const files = [{ filename: 'src/example.ts' }, { filename: 'tests/example.test.ts' }];
      const responses = {
        [`repos/owner/repo/commits/${pushSha}/pulls`]: [associatedPr],
        'repos/owner/repo/pulls/42': detailedPr,
        'repos/owner/repo/pulls/42/files': files,
        'repos/owner/repo/actions/workflows/tests.yml/runs': {
          total_count: 1,
          workflow_runs: [{
            id: 99,
            event: 'pull_request',
            head_sha: headSha,
            status: 'completed',
            conclusion: 'success',
            created_at: '2026-11-12T08:00:00Z',
          }],
        },
        'repos/owner/repo/actions/runs/99/jobs': {
          total_count: 1,
          jobs: [{
            id: 100,
            name: VITEST_EXECUTION_JOB_NAME,
            status: 'completed',
            conclusion: 'success',
            completed_at: '2026-11-12T09:00:00Z',
            steps: [{
              name: RELATED_VITEST_STEP_NAME,
              status: 'completed',
              conclusion: 'success',
            }],
          }],
        },
        'repos/owner/repo/check-runs/100/annotations': [[{
          title: TESTED_MERGE_TREE_ANNOTATION_TITLE,
          message: `tested-tree=${pushTreeSha}`,
        }]],
      };
      const binDir = join(tempDir, 'bin');
      mkdirSync(binDir);
      const fakeGhPath = join(binDir, 'gh');
      writeFileSync(fakeGhPath, [
        '#!/usr/bin/env node',
        "const { appendFileSync, readFileSync } = require('node:fs');",
        "const endpoint = process.argv.find((arg) => arg.startsWith('repos/'));",
        "appendFileSync(process.env.GH_ENDPOINT_LOG, `${endpoint}\\n`);",
        "const responses = JSON.parse(readFileSync(process.env.GH_TEST_RESPONSES, 'utf8'));",
        'if (!Object.hasOwn(responses, endpoint)) process.exit(2);',
        'process.stdout.write(JSON.stringify(responses[endpoint]));',
        '',
      ].join('\n'));
      chmodSync(fakeGhPath, 0o755);

      const eventPath = join(tempDir, 'event.json');
      const outputPath = join(tempDir, 'github-output');
      const responsesPath = join(tempDir, 'responses.json');
      const endpointsPath = join(tempDir, 'endpoints.log');
      writeFileSync(eventPath, JSON.stringify({
        before: 'a'.repeat(40),
        after: pushSha,
        size: 1,
        commits: [{ id: pushSha }],
      }));
      writeFileSync(outputPath, '');
      writeFileSync(responsesPath, JSON.stringify(responses));

      const result = spawnSync(process.execPath, [resolve('scripts/ci/verify-main-push-test-reuse.mjs')], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH || ''}`,
          GITHUB_REPOSITORY: 'owner/repo',
          GITHUB_SHA: pushSha,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: outputPath,
          GH_TEST_RESPONSES: responsesPath,
          GH_ENDPOINT_LOG: endpointsPath,
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Main push Vitest reuse: true');
      expect(readFileSync(outputPath, 'utf8')).toContain('reuse=true');
      const endpoints = readFileSync(endpointsPath, 'utf8').trim().split('\n');
      expect(endpoints.indexOf('repos/owner/repo/pulls/42')).toBeGreaterThan(-1);
      expect(endpoints.indexOf('repos/owner/repo/pulls/42'))
        .toBeLessThan(endpoints.indexOf('repos/owner/repo/pulls/42/files'));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

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
