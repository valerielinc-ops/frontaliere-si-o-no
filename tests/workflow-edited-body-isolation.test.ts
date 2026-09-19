import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { VITEST_CHECK_NAME, VITEST_EXECUTION_JOB_NAME } from '../scripts/ci/lib/constants.mjs';
import { reviewInputRevisionFromBody } from '../scripts/ci/lib/review-input-revision.mjs';

const readWorkflow = (name: string) => YAML.parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
const workflow = readWorkflow('tests.yml');
const job = workflow.jobs.vitest;
const recovery = readWorkflow('retry-code-check-after-body-edit.yml');
const script = recovery.jobs.recover.steps[0].with.script;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const require = createRequire(import.meta.url);

async function runRecovery({ body = 'failure', status = 'completed', conclusion = 'failure', changedHead = false, changedAttempt = false, finishing = false, olderFailed = false, workflowRuns = 'existing', eventName = 'pull_request_target', pendingStatus = null, rerunFails = false, dispatchFails = false, eventRunId = 42, eventRunAttempt = 1, nativeAutoMerge = false } = {}) {
  const reruns: number[] = [];
  const dispatches: unknown[] = [];
  const callOrder: string[] = [];
  let nativeAutoMergeRevoked = false;
  let reads = 0;
  const run = { id: 42, status, conclusion, run_attempt: 1, event: 'pull_request', head_sha: 'head' };
  const manualRun = { ...run, id: 43, event: 'pull_request' };
  const comments = pendingStatus ? [{
      id: 900,
      user: { type: 'Bot', login: 'github-actions[bot]' },
      body: `<!-- BODY_REVIEW_RECOVERY_PENDING: ${JSON.stringify({
      version: 1, status: pendingStatus, prNumber: 1, runId: 42, runAttempt: 1,
        headSha: 'head', bodyRevision: reviewInputRevisionFromBody(body),
        ...(pendingStatus === 'manual' ? { runAttempt: 2, reconcileAttempts: 1, sourceEvent: 'rerun-ambiguous' } : {}),
      })} -->`,
  }] : [];
  const github = {
    request: async (route: string, input: { comment_id: number; body?: string; headers?: Record<string, string> }) => {
      const target = comments.find(comment => comment.id === input.comment_id);
      if (!target) throw new Error(`comment ${input.comment_id} not found`);
      const etag = `"marker-${target.id}-${target.body.length}"`;
      if (route.startsWith('GET ')) {
        return { data: target, headers: { etag } };
      }
      if (route.startsWith('PATCH ')) {
        if (input.headers?.['If-Match'] !== etag) {
          const error = new Error('precondition failed') as Error & { status?: number };
          error.status = 412;
          throw error;
        }
        target.body = input.body || '';
        return { data: target, headers: { etag: `"marker-${target.id}-${target.body.length}"` } };
      }
      throw new Error(`unexpected request ${route}`);
    },
    rest: {
      pulls: {
        list: 'pulls',
        get: async () => ({ data: { state: 'open', body, head: { sha: ++reads > 1 && changedHead ? 'new' : 'head', ref: 'fork-branch' }, base: { ref: 'main' } } }),
      },
      issues: {
        listComments: 'comments',
        createComment: async ({ body: commentBody }: { body: string }) => {
          callOrder.push('comment');
          const comment = { id: 901 + comments.length, user: { type: 'Bot', login: 'github-actions[bot]' }, body: commentBody };
          comments.push(comment);
          return { data: comment };
        },
        updateComment: async ({ comment_id, body: commentBody }: { comment_id: number; body: string }) => {
          callOrder.push('comment');
          const target = comments.find(comment => comment.id === comment_id);
          if (target) target.body = commentBody;
          return { data: target };
        },
      },
      actions: {
        listWorkflowRuns: 'runs', listJobsForWorkflowRun: 'jobs',
        getWorkflowRun: async ({ run_id }: { run_id: number }) => ({ data: { ...run, id: run_id, status: finishing ? 'completed' : status, conclusion: finishing ? 'failure' : conclusion, run_attempt: changedAttempt ? 2 : 1, pull_requests: [{ number: 1, base: { ref: 'main' }, head: { sha: 'head' } }] } }),
        reRunWorkflow: async ({ run_id }: { run_id: number }) => {
          if (rerunFails) throw new Error('rerun failed');
          reruns.push(run_id);
        },
        createWorkflowDispatch: async (input: unknown) => {
          if (dispatchFails) throw new Error('dispatch failed');
          dispatches.push(input);
        },
      },
    },
    graphql: async (query: string) => {
      if (query.includes('disablePullRequestAutoMerge')) {
        callOrder.push('mutation');
        nativeAutoMergeRevoked = true;
        return { disablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: null } } };
      }
      callOrder.push('query');
      return {
        repository: {
          pullRequest: {
            id: 'PRID',
            state: 'OPEN',
            autoMergeRequest: nativeAutoMerge && !nativeAutoMergeRevoked
              ? { enabledAt: '2026-09-19T08:00:00Z' }
              : null,
          },
        },
      };
    },
    paginate: async (endpoint: string) => {
      if (endpoint === 'pulls') return [{ number: 1, draft: false, base: { ref: 'main' } }];
      if (endpoint === 'runs') {
        return workflowRuns === 'none'
          ? []
          : workflowRuns === 'mixed'
            ? [run, manualRun]
            : olderFailed
              ? [run, { id: 41, status: 'completed', conclusion: 'failure', run_attempt: 1, event: 'pull_request', head_sha: 'head' }]
              : [run];
      }
      if (endpoint === 'jobs') {
        return [{ conclusion, steps: [{ name: 'PR-body completeness + multi-issue Closes (no checkout, all events)', conclusion: body }] }];
      }
      if (endpoint === 'comments') return comments;
      return [];
    },
  };
  let error = '';
  try {
    await new AsyncFunction('github', 'context', 'core', 'require', script)(github, {
      eventName,
      repo: { owner: 'owner', repo: 'repo' },
      payload: eventName === 'workflow_run'
        ? { workflow_run: { id: eventRunId, name: 'tests', status: 'completed', conclusion, event: 'pull_request', run_attempt: eventRunAttempt, created_at: '2026-09-19T09:00:00Z', head_sha: 'head', repository: { full_name: 'owner/repo' }, pull_requests: [{ number: 1, base: { ref: 'main' }, head: { sha: 'head' } }] } }
        : { pull_request: { number: 1, head: { sha: 'head' } } },
    }, { info: () => undefined, warning: () => undefined }, require);
  } catch (caught) {
    if (!rerunFails && !dispatchFails) throw caught;
    error = String((caught as Error)?.message || caught);
  }
  if (rerunFails || dispatchFails) return { reruns, dispatches, comments, error };
  if (nativeAutoMerge) return { reruns, dispatches, callOrder };
  return { reruns, dispatches };
}

