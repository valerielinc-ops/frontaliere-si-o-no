import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import {
  decideLatestDeploy,
  DEFAULT_MAX_BUILDS_PER_SHA,
} from '../scripts/ci/request-latest-deploy.mjs';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const done = (id: number, headSha: string, conclusion: string) => ({
  id,
  headSha,
  status: 'completed',
  conclusion,
});
const live = (id: number, status: string) => ({ id, headSha: HEAD, status, conclusion: null });

describe('decideLatestDeploy', () => {
  it.each(['queued', 'in_progress', 'waiting', 'requested', 'pending'])('waits while a build is %s', (status) => {
    expect(decideLatestDeploy({ headSha: HEAD, runs: [live(1, status)] })).toMatchObject({
      action: 'skip',
      reason: 'pipeline-moving',
    });
  });

  it('dispatches the current tip after a burst superseded older commits', () => {
    expect(decideLatestDeploy({
      headSha: HEAD,
      runs: [done(1, OLD, 'cancelled'), done(2, OLD, 'cancelled')],
    })).toMatchObject({ action: 'dispatch', reason: 'pipeline-idle', headSha: HEAD });
  });

  it('does not rebuild a tip that already completed successfully', () => {
    expect(decideLatestDeploy({ headSha: HEAD, runs: [done(1, HEAD, 'success')] })).toMatchObject({
      action: 'skip',
      reason: 'head-already-built',
    });
  });

  it('gives a newer tip a fresh attempt budget', () => {
    const failedHead = [done(1, HEAD, 'failure'), done(2, HEAD, 'failure')];
    expect(decideLatestDeploy({ headSha: HEAD, runs: failedHead }).reason).toBe('attempt-cap');
    expect(decideLatestDeploy({ headSha: OLD, runs: failedHead }).action).toBe('dispatch');
  });

  it('fails closed when the current tip cannot be resolved', () => {
    expect(decideLatestDeploy({ headSha: '', runs: [] })).toMatchObject({
      action: 'skip',
      reason: 'no-head-sha',
    });
    expect(DEFAULT_MAX_BUILDS_PER_SHA).toBe(2);
  });
});

describe('deploy-request.yml contract', () => {
  const requestPath = resolve('.github/workflows/deploy-request.yml');
  const deployPath = resolve('.github/workflows/deploy.yml');
  const request = readFileSync(requestPath, 'utf8');
  const deploy = readFileSync(deployPath, 'utf8');

  it('keeps the expensive build dispatch-only', () => {
    const on = (YAML.parse(deploy) as { on?: Record<string, unknown> }).on ?? {};
    expect(Object.keys(on)).not.toContain('push');
    expect(Object.keys(on)).toContain('workflow_dispatch');
    expect(deploy).toContain('group: pages-build-run');
    expect(deploy).toMatch(/cancel-in-progress:\s*false/);
  });

  it('owns push and completion events in the cheap request workflow', () => {
    const on = (YAML.parse(request) as { on?: Record<string, unknown> }).on ?? {};
    expect(Object.keys(on)).toEqual(expect.arrayContaining(['push', 'workflow_run', 'workflow_dispatch']));
    expect(request).toContain('paths-ignore:');
    expect(request).toContain('scripts/ci/request-latest-deploy.mjs');
    expect(request).toContain('scripts/ci/mint-app-token.mjs');
    expect(request).toContain('/functions/src/githubApiHeaders.js');
    expect(request).toContain('APP_TOKEN_ACTIONS:-false');
    expect(request).toMatch(/actions:\s*write/);
  });

  it('does not introduce a second production build lock', () => {
    expect(request).toContain('group: deploy-request-dispatcher');
    expect(request).toContain('cancel-in-progress: false');
    expect(request).not.toMatch(/group:\s*pages-build-run/);
  });
});
