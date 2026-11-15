import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import {
  classifyPublishAttempt,
  decideLatestPublish,
  DEFAULT_MAX_PUBLISH_ATTEMPTS,
  deploymentSourceSha,
  publishBackoffMs,
  publishToolchainPathHit,
  readToolchainChange,
} from '../scripts/ci/request-latest-publish.mjs';
import {
  BUILD_BLOCKED_ISSUE_PREFIX,
  blockedIssueTitle,
  issueUpdatesEnabled,
  PUBLISH_BLOCKED_ISSUE_PREFIX,
  resolveBlockedIssues,
  upsertBlockedIssue,
} from '../scripts/ci/lib/deploy-blocked-issue.mjs';
import { classifyDeployFailure } from '../scripts/ci/deploy-failure-classifier.mjs';

const SHA_OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_LATEST = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SHA_OLDER_TAIL = 'cccccccccccccccccccccccccccccccccccccccc';

const build = (id: number, headSha: string, completedAt: string, conclusion = 'success') => ({
  id,
  workflowId: 300318685,
  headSha,
  headBranch: 'main',
  status: 'completed',
  conclusion,
  event: 'workflow_dispatch',
  completedAt,
});
const deployment = (sha: string, publishedAt: string) => ({ sha, publishedAt });

describe('decideLatestPublish', () => {
  it('dispatches the newest successful main build when the handoff is idle', () => {
    const verdict = decideLatestPublish({
      builds: [build(2, SHA_LATEST, '2026-10-20T12:00:00Z'), build(1, SHA_OLD, '2026-10-20T10:00:00Z')],
      publishRuns: [],
      lastSuccessfulDeployment: deployment(SHA_OLD, '2026-10-20T09:00:00Z'),
    });
    expect(verdict).toMatchObject({ action: 'dispatch', reason: 'publish-latest-build' });
    expect(verdict.candidate).toMatchObject({ id: 2, headSha: SHA_LATEST });
  });

  it('does not mistake the scheduled queue reconciler for a build artifact', () => {
    const scheduledReconciler = {
      ...build(3, SHA_LATEST, '2026-10-20T13:00:00Z'),
      event: 'schedule',
    };
    const verdict = decideLatestPublish({
      builds: [scheduledReconciler, build(2, SHA_OLD, '2026-10-20T12:00:00Z')],
      publishRuns: [],
      lastSuccessfulDeployment: deployment(SHA_OLDER_TAIL, '2026-10-20T09:00:00Z'),
    });
    expect(verdict).toMatchObject({ action: 'dispatch', reason: 'publish-latest-build' });
    expect(verdict.candidate).toMatchObject({ id: 2, headSha: SHA_OLD, event: 'workflow_dispatch' });
  });

  it('does not dispatch when the only successful deploy run is a schedule reconciliation', () => {
    expect(decideLatestPublish({
      builds: [{ ...build(3, SHA_LATEST, '2026-10-20T13:00:00Z'), event: 'schedule' }],
      publishRuns: [],
      lastSuccessfulDeployment: deployment(SHA_OLD, '2026-10-20T09:00:00Z'),
    })).toMatchObject({ action: 'skip', reason: 'no-successful-build' });
  });

  it('hands a successful push build to the publisher', () => {
    const verdict = decideLatestPublish({
      builds: [{ ...build(3, SHA_LATEST, '2026-10-20T13:00:00Z'), event: 'push' }],
      publishRuns: [],
      lastSuccessfulDeployment: null,
    });

    expect(verdict).toMatchObject({ action: 'dispatch', reason: 'publish-latest-build' });
    expect(verdict.candidate).toMatchObject({ id: 3, event: 'push' });
  });

  it.each(['queued', 'in_progress', 'waiting', 'pending', 'requested'])(
    'does not dispatch while another publish workflow is %s',
    (status) => {
      expect(decideLatestPublish({
        builds: [build(2, SHA_LATEST, '2026-10-20T12:00:00Z')],
        publishRuns: [{ id: 99, status, conclusion: null }],
        lastSuccessfulDeployment: deployment(SHA_OLD, '2026-10-20T09:00:00Z'),
      })).toMatchObject({ action: 'skip', reason: 'publish-moving' });
    },
  );

  it('does not dispatch while Pages is still syncing the previous upload', () => {
    expect(decideLatestPublish({
      builds: [build(2, SHA_LATEST, '2026-10-20T12:00:00Z')],
      publishRuns: [],
      lastSuccessfulDeployment: deployment(SHA_OLD, '2026-10-20T09:00:00Z'),
      activeDeployment: { id: 123, state: 'in_progress' },
    })).toMatchObject({ action: 'skip', reason: 'pages-moving' });
  });

  it('does not let a completed Pages upload tail block the next publish', () => {
    expect(decideLatestPublish({
      builds: [build(2, SHA_LATEST, '2026-10-20T12:00:00Z')],
      publishRuns: [{
        id: 99,
        status: 'in_progress',
        conclusion: null,
        event: 'workflow_dispatch',
        headSha: SHA_OLD,
        displayTitle: `Publish Pages build 1 @ ${SHA_OLD}`,
      }],
      lastSuccessfulDeployment: deployment(SHA_OLD, '2026-10-20T12:05:00Z'),
    })).toMatchObject({ action: 'dispatch', reason: 'publish-latest-build' });
  });

  it('also ignores an older publish tail when a newer revision is already live', () => {
    expect(decideLatestPublish({
      builds: [build(2, SHA_LATEST, '2026-10-20T12:00:00Z')],
      publishRuns: [{
        id: 98,
        status: 'in_progress',
        conclusion: null,
        event: 'workflow_dispatch',
        headSha: SHA_OLDER_TAIL,
      }],
      lastSuccessfulDeployment: deployment(SHA_OLD, '2026-10-20T12:05:00Z'),
      successfulDeploymentShas: [SHA_OLD, SHA_OLDER_TAIL],
    })).toMatchObject({ action: 'dispatch', reason: 'publish-latest-build' });
  });

  it('still waits for a publish run whose Pages upload has not succeeded', () => {
    expect(decideLatestPublish({
      builds: [build(2, SHA_LATEST, '2026-10-20T12:00:00Z')],
      publishRuns: [{
        id: 97,
        status: 'in_progress',
        conclusion: null,
        event: 'workflow_dispatch',
        headSha: SHA_LATEST,
      }],
      lastSuccessfulDeployment: deployment(SHA_OLD, '2026-10-20T12:05:00Z'),
    })).toMatchObject({ action: 'skip', reason: 'publish-moving' });
  });

  it('treats an exact successful deployment as already live', () => {
    expect(decideLatestPublish({
      builds: [build(2, SHA_LATEST, '2026-10-20T12:00:00Z')],
      publishRuns: [],
      lastSuccessfulDeployment: deployment(SHA_LATEST, '2026-10-20T12:05:00Z'),
    })).toMatchObject({ action: 'skip', reason: 'already-live' });
  });

  it('uses the successful deployment identity as the live receipt', () => {
    expect(decideLatestPublish({
      builds: [build(2, SHA_LATEST, '2026-10-20T12:00:00Z')],
      publishRuns: [{
        id: 99,
        status: 'completed',
        conclusion: 'failure',
        displayTitle: `Publish Pages build 2 @ ${SHA_LATEST}`,
      }],
      durableReceipts: { pagesDeployed: true },
      lastSuccessfulDeployment: deployment(SHA_LATEST, '2026-10-20T12:05:00Z'),
    })).toMatchObject({ action: 'skip', reason: 'already-live' });
  });

  it('does not let a historical receipt hide a rollback of the live deployment', () => {
    expect(decideLatestPublish({
      builds: [build(2, SHA_LATEST, '2026-10-20T12:00:00Z')],
      publishRuns: [],
      durableReceipts: { pagesDeployed: true },
      lastSuccessfulDeployment: deployment(SHA_OLD, '2026-10-20T12:05:00Z'),
    })).toMatchObject({ action: 'dispatch', reason: 'publish-latest-build' });
  });

  it('does not trust a receipt when the current Pages deployment is unknown', () => {
    expect(decideLatestPublish({
      builds: [build(2, SHA_LATEST, '2026-10-20T12:00:00Z')],
      publishRuns: [],
      durableReceipts: { pagesDeployed: true },
      lastSuccessfulDeployment: null,
    })).toMatchObject({ action: 'dispatch', reason: 'publish-latest-build' });
  });

  it('counts a live attempt against the cap before admitting another retry', () => {
    const liveRuns = Array.from({ length: DEFAULT_MAX_PUBLISH_ATTEMPTS }, (_, index) => ({
      id: index + 10,
      status: index === 0 ? 'in_progress' : 'completed',
      conclusion: index === 0 ? null : 'failure',
      displayTitle: `Publish Pages build 2 @ ${SHA_LATEST}`,
    }));
    expect(decideLatestPublish({
      builds: [build(2, SHA_LATEST, '2026-10-20T12:00:00Z')],
      publishRuns: liveRuns,
      lastSuccessfulDeployment: deployment(SHA_OLD, '2026-10-20T09:00:00Z'),
    })).toMatchObject({ action: 'skip', reason: 'attempt-cap' });
  });

  it('uses the successful deployment source SHA when its dispatch ref differs', () => {
    expect(decideLatestPublish({
      builds: [build(2, SHA_LATEST, '2026-10-20T12:00:00Z')],
      publishRuns: [{
        id: 99,
        status: 'in_progress',
        conclusion: null,
        event: 'workflow_dispatch',
        headSha: SHA_OLDER_TAIL,
      }],
      lastSuccessfulDeployment: {
        head_sha: SHA_OLDER_TAIL,
        source_sha: SHA_LATEST,
      },
      successfulDeploymentShas: [SHA_OLDER_TAIL],
    })).toMatchObject({ action: 'skip', reason: 'already-live' });
  });

  it('recovers the source SHA from the canonical publish run name', () => {
    expect(decideLatestPublish({
      builds: [build(2, SHA_LATEST, '2026-10-20T12:00:00Z')],
      publishRuns: [{
        id: 99,
        status: 'in_progress',
        conclusion: null,
        event: 'workflow_dispatch',
        headSha: SHA_OLDER_TAIL,
        runName: `Publish Pages build 2 @ ${SHA_LATEST}`,
      }],
      lastSuccessfulDeployment: deployment(SHA_OLDER_TAIL, '2026-10-20T12:05:00Z'),
      successfulDeploymentShas: [SHA_OLDER_TAIL],
    })).toMatchObject({ action: 'skip', reason: 'already-live' });
  });

  it('uses an Actions target URL to identify the successful publish source', () => {
    const publishRun = {
      id: 123,
      run_name: `Publish Pages build 42 @ ${SHA_LATEST}`,
    };
    const sourceSha = deploymentSourceSha(
      { sha: SHA_OLDER_TAIL },
      { target_url: 'https://github.com/o/r/actions/runs/123' },
      [publishRun],
    );

    expect(sourceSha).toBe(SHA_LATEST);
    expect(decideLatestPublish({
      builds: [build(42, SHA_LATEST, '2026-10-20T12:00:00Z')],
      publishRuns: [publishRun],
      lastSuccessfulDeployment: { sha: SHA_OLDER_TAIL, sourceSha },
    })).toMatchObject({ action: 'skip', reason: 'already-live' });
  });

  it('recovers the source SHA from the REST workflow-run display title', () => {
    const publishRun = {
      id: 124,
      head_sha: SHA_OLDER_TAIL,
      display_title: `Publish Pages build 42 @ ${SHA_LATEST}`,
    };
    const sourceSha = deploymentSourceSha(
      { sha: SHA_OLDER_TAIL },
      { target_url: 'https://github.com/o/r/actions/runs/124/job/456' },
      [publishRun],
    );

    expect(sourceSha).toBe(SHA_LATEST);
    expect(decideLatestPublish({
      builds: [build(42, SHA_LATEST, '2026-10-20T12:00:00Z')],
      publishRuns: [publishRun],
      lastSuccessfulDeployment: { sha: SHA_OLDER_TAIL, sourceSha },
    })).toMatchObject({ action: 'skip', reason: 'already-live' });
  });

  it('does not suppress a retry when recognized publisher titles disagree on source SHA', () => {
    const publishRun = {
      id: 125,
      head_sha: SHA_OLDER_TAIL,
      display_title: `Publish Pages build 42 @ ${SHA_LATEST}`,
      run_name: `Publish Pages build 41 @ ${SHA_OLD}`,
    };
    const sourceSha = deploymentSourceSha(
      { sha: SHA_OLDER_TAIL },
      { target_url: 'https://github.com/o/r/actions/runs/125/job/456' },
      [publishRun],
    );

    expect(sourceSha).toBe('');
    expect(decideLatestPublish({
      builds: [build(42, SHA_LATEST, '2026-10-20T12:00:00Z')],
      publishRuns: [publishRun],
      lastSuccessfulDeployment: { sha: SHA_OLDER_TAIL, sourceSha },
    })).toMatchObject({ action: 'dispatch', reason: 'retry-publish' });
  });

  it('dispatches when the live deployment has a different revision, even if it finished later', () => {
    expect(decideLatestPublish({
      builds: [build(2, SHA_OLD, '2026-10-20T12:00:00Z')],
      publishRuns: [],
      lastSuccessfulDeployment: deployment('cccccccccccccccccccccccccccccccccccccccc', '2026-10-20T12:01:00Z'),
    })).toMatchObject({ action: 'dispatch', reason: 'publish-latest-build' });
  });

  it('retries a failed candidate only within the bounded publish-attempt cap', () => {
    const failed = Array.from({ length: DEFAULT_MAX_PUBLISH_ATTEMPTS - 1 }, (_, index) => ({
      id: index + 10,
      status: 'completed',
      conclusion: 'failure',
      displayTitle: `Publish Pages build 2 @ ${SHA_LATEST}`,
    }));
    expect(decideLatestPublish({
      builds: [build(2, SHA_LATEST, '2026-10-20T12:00:00Z')],
      publishRuns: failed,
      lastSuccessfulDeployment: deployment(SHA_OLD, '2026-10-20T09:00:00Z'),
    })).toMatchObject({ action: 'dispatch', reason: 'retry-publish' });
    expect(decideLatestPublish({
      builds: [build(2, SHA_LATEST, '2026-10-20T12:00:00Z')],
      publishRuns: [...failed, {
        id: 20,
        status: 'completed',
        conclusion: 'failure',
        displayTitle: `Publish Pages build 2 @ ${SHA_LATEST}`,
      }],
      lastSuccessfulDeployment: deployment(SHA_OLD, '2026-10-20T09:00:00Z'),
    })).toMatchObject({ action: 'skip', reason: 'attempt-cap' });
  });

  it('counts a failed publish from run_name when GitHub returns a generic display title', () => {
    const failed = Array.from({ length: DEFAULT_MAX_PUBLISH_ATTEMPTS }, (_, index) => ({
      id: index + 30,
      status: 'completed',
      conclusion: 'failure',
      display_title: 'Publish to GitHub Pages',
      run_name: `Publish Pages build 2 @ ${SHA_LATEST}`,
    }));
    expect(decideLatestPublish({
      builds: [build(2, SHA_LATEST, '2026-10-20T12:00:00Z')],
      publishRuns: failed,
      lastSuccessfulDeployment: deployment(SHA_OLD, '2026-10-20T09:00:00Z'),
    })).toMatchObject({ action: 'skip', reason: 'attempt-cap' });
  });
});