describe('one code verdict and metadata-triggered review recovery', () => {
  it('has exactly one unconditional required execution job and reviews edited PR metadata', () => {
    // L'unico altro job, `post-review`, e' condizionato, dipende da `vitest` e
    // non porta il nome del check required.
    expect(Object.keys(workflow.jobs)).toEqual(['vitest', 'post-review']);
    expect(workflow.jobs['post-review'].needs).toBe('vitest');
    expect(workflow.jobs['post-review'].name).not.toBe(VITEST_CHECK_NAME);
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
    expect(workflow.on.workflow_dispatch).toBeUndefined();
    expect(readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8')).not.toContain('inputs.head_sha');
    expect(workflow.concurrency.group).not.toContain('inputs.head_sha');
    const recoveryWorkflowCheckout = job.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/checkout@')) as { with?: Record<string, string> } | undefined;
    expect(recoveryWorkflowCheckout?.with?.ref).toContain('github.ref');
    expect(recoveryWorkflowCheckout?.with?.ref).not.toContain('inputs.head_sha');
    expect(job.steps.find((step: { name?: string }) => step.name === 'Verify trusted recovery checkout is the requested PR HEAD')).toBeUndefined();
    expect(job.steps[0].with.script).not.toContain('head_sha completo e verificabile');
    const guard = job.steps.find((step: { name?: string }) => step.name?.startsWith('Re-review guard')) as { env?: Record<string, string>; run?: string } | undefined;
    expect(guard?.run).toContain('node "$REVIEW_POLICY_ROOT/scripts/ci/lib/pr-review-admission.mjs" skip');
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

  it('executes review admission and gate helpers from the immutable base, not the PR tree', () => {
    const bootstrap = job.steps.find((step: { id?: string }) => step.id === 'review_policy') as { if?: string; run?: string; env?: Record<string, string> } | undefined;
    expect(bootstrap?.if).toContain("github.event.pull_request.base.ref == 'main'");
    expect(bootstrap?.env?.POLICY_REF).toBe('${{ github.event.pull_request.base.sha }}');
    for (const helper of [
      'scripts/ci/review-gate.mjs',
      'scripts/ci/lib/review-carry-forward.mjs',
      'scripts/ci/pr-contribution-fingerprint.mjs',
      'scripts/ci/prefetch-review-diff.mjs',
      'scripts/ci/review-marker-recovery.mjs',
      'scripts/ci/lib/pr-review-admission.mjs',
      'scripts/ci/lib/review-input-revision.mjs',
    ]) expect(bootstrap?.run).toContain(`download_main ${helper}`);
    expect(bootstrap?.run).toContain('REVIEW_POLICY_ROOT=');
    const checkoutIndex = job.steps.findIndex((step: { uses?: string }) => step.uses?.startsWith('actions/checkout@'));
    const bootstrapIndex = job.steps.findIndex((step: { id?: string }) => step.id === 'review_policy');
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(bootstrapIndex).toBeLessThan(checkoutIndex);
    expect(job.steps.find((step: { id?: string }) => step.id === 'review_gate')?.run)
      .toContain('node "$REVIEW_POLICY_ROOT/scripts/ci/review-gate.mjs"');
    const finalPolicy = job.steps.find((step: { id?: string }) => step.id === 'review_policy_final') as { if?: string; run?: string; id?: string } | undefined;
    expect(finalPolicy?.if).toContain('always()');
    expect(finalPolicy?.run).toContain('review-policy-final-${GITHUB_RUN_ID}');
    expect(finalPolicy?.run).toContain('printf \'final_root=%s');
    expect((job.steps.find((step: { id?: string }) => step.id === 'review_marker') as { env?: Record<string, string> } | undefined)?.env?.REVIEW_POLICY_ROOT)
      .toContain('steps.review_policy_final.outputs.final_root');
    expect((job.steps.find((step: { id?: string }) => step.id === 'review_gate') as { env?: Record<string, string> } | undefined)?.env?.REVIEW_POLICY_ROOT)
      .toContain('steps.review_policy_final.outputs.final_root');
    const publisherRefresh = job.steps.find((step: { id?: string }) => step.id === 'review_policy_publishers') as { run?: string } | undefined;
    expect(publisherRefresh?.run).toContain('review-policy-publish-${GITHUB_RUN_ID}');
    expect((job.steps.find((step: { id?: string }) => step.id === 'trusted_gh') as { run?: string } | undefined)?.run)
      .toContain('command -v gh');
    expect((job.steps.find((step: { id?: string }) => step.id === 'trusted_gh') as { run?: string } | undefined)?.run)
      .toContain('realpath');
    for (const publisherId of ['review_policy_publishers', 'review_policy_abort', 'review_policy_final']) {
      expect((job.steps.find((step: { id?: string }) => step.id === publisherId) as { env?: Record<string, string> } | undefined)?.env?.TRUSTED_GH_BIN)
        .toContain('steps.trusted_gh.outputs.path');
    }
    for (const publisherId of ['test_only_review', 'carry_forward_review']) {
      expect((job.steps.find((step: { id?: string }) => step.id === publisherId) as { env?: Record<string, string> } | undefined)?.env?.REVIEW_POLICY_ROOT)
        .toContain('steps.review_policy_publishers.outputs.root');
    }
    expect((job.steps.find((step: { id?: string }) => step.id === 'review_abort') as { env?: Record<string, string> } | undefined)?.env?.REVIEW_POLICY_ROOT)
      .toContain('steps.review_policy_abort.outputs.root');
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
    expect(recovery.on).toEqual({
      pull_request_target: { types: ['edited'] },
      workflow_run: { workflows: ['tests'], types: ['completed'] },
      schedule: [{ cron: '*/15 * * * *' }],
    });
    expect(recovery.permissions['pull-requests']).toBe('write');
    expect(recovery.jobs.recover.if).toContain("github.event_name == 'workflow_run'");
    expect(recovery.jobs.recover.if).toContain('github.event.changes.body != null');
    expect(recovery.jobs.recover.steps).toHaveLength(1);
    expect(script).not.toContain('createCheckRun');
    expect(script).not.toContain('exec(');
    expect(script).toContain('BODY_REVIEW_RECOVERY_PENDING');
    expect(script).toContain('workflow_run');
    expect(recovery.concurrency.group).toContain('tests-body-recovery-schedule');
    expect(recovery.concurrency.group).toContain('tests-body-recovery-pr-');
    expect(recovery.concurrency.group).toContain('workflow_run.id');
    expect(recovery.concurrency.group).not.toContain('workflow_run.head_branch');
    expect(recovery.concurrency['cancel-in-progress']).toBe(false);
    expect(script).toContain('markerMatchesRun');
    expect(script).not.toContain('createWorkflowDispatch');
    expect(script).toContain('status: \'manual\'');
    expect(script).toContain("status: 'completed'");
    expect(script).toContain('queuedAt');
    expect(script).toContain('handleScheduledRecovery');
    expect(script).toContain('rerun-ambiguous-exhausted');
    expect(script).toContain('releaseNativeAutoMergeLease');
    expect(script).toContain('NATIVE_AUTO_MERGE_LEASE');
    expect(script).toContain('disablePullRequestAutoMerge');
    expect(script).toContain('MarkerWriteConflict');
    expect(script).toContain("headers: { 'If-Match': current.etag }");
    expect(script).toContain('readCommentWithEtag');
    expect(script).toContain('await revokeNativeAutoMerge(number)');
    expect(script).not.toContain('setTimeout');
  });

  it('retries a failed body preflight after an edit', async () => {
    expect(await runRecovery()).toEqual({ reruns: [42], dispatches: [] });
  });

  it('revokes native auto-merge before writing the recovery marker', async () => {
    expect(await runRecovery({ nativeAutoMerge: true, workflowRuns: 'none' })).toEqual({
      reruns: [],
      dispatches: [],
      callOrder: ['query', 'mutation', 'query', 'comment'],
    });
    expect(script.indexOf('await revokeNativeAutoMerge(number)'))
      .toBeLessThan(script.indexOf('await releaseNativeAutoMergeLease(number, pr)'));
  });

  it('leaves a manual checkpoint when no pull_request run exists', async () => {
    expect(await runRecovery({ workflowRuns: 'none' })).toEqual({
      reruns: [],
      dispatches: [],
    });
  });

  it('preserves passing body verdicts, running tests and failures later in the pipeline', async () => {
    expect(await runRecovery({ body: 'success' })).toEqual({ reruns: [42], dispatches: [] });
    expect(await runRecovery({ body: 'success', status: 'in_progress', conclusion: '' })).toEqual({ reruns: [], dispatches: [] });
    expect(await runRecovery({ body: 'success', conclusion: 'success' })).toEqual({ reruns: [42], dispatches: [] });
    expect(await runRecovery({ body: 'skipped' })).toEqual({ reruns: [42], dispatches: [] });
  });

  it('preserves a newer queued attempt instead of rerunning an older failed body', async () => {
    expect(await runRecovery({ status: 'queued', body: '', conclusion: '', olderFailed: true })).toEqual({ reruns: [], dispatches: [] });
  });

  it('recovers an edit arriving while the failed preflight is finishing', async () => {
    expect(await runRecovery({ status: 'in_progress', conclusion: '', finishing: true })).toEqual({ reruns: [42], dispatches: [] });
  });

  it('retries an active run after its completion event, beyond any runner polling window', async () => {
    expect(await runRecovery({ eventName: 'workflow_run', pendingStatus: 'pending' })).toEqual({
      reruns: [42],
      dispatches: [],
    });
  });

  it('uses the completion event itself when the run listing is temporarily empty', async () => {
    expect(await runRecovery({ eventName: 'workflow_run', pendingStatus: 'pending', workflowRuns: 'none' })).toEqual({
      reruns: [42],
      dispatches: [],
    });
  });

  it('adopts a newer rerun attempt before consuming the durable marker', async () => {
    expect(await runRecovery({
      eventName: 'workflow_run',
      pendingStatus: 'pending',
      eventRunAttempt: 2,
      changedAttempt: true,
      workflowRuns: 'none',
    })).toEqual({
      reruns: [42],
      dispatches: [],
    });
  });

  it('reconciles a completed queued attempt when its workflow_run event was lost', async () => {
    const result = await runRecovery({
      eventName: 'workflow_run', pendingStatus: 'queued', status: 'completed',
    });
    expect(result.reruns).toEqual([]);
  });

  it('does not close a pending marker for another run or attempt', async () => {
    expect(await runRecovery({ eventName: 'workflow_run', pendingStatus: 'pending', eventRunId: 43 })).toEqual({
      reruns: [],
      dispatches: [],
    });
  });

  it('publishes a manual checkpoint when the rerun mutation is ambiguous', async () => {
    const result = await runRecovery({ rerunFails: true });
    expect(result.error).toMatch(/rerun failed/u);
    expect(result.reruns).toEqual([]);
    expect(result.comments).toHaveLength(1);
    expect(result.comments.at(-1)?.body).toContain('"status":"manual"');
    expect(result.comments.at(-1)?.body).toContain('rerun-ambiguous');
  });

  it('reconciles an ambiguous manual marker from the scheduled event without a body edit', async () => {
    const result = await runRecovery({ eventName: 'schedule', pendingStatus: 'manual' });
    expect(result.reruns).toEqual([42]);
    expect(result.dispatches).toEqual([]);
  });

  it('consumes the exact completion event for an accepted ambiguous rerun', async () => {
    const result = await runRecovery({
      eventName: 'workflow_run', pendingStatus: 'manual', eventRunAttempt: 2, changedAttempt: true,
    });
    expect(result.reruns).toEqual([]);
    expect(result.dispatches).toEqual([]);
  });

  it('does not restart an old head, while adopting an observed newer attempt', async () => {
    expect(await runRecovery({ changedHead: true })).toEqual({ reruns: [], dispatches: [] });
    expect(await runRecovery({ changedAttempt: true })).toEqual({ reruns: [42], dispatches: [] });
  });

  it('does not dispatch when the head already has pull_request and manual runs', async () => {
    expect(await runRecovery({ workflowRuns: 'mixed' })).toEqual({ reruns: [43], dispatches: [] });
  });
});
