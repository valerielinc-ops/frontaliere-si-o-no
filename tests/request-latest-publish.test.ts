import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import {
  decideLatestPublish,
  DEFAULT_MAX_PUBLISH_ATTEMPTS,
} from '../scripts/ci/request-latest-publish.mjs';

const SHA_OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_LATEST = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

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

  it('treats an exact successful deployment as already live', () => {
    expect(decideLatestPublish({
      builds: [build(2, SHA_LATEST, '2026-10-20T12:00:00Z')],
      publishRuns: [],
      lastSuccessfulDeployment: deployment(SHA_LATEST, '2026-10-20T12:05:00Z'),
    })).toMatchObject({ action: 'skip', reason: 'already-live' });
  });

  it('does not roll Pages back to a build completed before the live deployment', () => {
    expect(decideLatestPublish({
      builds: [build(2, SHA_OLD, '2026-10-20T12:00:00Z')],
      publishRuns: [],
      lastSuccessfulDeployment: deployment('cccccccccccccccccccccccccccccccccccccccc', '2026-10-20T12:01:00Z'),
    })).toMatchObject({ action: 'skip', reason: 'already-live' });
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
});

describe('Pages publish queue wiring', () => {
  const request = readFileSync(resolve('.github/workflows/deploy-request.yml'), 'utf8');
  const publish = readFileSync(resolve('.github/workflows/deploy-publish.yml'), 'utf8');

  it('runs the publish reconciler from the existing durable coordinator checkout', () => {
    expect(request).toContain('/scripts/ci/request-latest-publish.mjs');
    expect(request).toContain('node scripts/ci/request-latest-publish.mjs');
    expect(request).toContain("cron: '*/5 * * * *'");
    expect(request).toContain('actions: write');
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
});