const SHA_TOOLCHAIN = 'dddddddddddddddddddddddddddddddddddddddd';
const SHA_TIP = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const MIN = 60_000;
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString();

const publishRun = (id: number, status = 'completed', conclusion: string | null = 'failure', completedAt = ago(60)) => ({
  id,
  status,
  conclusion,
  headSha: SHA_TOOLCHAIN,
  displayTitle: `Publish Pages build 2 @ ${SHA_LATEST}`,
  completedAt,
});

const attempt = (over: Record<string, unknown> = {}) => ({
  id: 10,
  conclusion: 'failure',
  completedAt: ago(30),
  toolchainSha: SHA_TOOLCHAIN,
  rebuildRequired: false,
  classification: 'deterministic',
  signature: 'publish-nonit-shards::Push locale shard::ERR_STRING_TOO_LONG',
  job: 'publish-nonit-shards',
  step: 'Push locale shard',
  firstError: 'ERR_STRING_TOO_LONG',
  ...over,
});

const decide = (
  runs: Array<ReturnType<typeof publishRun>>,
  policy: Record<string, unknown>,
) => decideLatestPublish({
  builds: [build(2, SHA_LATEST, ago(300))],
  publishRuns: runs,
  lastSuccessfulDeployment: deployment(SHA_OLD, ago(500)),
  mainHeadSha: SHA_TIP,
  nowMs: NOW,
  ...policy,
});

