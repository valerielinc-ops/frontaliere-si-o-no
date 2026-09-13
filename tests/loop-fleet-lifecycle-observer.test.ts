import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — the lifecycle observer is a dependency-free ESM CI script.
import { observeLifecycle } from '../scripts/ci/observe-loop-fleet-lifecycle.mjs';
// @ts-expect-error — the lifecycle appender is a dependency-free ESM CI script.
import { appendLoopFleetLifecycle } from '../scripts/ci/append-loop-fleet-lifecycle.mjs';
import { buildLifecycleEvent } from '../scripts/lib/loop-fleet-contract.mjs';

const registry = JSON.parse(fs.readFileSync(path.resolve('data/loop-fleet/loop-registry.json'), 'utf8'));
const SOURCE_SHA = 'a'.repeat(40);
const OBSERVER_SHA = 'b'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);
const NOW = new Date('2026-09-13T12:00:00.000Z');

function candidate() {
  const policy = registry.loops.find((loop: { loopId: string }) => loop.loopId === 'L0');
  return {
    ...buildLifecycleEvent({
      eventType: 'candidate',
      loopId: 'L0',
      candidateId: 'lf-decision-observer-test',
      owner: policy.owner,
      sourceRecordId: 'decision-observer-test',
      sourceRefs: policy.sourceRefs,
      lifecycle: policy.lifecycle,
      occurredAt: '2026-09-10T10:00:00.000Z',
      recordedAt: '2026-09-10T10:00:00.000Z',
    }),
    recordId: 'lf-lifecycle-candidate-observer-test',
    execution: {
      loopId: 'L0',
      repository: 'example/frontaliere',
      workflow: 'Loop L0 data truth',
      runId: '123',
      sha: SOURCE_SHA,
    },
  };
}

function fleetPr(overrides: Record<string, unknown> = {}) {
  return {
    number: 999,
    url: 'https://github.com/example/frontaliere/pull/999',
    title: 'chore(loop-fleet): persist L0 durable evidence',
    state: 'MERGED',
    baseRefName: 'main',
    headRefName: 'chore/loop-fleet-ledger',
    headRefOid: 'd'.repeat(40),
    createdAt: '2026-09-10T11:00:00.000Z',
    updatedAt: '2026-09-11T12:00:00.000Z',
    mergedAt: '2026-09-11T10:00:00.000Z',
    mergeCommit: { oid: MERGE_SHA },
    body: 'Auto-generated from immutable run [123] for L0.',
    commits: [{ messageHeadline: 'chore(loop-fleet): persist L0 evidence from run 123' }],
    statusCheckRollup: [
      {
        name: 'vitest (unit + integration)',
        workflowName: 'tests',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        completedAt: '2026-09-11T08:00:00.000Z',
        detailsUrl: 'https://github.com/example/frontaliere/actions/runs/1',
      },
      { name: 'optional check', status: 'COMPLETED', conclusion: 'SKIPPED' },
    ],
    reviews: [{
      state: 'COMMENTED',
      commit: { oid: 'd'.repeat(40) },
      submittedAt: '2026-09-11T09:00:00.000Z',
      body: '## Findings (Important: 0, Nit: 0)\n\n## LGTM',
    }],
    ...overrides,
  };
}

function observerExecution() {
  return {
    repository: 'example/frontaliere',
    workflow: 'Loop fleet independent lifecycle observer',
    event: 'schedule',
    ref: 'refs/heads/main',
    runId: '9999',
    runAttempt: '1',
    sha: OBSERVER_SHA,
  };
}

describe('loop-fleet independent lifecycle observer', () => {
  it('emits only independently observed PR, test, review, merge and post-merge events', () => {
    const result = observeLifecycle({
      registry,
      lifecycleEvents: [candidate()],
      pullRequests: [fleetPr()],
      postMergeRuns: [{
        workflowName: 'Loop fleet status',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        headSha: MERGE_SHA,
        updatedAt: '2026-09-11T11:00:00.000Z',
        url: 'https://github.com/example/frontaliere/actions/runs/2',
      }],
      execution: observerExecution(),
      now: NOW,
    });

    expect(result).toMatchObject({
      candidateCount: 1,
      eligiblePullRequestCount: 1,
      matchCount: 1,
    });
    expect(result.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      'pr_opened',
      'tests_passed',
      'review_approved',
      'merged',
      'post_merge_verified',
    ]);
    expect(result.events.every((event: { execution: { loopId: string; runId: string; sha: string } }) =>
      event.execution.loopId === 'L0'
      && event.execution.runId === '9999'
      && event.execution.sha === OBSERVER_SHA)).toBe(true);
  });

  it('fails closed when tests/review are for a different or unfinished head', () => {
    const result = observeLifecycle({
      registry,
      lifecycleEvents: [candidate()],
      pullRequests: [fleetPr({
        state: 'OPEN',
        mergedAt: null,
        mergeCommit: null,
        statusCheckRollup: [{
          name: 'vitest (unit + integration)',
          workflowName: 'tests',
          status: 'IN_PROGRESS',
          conclusion: '',
        }],
        reviews: [{
          commit: { oid: 'e'.repeat(40) },
          submittedAt: '2026-09-11T09:00:00.000Z',
          body: '## Findings (Important: 0, Nit: 0)\n\n## LGTM',
        }],
      })],
      postMergeRuns: [],
      execution: observerExecution(),
      now: NOW,
    });
    expect(result.events.map((event: { eventType: string }) => event.eventType)).toEqual(['pr_opened']);
  });

  it('persists observed events idempotently and rejects recorder-owned events', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-lifecycle-observer-'));
    const eventsFile = path.join(root, 'events.jsonl');
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    const observed = observeLifecycle({
      registry,
      lifecycleEvents: [candidate()],
      pullRequests: [fleetPr()],
      postMergeRuns: [{
        workflowName: 'Loop fleet ledger audit',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        headSha: MERGE_SHA,
        updatedAt: '2026-09-11T11:00:00.000Z',
        url: 'https://github.com/example/frontaliere/actions/runs/3',
      }],
      execution: observerExecution(),
      now: NOW,
    });
    fs.writeFileSync(eventsFile, `${observed.events.map((event: unknown) => JSON.stringify(event)).join('\n')}\n`);

    expect(appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toMatchObject({ inputRecords: 5, appended: 5, skipped: 0 });
    expect(appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toMatchObject({ inputRecords: 5, appended: 0, skipped: 5 });

    const recorderEvent = { ...candidate(), eventType: 'candidate' };
    fs.writeFileSync(eventsFile, `${JSON.stringify(recorderEvent)}\n`);
    expect(() => appendLoopFleetLifecycle({ eventsFile, ledgerDir })).toThrow('must be a downstream event');
  });
});
