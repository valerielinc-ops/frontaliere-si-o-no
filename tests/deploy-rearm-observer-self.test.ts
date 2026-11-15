import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  countRearmFailuresInWindow,
  decideFailureBackoff,
  FAILURE_BACKOFF_MINUTES,
  sequenceConcludedRuns,
} from '../scripts/ci/rearm-deploy-build.mjs';

const NOW_MS = Date.parse('2026-11-15T17:14:43Z');
const MINUTE_MS = 60_000;
const FAILED_DEPLOY_RUN = {
  id: '43728895227',
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'failure',
  createdAt: '2026-11-15T15:15:53Z',
  updatedAt: '2026-11-15T15:25:15Z',
  headSha: '911e2476…',
};

function observerSequence(runs = [FAILED_DEPLOY_RUN], nowMs = NOW_MS) {
  return sequenceConcludedRuns({
    runs,
    selfRunId: '999',
    selfConclusion: '',
    nowMs,
  }).sequence;
}

describe('watchdog observer self-run handling', () => {
  it('keeps the failed deploy as the latest verdict when the watchdog run is absent', () => {
    const sequence = observerSequence();

    expect(sequence[0].id).toBe('43728895227');
    expect(sequence[0].failed).toBe(true);
    expect(sequence[0].endedAtMs).toBe(Date.parse('2026-11-15T15:25:15Z'));
    expect(sequence.some((run) => String(run.id) === '999')).toBe(false);
  });

  it('excludes the watchdog self-run when it is present but still in progress', () => {
    const sequence = observerSequence([
      FAILED_DEPLOY_RUN,
      {
        id: '999',
        event: 'workflow_dispatch',
        status: 'in_progress',
        conclusion: null,
        createdAt: '2026-11-15T17:10:00Z',
        headSha: 'watchdog-head',
      },
    ]);

    expect(sequence.map((run) => String(run.id))).toEqual(['43728895227']);
  });

  it('uses the historic failure time across successive watchdog ticks after the backoff elapsed', () => {
    const sequence = observerSequence();
    const failure = {
      classification: 'unknown',
      signature: 'prep::Mine all job slugs for 404 coverage::x',
      streak: 1,
      lastEndedAtMs: sequence[0].endedAtMs,
    };
    const backoffDeadlineMs = failure.lastEndedAtMs + FAILURE_BACKOFF_MINUTES.unknown[0] * MINUTE_MS;
    const firstTick = decideFailureBackoff({ nowMs: NOW_MS, failure });
    const secondTick = decideFailureBackoff({ nowMs: NOW_MS + 10 * MINUTE_MS, failure });

    expect(FAILURE_BACKOFF_MINUTES.unknown[0]).toBe(10);
    expect(backoffDeadlineMs).toBe(Date.parse('2026-11-15T15:35:15Z'));
    expect(firstTick).toMatchObject({ action: 'proceed', reason: 'failure-backoff-elapsed' });
    expect(secondTick).toEqual(firstTick);
    expect(firstTick.nextAtMs).toBeUndefined();
    expect(secondTick.nextAtMs).toBeUndefined();
    expect(failure.lastEndedAtMs).toBe(Date.parse('2026-11-15T15:25:15Z'));
  });

  it('preserves failure/success self verdicts and excludes observers from the re-arm budget', () => {
    const selfRun = {
      id: '999',
      event: 'workflow_dispatch',
      status: 'in_progress',
      conclusion: null,
      actor: 'github-actions[bot]',
      createdAt: '2026-11-15T17:10:00Z',
      headSha: 'watchdog-head',
    };
    const runs = [FAILED_DEPLOY_RUN, selfRun];
    const failedSelf = sequenceConcludedRuns({ runs, selfRunId: '999', selfConclusion: 'failure', nowMs: NOW_MS }).sequence;
    const successfulSelf = sequenceConcludedRuns({ runs, selfRunId: '999', selfConclusion: 'success', nowMs: NOW_MS }).sequence;

    expect(failedSelf[0]).toMatchObject({ id: '999', conclusion: 'failure', failed: true, endedAtMs: NOW_MS });
    expect(successfulSelf[0]).toMatchObject({ id: '999', conclusion: 'success', failed: false, endedAtMs: NOW_MS });

    const countSelf = (selfConclusion?: string) => countRearmFailuresInWindow({
      runs: [selfRun],
      selfRunId: '999',
      selfConclusion,
      nowMs: NOW_MS,
    });
    expect(countSelf('')).toBe(0);
    expect(countSelf(undefined)).toBe(0);
    expect(countSelf('failure')).toBe(1);
    expect(countSelf('success')).toBe(0);
  });

  it('keeps the workflow contract: deploy provides a verdict and the watchdog remains an observer', () => {
    const deployText = readFileSync(resolve(process.cwd(), '.github/workflows/deploy.yml'), 'utf8');
    const watchdogText = readFileSync(resolve(process.cwd(), '.github/workflows/deploy-stalled-watchdog.yml'), 'utf8');
    const deploy = YAML.parse(deployText) as {
      jobs?: Record<string, { steps?: Array<{ env?: Record<string, unknown> }> }>;
    };

    expect(deploy.jobs?.rearm?.steps?.some((step) => Object.hasOwn(step.env ?? {}, 'REARM_SELF_CONCLUSION'))).toBe(true);
    expect(watchdogText).not.toContain('REARM_SELF_CONCLUSION');
  });
});