describe('publish retry policy (classified, backed off, escalating)', () => {
  const changed = { state: 'changed', path: 'scripts/ci/x.mjs' };
  const unchanged = { state: 'unchanged' };

  it('replays 43379239998: one deterministic failure at an unchanged toolchain is not retried, then escalates to a rebuild', () => {
    const one = [attempt({ completedAt: ago(5) })];
    expect(decide([publishRun(10)], { lastAttempt: one[0], failedAttempts: one, toolchainChange: unchanged }))
      .toMatchObject({ action: 'skip', reason: 'publish-deterministic-unchanged' });

    const later = [attempt({ completedAt: ago(20) })];
    const verdict = decide([publishRun(10)], { lastAttempt: later[0], failedAttempts: later, toolchainChange: unchanged });
    expect(verdict).toMatchObject({ action: 'escalate', reason: 'escalate-rebuild', requestRebuild: true, mainHeadSha: SHA_TIP });
    expect(verdict.detail).toContain('ERR_STRING_TOO_LONG');
  });

  it('never dispatches a third identical publish: the cap escalates instead of stalling', () => {
    const runs = [publishRun(10), publishRun(11), publishRun(12)];
    const failed = [attempt({ id: 12 }), attempt({ id: 11 }), attempt({ id: 10 })];
    const verdict = decide(runs, { lastAttempt: failed[0], failedAttempts: failed, toolchainChange: unchanged });
    expect(verdict).toMatchObject({ action: 'escalate', reason: 'escalate-rebuild' });
    expect(verdict.detail).toContain('attempt cap reached (3/3)');
  });

  it('escalates after two equal deterministic signatures even below the cap', () => {
    const failed = [attempt({ id: 11 }), attempt({ id: 10 })];
    expect(decide([publishRun(10), publishRun(11)], { lastAttempt: failed[0], failedAttempts: failed, toolchainChange: changed }))
      .toMatchObject({ action: 'escalate', reason: 'escalate-rebuild' });
  });

  it('retries an infrastructure failure immediately, once per signature', () => {
    const infra = attempt({ classification: 'infra', signature: 'publish::deploy::Unexpected token', completedAt: ago(1) });
    expect(decide([publishRun(10)], { lastAttempt: infra, failedAttempts: [infra], toolchainChange: unchanged }))
      .toMatchObject({ action: 'dispatch', reason: 'retry-publish' });
    // The same infra signature already retried once is gated like any other failure.
    const again = [attempt({ ...infra, id: 11 }), attempt({ ...infra, id: 10 })];
    expect(decide([publishRun(10), publishRun(11)], { lastAttempt: again[0], failedAttempts: again, toolchainChange: unchanged }))
      .toMatchObject({ action: 'skip', reason: 'publish-deterministic-unchanged' });
  });

  it('retries a deterministic failure once the toolchain changed and the backoff elapsed', () => {
    const last = attempt({ completedAt: ago(16) });
    expect(decide([publishRun(10)], { lastAttempt: last, failedAttempts: [last], toolchainChange: changed }))
      .toMatchObject({ action: 'dispatch', reason: 'retry-publish' });
  });

  it('holds a changed toolchain inside the backoff and names the next window', () => {
    const completedAt = ago(5);
    const last = attempt({ completedAt });
    const verdict = decide([publishRun(10)], { lastAttempt: last, failedAttempts: [last], toolchainChange: changed });
    expect(verdict).toMatchObject({ action: 'skip', reason: 'publish-backoff' });
    expect(verdict.detail).toContain(new Date(Date.parse(completedAt) + 15 * MIN).toISOString());
    expect(verdict.detail).toContain('ERR_STRING_TOO_LONG');
  });

  it('widens the backoff 15 -> 30 -> 60 minutes by failed attempts', () => {
    expect([1, 2, 3, 4].map((n) => publishBackoffMs(n) / MIN)).toEqual([15, 30, 60, 60]);
    const failed = [attempt({ id: 11, signature: 'b', completedAt: ago(20) }), attempt({ id: 10, signature: 'a' })];
    expect(decide([publishRun(10), publishRun(11)], { lastAttempt: failed[0], failedAttempts: failed, toolchainChange: changed }))
      .toMatchObject({ action: 'skip', reason: 'publish-backoff' });
  });

  it.each([
    ['unreadable', { state: 'unreadable', detail: 'compare unreadable: HTTP 404' }],
    ['truncated', { state: 'unreadable', detail: 'compare file list may be truncated at 300 files' }],
    ['absent', null],
  ])('does not retry before the backoff when the toolchain compare is %s, and names the next window', (_name, toolchainChange) => {
    const completedAt = ago(5);
    const last = attempt({ completedAt });
    const verdict = decide([publishRun(10)], { lastAttempt: last, failedAttempts: [last], toolchainChange });
    expect(verdict).toMatchObject({ action: 'skip', reason: 'publish-toolchain-unreadable' });
    expect(verdict.detail).toContain(new Date(Date.parse(completedAt) + 15 * MIN).toISOString());
  });

  it('escalates to a rebuild once the backoff elapsed on an unreadable or truncated compare (no silent stall)', () => {
    const last = attempt({ completedAt: ago(90) });
    const toolchainChange = { state: 'unreadable', detail: 'compare file list may be truncated at 300 files' };
    const verdict = decide([publishRun(10)], { lastAttempt: last, failedAttempts: [last], toolchainChange });
    expect(verdict).toMatchObject({ action: 'escalate', reason: 'escalate-rebuild', requestRebuild: true });
    expect(verdict.detail).toContain('truncated');
    expect(decide([publishRun(10)], { lastAttempt: last, failedAttempts: [last], toolchainChange: null }))
      .toMatchObject({ action: 'escalate', reason: 'escalate-rebuild' });
  });

  it('only updates the issue on an unreadable compare after the backoff when main is the candidate', () => {
    const last = attempt({ completedAt: ago(90) });
    expect(decide([publishRun(10)], {
      lastAttempt: last,
      failedAttempts: [last],
      toolchainChange: { state: 'unreadable', detail: 'compare unreadable: HTTP 404' },
      mainHeadSha: SHA_LATEST,
    })).toMatchObject({ action: 'escalate', reason: 'escalate-blocked', requestRebuild: false });
  });

  it('escalates at once when the publisher declared the source unpublishable (contract-mismatch family)', () => {
    const last = attempt({ rebuildRequired: true, classification: 'deterministic', signature: 'publish::rebuild-required', completedAt: ago(1) });
    expect(decide([publishRun(10, 'completed', 'success')], { lastAttempt: last, failedAttempts: [last], toolchainChange: changed }))
      .toMatchObject({ action: 'escalate', reason: 'escalate-rebuild' });
  });

  it('only updates the issue when main is the build already tried (a rebuild is the same artifact)', () => {
    const last = attempt({ completedAt: ago(20) });
    const verdict = decide([publishRun(10)], { lastAttempt: last, failedAttempts: [last], toolchainChange: unchanged, mainHeadSha: SHA_LATEST });
    expect(verdict).toMatchObject({ action: 'escalate', reason: 'escalate-blocked', requestRebuild: false });
    expect(verdict.detail).toContain('no rearm request');
  });

  it('keeps the plain cap when there is no policy context, or a live attempt may still win', () => {
    const runs = [publishRun(10), publishRun(11), publishRun(12)];
    expect(decide(runs, {})).toMatchObject({ action: 'skip', reason: 'attempt-cap' });
    const live = [publishRun(10), publishRun(11), publishRun(12, 'in_progress', null)];
    const last = attempt();
    expect(decide(live, { lastAttempt: last, failedAttempts: [last], toolchainChange: unchanged }))
      .toMatchObject({ action: 'skip', reason: 'attempt-cap' });
  });

  it('keeps already-live, publish-moving and pages-moving ahead of the retry policy', () => {
    const last = attempt({ completedAt: ago(90) });
    const policy = { lastAttempt: last, failedAttempts: [last], toolchainChange: unchanged };
    expect(decide([publishRun(10), { ...publishRun(11, 'in_progress', null), headSha: SHA_LATEST }], policy))
      .toMatchObject({ action: 'skip', reason: 'publish-moving' });
    expect(decide([publishRun(10)], { ...policy, activeDeployment: { id: 1, state: 'in_progress' } }))
      .toMatchObject({ action: 'skip', reason: 'pages-moving' });
    expect(decideLatestPublish({
      builds: [build(2, SHA_LATEST, ago(300))],
      publishRuns: [publishRun(10)],
      lastSuccessfulDeployment: deployment(SHA_LATEST, ago(10)),
      ...policy,
      mainHeadSha: SHA_TIP,
    })).toMatchObject({ action: 'skip', reason: 'already-live' });
  });
});

