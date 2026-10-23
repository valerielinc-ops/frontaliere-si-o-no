import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import {
  decideLatestPublish,
  DEFAULT_MAX_PUBLISH_ATTEMPTS,
  deploymentSourceSha,
} from '../scripts/ci/request-latest-publish.mjs';

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

describe('Pages publish queue wiring', () => {
  const request = readFileSync(resolve('.github/workflows/deploy-request.yml'), 'utf8');
  const publish = readFileSync(resolve('.github/workflows/deploy-publish.yml'), 'utf8');

  it('runs only the status-aware publish reconciler from the existing checkout', () => {
    expect(request).toContain('/scripts/ci/request-latest-publish.mjs');
    expect(request).toContain('node scripts/ci/request-latest-publish.mjs');
    expect(request).toContain("cron: '*/10 * * * *'");
    expect(request).toContain('actions: write');
    expect(request).toContain('deployments: read');
    expect(request).toContain('statuses: read');
    expect(request).toContain("APP_TOKEN_REQUEST_DEPLOYMENTS_READ: 'true'");
    expect(request).toContain('APP_TOKEN_DEPLOYMENTS_READ');
    expect(request).toContain('APP_TOKEN_STATUSES_READ');
    expect(request).not.toContain('request-latest-deploy.mjs');
    expect(request).not.toContain('gh workflow run deploy.yml');
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
});