describe('classifyPublishAttempt', () => {
  const failedJob = (name: string, id = 1) => ({
    id,
    name,
    status: 'completed',
    conclusion: 'failure',
    steps: [{ name: 'Push locale shard', conclusion: 'failure' }],
  });
  const run = { id: 77, headSha: SHA_TOOLCHAIN, conclusion: 'failure', completedAt: ago(10) };

  it('records the classifier signature and the toolchain SHA of the attempt', () => {
    const jobs = [failedJob('publish-nonit-shards')];
    const annotationsByJob = { 1: [{ annotation_level: 'failure', message: 'RangeError [ERR_STRING_TOO_LONG]: Cannot create a string longer than 0x1fffffe8 characters' }] };
    const result = classifyPublishAttempt({ run, jobs, annotationsByJob });
    expect(result).toMatchObject({ id: 77, toolchainSha: SHA_TOOLCHAIN, classification: 'deterministic', rebuildRequired: false });
    expect(result?.signature).toBe(classifyDeployFailure({ jobs, annotationsByJob }).signature);
  });

  it('keeps a warning that quotes ECONNRESET from turning an assertion failure into infra', () => {
    const jobs = [failedJob('publish-nonit-shards')];
    const annotationsByJob = {
      1: [
        { annotation_level: 'warning', message: 'read ECONNRESET while fetching the cache' },
        { annotation_level: 'failure', message: 'AssertionError: expected 1 to be 2' },
      ],
    };
    expect(classifyPublishAttempt({ run, jobs, annotationsByJob })?.classification).toBe('deterministic');
  });

  it('degrades to unknown when the jobs could not be read', () => {
    expect(classifyPublishAttempt({ run })).toMatchObject({ classification: 'unknown', rebuildRequired: false });
  });

  it('recognises the publisher recovery job as rebuild-required, even on a green run', () => {
    const jobs = [{ id: 5, name: 'Recover legacy publish contract through deploy queue', status: 'completed', conclusion: 'success' }];
    expect(classifyPublishAttempt({ run: { ...run, conclusion: 'success' }, jobs })).toMatchObject({ rebuildRequired: true });
    expect(classifyPublishAttempt({ run: { ...run, conclusion: 'success' }, jobs: [] })).toBeNull();
  });

  it('treats a cancelled run with no failed job as infrastructure', () => {
    expect(classifyPublishAttempt({ run: { ...run, conclusion: 'cancelled' }, jobs: [] })).toMatchObject({ classification: 'infra' });
  });
});

describe('readToolchainChange', () => {
  const page = (names: string[]) => Promise.resolve({ files: names.map((filename) => ({ filename })) });
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `data/jobs/${i}.json`);

  it('lists the publisher toolchain paths', () => {
    for (const file of [
      '.github/workflows/deploy-publish.yml', '.github/workflows/post-deploy-validate-dist.yml',
      'scripts/ci/request-latest-publish.mjs', 'scripts/lib/push-locale-shard.sh',
    ]) expect(publishToolchainPathHit([file])).toBe(file);
    expect(publishToolchainPathHit(['data/jobs.json', 'components/App.tsx', '.github/workflows/tests.yml'])).toBeNull();
  });

  it('reports a change, no change, and an identical SHA', async () => {
    expect(await readToolchainChange({ baseSha: SHA_OLD, headSha: SHA_TIP, fetchPage: () => page(['scripts/ci/a.mjs']) }))
      .toMatchObject({ state: 'changed', path: 'scripts/ci/a.mjs' });
    expect(await readToolchainChange({ baseSha: SHA_OLD, headSha: SHA_TIP, fetchPage: () => page(['data/a.json']) }))
      .toMatchObject({ state: 'unchanged' });
    expect(await readToolchainChange({ baseSha: SHA_TIP, headSha: SHA_TIP, fetchPage: () => { throw new Error('no call'); } }))
      .toMatchObject({ state: 'unchanged' });
  });

  it('is unreadable on an API error or a malformed list, never a retry', async () => {
    expect(await readToolchainChange({ baseSha: SHA_OLD, headSha: SHA_TIP, fetchPage: () => Promise.reject(new Error('HTTP 404')) }))
      .toMatchObject({ state: 'unreadable' });
    expect(await readToolchainChange({ baseSha: SHA_OLD, headSha: SHA_TIP, fetchPage: () => Promise.resolve({}) }))
      .toMatchObject({ state: 'unreadable' });
    expect(await readToolchainChange({ baseSha: 'x', headSha: SHA_TIP, fetchPage: () => page([]) }))
      .toMatchObject({ state: 'unreadable' });
  });

  it('treats a 300-file list with no hit as truncated, but still reports a hit on a later page', async () => {
    const truncated = await readToolchainChange({ baseSha: SHA_OLD, headSha: SHA_TIP, fetchPage: () => page(filler(100)) });
    expect(truncated).toMatchObject({ state: 'unreadable' });
    expect(truncated.detail).toContain('truncated');
    const late = await readToolchainChange({
      baseSha: SHA_OLD,
      headSha: SHA_TIP,
      fetchPage: (n: number) => page(n === 3 ? [...filler(99), 'scripts/lib/x.mjs'] : filler(100)),
    });
    expect(late).toMatchObject({ state: 'changed', path: 'scripts/lib/x.mjs' });
  });
});

describe('shared blocked-issue module', () => {
  it('keeps the build title and prefix and gives the publish its own', () => {
    expect(BUILD_BLOCKED_ISSUE_PREFIX).toBe('Deploy build blocked:');
    expect(PUBLISH_BLOCKED_ISSUE_PREFIX).toBe('Deploy publish blocked:');
    expect(blockedIssueTitle(BUILD_BLOCKED_ISSUE_PREFIX, { job: 'prep', step: 'Build' })).toBe('Deploy build blocked: prep / Build');
    expect(blockedIssueTitle(PUBLISH_BLOCKED_ISSUE_PREFIX, { job: 'publish', step: 'rebuild-required' })).toBe('Deploy publish blocked: publish / rebuild-required');
  });

  it('writes nothing unless the caller flag is exactly 1', () => {
    expect(issueUpdatesEnabled('X', {})).toBe(false);
    expect(issueUpdatesEnabled('X', { X: 'true' })).toBe(false);
    expect(issueUpdatesEnabled('X', { X: '1' })).toBe(true);
    const was = process.env.PUBLISH_ISSUE_UPDATE;
    delete process.env.PUBLISH_ISSUE_UPDATE;
    try {
      expect(upsertBlockedIssue({ prefix: PUBLISH_BLOCKED_ISSUE_PREFIX, flag: 'PUBLISH_ISSUE_UPDATE', workflowName: 'w', failure: {}, body: 'b' })).toBe(false);
      expect(resolveBlockedIssues({ prefix: PUBLISH_BLOCKED_ISSUE_PREFIX, flag: 'PUBLISH_ISSUE_UPDATE', workflowName: 'w' })).toBe(false);
    } finally {
      if (was !== undefined) process.env.PUBLISH_ISSUE_UPDATE = was;
    }
  });
});

describe('Pages publish queue wiring', () => {
  const request = readFileSync(resolve('.github/workflows/deploy-request.yml'), 'utf8');
  const publish = readFileSync(resolve('.github/workflows/deploy-publish.yml'), 'utf8');

  it('runs only the status-aware publish reconciler from the existing checkout', () => {
    expect(request).toContain('/scripts/ci/request-latest-publish.mjs');
    expect(request).toContain('node scripts/ci/request-latest-publish.mjs');
    expect(request).toContain("cron: '*/10 * * * *'");
    expect(request).toContain('actions: write');
    expect(request).toContain('deployments: read');
    // The job token writes the rebuild request; the App token still reads statuses.
    expect(request).toContain('statuses: write');
    expect(request).toContain("APP_TOKEN_REQUEST_DEPLOYMENTS_READ: 'true'");
    expect(request).toContain('APP_TOKEN_DEPLOYMENTS_READ');
    expect(request).toContain('APP_TOKEN_STATUSES_READ');
    expect(request).not.toContain('request-latest-deploy.mjs');
    expect(request).not.toContain('gh workflow run deploy.yml');
  });

  it('gives the reconciler job exactly the permissions its escalation writes need', () => {
    const doc = YAML.parse(request) as any;
    expect(doc.permissions).toEqual({ contents: 'read' });
    expect(doc.jobs.request.permissions).toEqual({
      contents: 'read',
      actions: 'write',
      deployments: 'read',
      statuses: 'write',
      issues: 'write',
    });
    const step = doc.jobs.request.steps.find((entry: any) => String(entry.run || '').includes('request-latest-publish.mjs'));
    expect(step.env.ESCALATION_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(step.env.PUBLISH_ISSUE_UPDATE).toBe('1');
    expect(step.run).not.toContain('${{');
  });

  it('checks out every module the reconciler imports', () => {
    const doc = YAML.parse(request) as any;
    const checkout = doc.jobs.request.steps.find((entry: any) => entry.uses?.startsWith('actions/checkout'));
    const sparse = String(checkout.with['sparse-checkout']).split('\n').map((line: string) => line.trim());
    for (const file of [
      'scripts/ci/deploy-rearm-request.mjs',
      'scripts/ci/deploy-failure-classifier.mjs',
      'scripts/ci/lib/deploy-job-failure-signature.mjs',
      'scripts/ci/lib/deploy-run-evidence.mjs',
      'scripts/ci/lib/deploy-blocked-issue.mjs',
      'scripts/lib/int-from-env.mjs',
      'scripts/lib/github-issue-creator.mjs',
    ]) expect(sparse, file).toContain(`/${file}`);
  });

  it('passes the minted App token to the reconciler at shell runtime', () => {
    expect(request).toContain('GH_TOKEN="$APP_TOKEN" node scripts/ci/request-latest-publish.mjs');
    expect(request).not.toMatch(/GH_TOKEN:.*env\.APP_TOKEN/);
  });

  it('maps the raw publish run name before counting source-linked attempts', () => {
    const source = readFileSync(resolve('scripts/ci/request-latest-publish.mjs'), 'utf8');
    const mapStart = source.indexOf('function mapPublish');
    const listStart = source.indexOf('async function listWorkflowRuns');
    expect(source.slice(mapStart, listStart)).toMatch(/runName:\s*text\(run\?\.run_name\)/);
  });

  it('makes the source build explicit and removes the workflow_run pending-slot fan-in', () => {
    const on = (YAML.parse(publish) as { on?: Record<string, unknown> }).on ?? {};
    expect(Object.keys(on)).toEqual(['workflow_dispatch']);
    expect(publish).not.toContain('workflows: ["Deploy to GitHub Pages"]');
    for (const input of [
      'source_run_id',
      'source_sha',
      'source_conclusion',
      'source_branch',
      'source_event_name',
      'source_workflow',
      'source_workflow_path',
      'source_workflow_id',
    ]) expect(publish).toContain(`${input}:`);
    expect(publish).toContain("'pages-deploy'");
    expect(publish).toContain('cancel-in-progress: false');
  });

  it('does not start the publisher from a scheduled deploy run', () => {
    const deploy = readFileSync(resolve('.github/workflows/deploy.yml'), 'utf8');
    const workflow = YAML.parse(deploy) as {
      jobs?: Record<string, { steps?: Array<{ if?: string; run?: string }> }>;
    };
    const publisher = workflow.jobs?.rearm?.steps?.find((step) => step.run?.includes('deploy-publish.yml'));

    expect(publisher?.if).toBe("(github.event_name == 'workflow_dispatch' || github.event_name == 'push') && needs.build-locale.result == 'success'");
  });

  it('runs path-sensitive shard publishers from the dispatch SHA (current main) for historical tails', () => {
    const workflow = YAML.parse(publish) as any;
    const job = workflow.jobs?.['publish-nonit-shards'];
    const steps = job?.steps ?? [];
    const checkout = steps.find((step: any) => step.name === 'Checkout current shard publisher');
    const sparse = String(checkout?.with?.['sparse-checkout'] ?? '')
      .split('\n')
      .map((entry: string) => entry.trim())
      .filter(Boolean);
    const sectionPush = steps.find((step: any) => step.name === 'Push section shards (non-IT → frontaliere-<section>-<loc>)');
    const localePush = steps.find((step: any) => step.name === 'Push locale shard');
    const offload = steps.find((step: any) => step.name === 'Offload shard refs to CDN');

    // Pinned to github.sha: the dispatch SHA every job of the run shares, not a
    // moving refs/heads/main (tests/deploy-publish-pinned-toolchain.test.ts).
    expect(checkout?.with?.ref).toBe('${{ github.sha }}');
    expect(checkout?.with?.path).toBe('publisher-resolver');
    expect(checkout?.with?.['sparse-checkout-cone-mode']).toBe(false);
    expect(sparse).toEqual([
      '/scripts/ci/',
      '/scripts/lib/',
      '/scripts/offload-generated-images-cdn.mjs',
      '/build-plugins/shared/',
      '/infra/cloudflare-worker/',
      '/services/publicConfigConstants.mjs',
    ]);
    expect(String(job?.env?.PUBLISHER_ROOT)).toBe('${{ github.workspace }}/publisher-resolver');
    expect(String(job?.env?.PUBLISHER_DIST)).toBe('${{ github.workspace }}/dist');
    expect(sectionPush?.run).toContain('$PUBLISHER_ROOT/scripts/lib/push-section-shard.sh');
    expect(sectionPush?.run).toContain('"$PUBLISHER_DIST"');
    expect(localePush?.run).toContain('$PUBLISHER_ROOT/scripts/lib/push-locale-shard.sh');
    expect(localePush?.run).toContain('"$PUBLISHER_DIST"');
    expect(offload?.run).toContain('$PUBLISHER_ROOT/scripts/offload-generated-images-cdn.mjs');
  });
});
