import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — the lifecycle observer is a dependency-free ESM CI script.
import {
  explicitTerminalEvidence,
  expiredClosedPullRequestEvidence,
  isFleetLedgerPr,
  observeLifecycle,
} from '../scripts/ci/observe-loop-fleet-lifecycle.mjs';
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

function recorderEvent(
  eventType: string,
  candidateId: string,
  occurredAt: string,
  runId: number,
  sourceRecordId = candidateId,
) {
  const policy = registry.loops.find((loop: { loopId: string }) => loop.loopId === 'L0');
  return {
    ...buildLifecycleEvent({
      eventType,
      loopId: 'L0',
      candidateId,
      owner: policy.owner,
      sourceRecordId,
      sourceRefs: policy.sourceRefs,
      lifecycle: policy.lifecycle,
      occurredAt,
      recordedAt: occurredAt,
    }),
    recordId: `lf-recorder-${candidateId}-${eventType}-${runId}`,
    execution: {
      loopId: 'L0',
      repository: 'example/frontaliere',
      workflow: 'Loop L0 data truth',
      runId: String(runId),
      sha: SOURCE_SHA,
    },
  };
}

function recorderChain(candidateId: string) {
  const occurredAt = '2026-09-10T10:00:00.000Z';
  return [
    recorderEvent('candidate', candidateId, occurredAt, 20_000),
    recorderEvent('owner_assigned', candidateId, occurredAt, 20_001),
  ];
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

function terminalEvent(eventType: string, candidateId: string, occurredAt: string, runId: number) {
  const policy = registry.loops.find((loop: { loopId: string }) => loop.loopId === 'L0');
  return {
    ...buildLifecycleEvent({
      eventType,
      loopId: 'L0',
      candidateId,
      owner: policy.owner,
      sourceRecordId: candidateId,
      sourceRefs: policy.sourceRefs,
      lifecycle: policy.lifecycle,
      occurredAt,
      artifactOrPr: `https://example.test/lifecycle/${candidateId}/${eventType}`,
      recordedAt: occurredAt,
    }),
    recordId: `lf-terminal-appender-${candidateId}-${eventType}-${runId}`,
    execution: {
      loopId: 'L0',
      repository: 'example/frontaliere',
      workflow: 'Loop fleet independent lifecycle observer',
      runId: String(runId),
      sha: OBSERVER_SHA,
    },
  };
}

function lifecyclePrefix(candidateId: string, through: string) {
  const eventTimes: Record<string, string> = {
    pr_opened: '2026-09-10T11:00:00.000Z',
    tests_passed: '2026-09-10T12:00:00.000Z',
    review_approved: '2026-09-10T13:00:00.000Z',
    merged: '2026-09-10T14:00:00.000Z',
    post_merge_verified: '2026-09-10T15:00:00.000Z',
    rollback_requested: '2026-09-10T16:00:00.000Z',
    rolled_back: '2026-09-10T17:00:00.000Z',
  };
  const eventTypes = Object.keys(eventTimes);
  const throughIndex = eventTypes.indexOf(through);
  if (throughIndex < 0) throw new Error(`unknown lifecycle prefix ${through}`);
  return [
    ...recorderChain(candidateId),
    ...eventTypes.slice(0, throughIndex + 1).map((eventType, index) =>
      terminalEvent(eventType, candidateId, eventTimes[eventType], 21_000 + index)),
  ];
}

function writeJsonl(file: string, events: unknown[]) {
  fs.writeFileSync(file, events.length
    ? `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
    : '');
}

function readJsonlForTest(file: string) {
  return fs.readFileSync(file, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as { eventType: string });
}

function seedLedger(ledgerDir: string, events: unknown[]) {
  writeJsonl(path.join(ledgerDir, 'lifecycle-events.jsonl'), events);
}

describe('loop-fleet independent lifecycle observer', () => {
  it('recognizes only bridge producer branches and excludes lifecycle writer branches', () => {
    expect(isFleetLedgerPr(fleetPr({ headRefName: 'chore/loop-fleet-ledger' }))).toBe(true);
    expect(isFleetLedgerPr(fleetPr({ headRefName: 'chore/loop-fleet-ledger-L11-123-2' }))).toBe(true);
    expect(isFleetLedgerPr(fleetPr({ headRefName: 'chore/loop-fleet-ledger-lifecycle' }))).toBe(false);
    expect(isFleetLedgerPr(fleetPr({ headRefName: 'chore/loop-fleet-ledger-lifecycle-123-2' }))).toBe(false);
    expect(isFleetLedgerPr(fleetPr({ headRefName: 'chore/loop-fleet-ledger-L12-123-2' }))).toBe(false);
  });

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

  it('accepts only explicit terminal markers from trusted repository collaborators', () => {
    const pr = fleetPr({
      comments: [
        {
          body: '<!-- loop-fleet-lifecycle: rolled_back candidate=lf-decision-observer-test -->',
          createdAt: '2026-09-11T11:30:00.000Z',
          url: 'https://github.com/example/frontaliere/pull/999#issuecomment-1',
          authorAssociation: 'MEMBER',
        },
        {
          body: '<!-- loop-fleet-lifecycle: inconclusive candidate=lf-decision-observer-test -->',
          createdAt: '2026-09-11T11:31:00.000Z',
          url: 'https://github.com/example/frontaliere/pull/999#issuecomment-2',
          authorAssociation: 'NONE',
        },
        {
          body: '<!-- loop-fleet-lifecycle: rollback_requested candidate=lf-decision-observer-test -->',
          createdAt: '2026-09-11T11:32:00.000Z',
          url: 'https://github.com/example/frontaliere/pull/999#issuecomment-3',
          authorAssociation: 'COLLABORATOR',
        },
      ],
    });
    expect(explicitTerminalEvidence(pr, 'lf-decision-observer-test', NOW)).toEqual({
      rolled_back: {
        eventType: 'rolled_back',
        occurredAt: '2026-09-11T11:30:00.000Z',
        artifactOrPr: 'https://github.com/example/frontaliere/pull/999#issuecomment-1',
      },
      rollback_requested: {
        eventType: 'rollback_requested',
        occurredAt: '2026-09-11T11:32:00.000Z',
        artifactOrPr: 'https://github.com/example/frontaliere/pull/999#issuecomment-3',
      },
    });
  });

  it('records explicit rollback lifecycle evidence without inferring it', () => {
    const result = observeLifecycle({
      registry,
      lifecycleEvents: [candidate()],
      pullRequests: [fleetPr({
        comments: [
          {
            body: '<!-- loop-fleet-lifecycle: rollback_requested candidate=lf-decision-observer-test -->',
            createdAt: '2026-09-11T11:30:00.000Z',
            url: 'https://github.com/example/frontaliere/pull/999#issuecomment-1',
            authorAssociation: 'MEMBER',
          },
          {
            body: '<!-- loop-fleet-lifecycle: rolled_back candidate=lf-decision-observer-test -->',
            createdAt: '2026-09-11T11:31:00.000Z',
            url: 'https://github.com/example/frontaliere/pull/999#issuecomment-2',
            authorAssociation: 'OWNER',
          },
        ],
      })],
      postMergeRuns: [],
      execution: observerExecution(),
      now: NOW,
    });
    expect(result.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      'pr_opened',
      'tests_passed',
      'review_approved',
      'merged',
      'rollback_requested',
      'rolled_back',
    ]);
  });

  it('observes a trusted inconclusive marker for the addressed candidate only', () => {
    const result = observeLifecycle({
      registry,
      lifecycleEvents: [candidate()],
      pullRequests: [fleetPr({
        comments: [
          {
            body: '<!-- loop-fleet-lifecycle: inconclusive candidate=another-candidate -->',
            createdAt: '2026-09-11T11:30:00.000Z',
            url: 'https://github.com/example/frontaliere/pull/999#issuecomment-1',
            authorAssociation: 'OWNER',
          },
          {
            body: '<!-- loop-fleet-lifecycle: inconclusive candidate=lf-decision-observer-test -->',
            createdAt: '2026-09-11T11:31:00.000Z',
            url: 'https://github.com/example/frontaliere/pull/999#issuecomment-2',
            authorAssociation: 'COLLABORATOR',
          },
        ],
      })],
      execution: observerExecution(),
      now: NOW,
    });
    expect(result.events.map((event: { eventType: string }) => event.eventType)).toContain('inconclusive');
    expect(result.events.find((event: { eventType: string }) => event.eventType === 'inconclusive'))
      .toMatchObject({ candidateId: 'lf-decision-observer-test' });
  });

  it('marks a closed unmerged transport inconclusive only after the registry TTL', () => {
    const closedUnmerged = fleetPr({
      state: 'CLOSED',
      mergedAt: null,
      mergeCommit: null,
      updatedAt: '2026-09-10T13:00:00.000Z',
    });
    expect(expiredClosedPullRequestEvidence(
      candidate(),
      closedUnmerged,
      new Date('2026-09-10T11:59:59.000Z'),
    )).toBeNull();
    expect(expiredClosedPullRequestEvidence(candidate(), closedUnmerged, NOW)).toEqual({
      occurredAt: NOW.toISOString(),
      artifactOrPr: closedUnmerged.url,
    });

    const result = observeLifecycle({
      registry,
      lifecycleEvents: [candidate()],
      pullRequests: [closedUnmerged],
      postMergeRuns: [],
      execution: observerExecution(),
      now: NOW,
    });
    expect(result.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      'pr_opened',
      'tests_passed',
      'review_approved',
      'inconclusive',
    ]);
    expect(result).toMatchObject({
      autoInconclusiveCount: 1,
      autoInconclusiveEligibleCount: 1,
      autoInconclusiveDeferredCount: 0,
      matches: [{ autoInconclusive: true }],
    });
  });

  it('keeps an overdue open PR pending and never infers inconclusive from it', () => {
    const result = observeLifecycle({
      registry,
      lifecycleEvents: [candidate()],
      pullRequests: [fleetPr({
        state: 'OPEN',
        mergedAt: null,
        mergeCommit: null,
      })],
      postMergeRuns: [],
      execution: observerExecution(),
      now: NOW,
    });
    expect(result.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      'pr_opened',
      'tests_passed',
      'review_approved',
    ]);
    expect(result.autoInconclusiveCount).toBe(0);
    expect(result.matches[0].autoInconclusive).toBe(false);
  });

  it('persists observed events idempotently and rejects recorder-owned events', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-lifecycle-observer-'));
    const eventsFile = path.join(root, 'events.jsonl');
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    seedLedger(ledgerDir, [
      candidate(),
      recorderEvent(
        'owner_assigned',
        'lf-decision-observer-test',
        '2026-09-10T10:00:00.000Z',
        124,
        'decision-observer-test',
      ),
    ]);
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

    const retried = observed.events.map((event: Record<string, unknown>) => ({
      ...event,
      recordedAt: '2026-09-13T12:05:00.000Z',
      execution: {
        ...(event.execution as Record<string, unknown>),
        event: 'workflow_dispatch',
        runId: '10000',
        sha: 'e'.repeat(40),
        recordedAt: '2026-09-13T12:05:00.000Z',
      },
    }));
    fs.writeFileSync(eventsFile, `${retried.map((event: unknown) => JSON.stringify(event)).join('\n')}\n`);
    expect(appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toMatchObject({ inputRecords: 5, appended: 0, skipped: 5 });

    const conflicting = { ...retried[0], artifactOrPr: 'https://github.com/example/frontaliere/pull/1000' };
    fs.writeFileSync(eventsFile, `${JSON.stringify(conflicting)}\n`);
    expect(() => appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toThrow('conflicting duplicate');

    const recorderOwnedEvent = { ...candidate(), eventType: 'candidate' };
    fs.writeFileSync(eventsFile, `${JSON.stringify(recorderOwnedEvent)}\n`);
    expect(() => appendLoopFleetLifecycle({ eventsFile, ledgerDir })).toThrow('must be a downstream event');
  });

  it('rejects a new downstream event when its predecessor chain is incomplete', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-missing-predecessors-'));
    const eventsFile = path.join(root, 'events.jsonl');
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    const candidateId = 'lf-missing-predecessors';
    seedLedger(ledgerDir, recorderChain(candidateId));
    const before = fs.readFileSync(path.join(ledgerDir, 'lifecycle-events.jsonl'), 'utf8');
    writeJsonl(eventsFile, [terminalEvent(
      'review_approved',
      candidateId,
      '2026-09-10T13:00:00.000Z',
      22_000,
    )]);

    expect(() => appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    // `tests_passed` is NOT a predecessor of `review_approved`: this repo's
    // review gate runs inside the test job, so at review time the tests have
    // not finished (110/110 candidates of the 2026-09-18 batch, 234/234 already
    // persisted). `pr_opened` remains required.
    })).toThrow(/review_approved requires predecessor chain: pr_opened/u);
    expect(fs.readFileSync(path.join(ledgerDir, 'lifecycle-events.jsonl'), 'utf8')).toBe(before);
  });

  it('accepts a review that precedes the test job it was emitted from', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-review-concurrency-'));
    const eventsFile = path.join(root, 'events.jsonl');
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    const candidateId = 'lf-review-concurrency';
    seedLedger(ledgerDir, recorderChain(candidateId));
    // The real shape of every observed candidate: the review lands while the
    // `vitest (unit + integration)` job that carries it is still running, and
    // the merge is triggered by that review, so it can precede the job's own
    // completion (#8916: merged 18:49:04, job completed 18:49:28).
    writeJsonl(eventsFile, [
      terminalEvent('pr_opened', candidateId, '2026-09-10T11:00:00.000Z', 23_000),
      terminalEvent('review_approved', candidateId, '2026-09-10T11:05:58.000Z', 23_001),
      terminalEvent('merged', candidateId, '2026-09-10T11:06:20.000Z', 23_002),
      terminalEvent('tests_passed', candidateId, '2026-09-10T11:09:14.000Z', 23_003),
    ]);

    expect(appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toMatchObject({ inputRecords: 4, appended: 4, skipped: 0 });
  });

  it('accepts a drift-fallback merge that produced no reviewable authorisation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-drift-fallback-'));
    const eventsFile = path.join(root, 'events.jsonl');
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    const candidateId = 'lf-drift-fallback';
    seedLedger(ledgerDir, recorderChain(candidateId));
    // The 233 review-less merged candidates collapse to 23 distinct bot PRs whose
    // head moved past the reviewed commit, so no `review_approved` was emitted for
    // them even though 21 of 22 do carry an LGTM on an earlier commit.
    writeJsonl(eventsFile, [
      terminalEvent('pr_opened', candidateId, '2026-09-10T11:00:00.000Z', 24_000),
      terminalEvent('tests_passed', candidateId, '2026-09-10T11:08:00.000Z', 24_001),
      terminalEvent('merged', candidateId, '2026-09-10T11:09:00.000Z', 24_002),
    ]);

    expect(appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toMatchObject({ inputRecords: 3, appended: 3, skipped: 0 });
  });

  it('still rejects a merge recorded before an observed review', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-merge-before-review-'));
    const eventsFile = path.join(root, 'events.jsonl');
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    const candidateId = 'lf-merge-before-review';
    seedLedger(ledgerDir, recorderChain(candidateId));
    const before = fs.readFileSync(path.join(ledgerDir, 'lifecycle-events.jsonl'), 'utf8');
    // Ordered-when-present keeps its teeth: an authorisation the observer DID
    // see may not sit after the merge it is supposed to authorise.
    writeJsonl(eventsFile, [
      terminalEvent('pr_opened', candidateId, '2026-09-10T11:00:00.000Z', 25_000),
      terminalEvent('merged', candidateId, '2026-09-10T11:05:00.000Z', 25_001),
      terminalEvent('review_approved', candidateId, '2026-09-10T11:30:00.000Z', 25_002),
    ]);

    expect(() => appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toThrow(/merged occurs before observed review_approved/u);
    expect(fs.readFileSync(path.join(ledgerDir, 'lifecycle-events.jsonl'), 'utf8')).toBe(before);
  });

  it('rejects a late second authorisation even when an earlier one exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-late-second-auth-'));
    const eventsFile = path.join(root, 'events.jsonl');
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    const candidateId = 'lf-late-second-auth';
    seedLedger(ledgerDir, recorderChain(candidateId));
    const before = fs.readFileSync(path.join(ledgerDir, 'lifecycle-events.jsonl'), 'utf8');
    // With `Math.min` the early review satisfied the check and the one landing
    // after the merge slipped through unnoticed.
    writeJsonl(eventsFile, [
      terminalEvent('pr_opened', candidateId, '2026-09-10T11:00:00.000Z', 27_000),
      terminalEvent('review_approved', candidateId, '2026-09-10T11:02:00.000Z', 27_001),
      terminalEvent('merged', candidateId, '2026-09-10T11:05:00.000Z', 27_002),
      terminalEvent('review_approved', candidateId, '2026-09-10T11:40:00.000Z', 27_003),
    ]);

    expect(() => appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toThrow(/merged occurs before observed review_approved/u);
    expect(fs.readFileSync(path.join(ledgerDir, 'lifecycle-events.jsonl'), 'utf8')).toBe(before);
  });

  it('accepts a candidate that ran two PR cycles before merging', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-two-cycles-'));
    const eventsFile = path.join(root, 'events.jsonl');
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    const candidateId = 'lf-two-cycles';
    seedLedger(ledgerDir, recorderChain(candidateId));
    // Shape of lf-decision-080c86e01b5f17fcc1e886fa: an abandoned first cycle
    // (#8981) then a second that merges (#9041). Every authorisation, from both
    // cycles, still precedes the merge — so `some` must not reject it.
    writeJsonl(eventsFile, [
      terminalEvent('pr_opened', candidateId, '2026-09-10T11:00:00.000Z', 28_000),
      terminalEvent('review_approved', candidateId, '2026-09-10T11:02:00.000Z', 28_001),
      terminalEvent('tests_passed', candidateId, '2026-09-10T11:05:00.000Z', 28_002),
      terminalEvent('pr_opened', candidateId, '2026-09-10T19:00:00.000Z', 28_003),
      terminalEvent('review_approved', candidateId, '2026-09-10T19:28:00.000Z', 28_004),
      terminalEvent('tests_passed', candidateId, '2026-09-10T19:28:10.000Z', 28_005),
      terminalEvent('merged', candidateId, '2026-09-10T19:28:40.000Z', 28_006),
      terminalEvent('post_merge_verified', candidateId, '2026-09-10T19:32:00.000Z', 28_007),
    ]);

    expect(appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toMatchObject({ inputRecords: 8, appended: 8, skipped: 0 });
  });

  it('accepts a PR opened before the recorder noticed the candidate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-recorder-clock-'));
    const eventsFile = path.join(root, 'events.jsonl');
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    const candidateId = 'lf-recorder-clock';
    seedLedger(ledgerDir, recorderChain(candidateId));
    // `candidate`/`owner_assigned` carry a RECORDING clock (the instant the
    // supervisor inventoried the work), not an event clock, so a PR opened
    // before the recorder noticed is normal: measured 454/579 candidates
    // (78.4%), median 17 min and up to 12.7 h earlier. Presence stays required.
    writeJsonl(eventsFile, [
      terminalEvent('pr_opened', candidateId, '2026-09-10T09:00:00.000Z', 26_000),
    ]);

    expect(appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toMatchObject({ inputRecords: 1, appended: 1, skipped: 0 });
  });

  it('rejects a downstream batch when its predecessor appears later in the input', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-out-of-order-batch-'));
    const eventsFile = path.join(root, 'events.jsonl');
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    const candidateId = 'lf-out-of-order-batch';
    seedLedger(ledgerDir, recorderChain(candidateId));
    const before = fs.readFileSync(path.join(ledgerDir, 'lifecycle-events.jsonl'), 'utf8');
    writeJsonl(eventsFile, [
      terminalEvent('tests_passed', candidateId, '2026-09-10T12:00:00.000Z', 22_010),
      terminalEvent('pr_opened', candidateId, '2026-09-10T11:00:00.000Z', 22_011),
    ]);

    expect(() => appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toThrow(/tests_passed requires predecessor chain: pr_opened/u);
    expect(fs.readFileSync(path.join(ledgerDir, 'lifecycle-events.jsonl'), 'utf8')).toBe(before);
  });

  it('accepts a valid full downstream chain incrementally within one batch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-full-chain-'));
    const eventsFile = path.join(root, 'events.jsonl');
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    const candidateId = 'lf-valid-full-chain';
    const chain = lifecyclePrefix(candidateId, 'post_merge_verified');
    seedLedger(ledgerDir, chain.slice(0, 2));
    writeJsonl(eventsFile, chain.slice(2));

    expect(appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toMatchObject({ inputRecords: 5, appended: 5, skipped: 0 });
    expect(readJsonlForTest(path.join(ledgerDir, 'lifecycle-events.jsonl'))
      .map((event) => event.eventType)).toEqual([
      'candidate',
      'owner_assigned',
      'pr_opened',
      'tests_passed',
      'review_approved',
      'merged',
      'post_merge_verified',
    ]);
  });

  it('rejects rollback_requested when it precedes post_merge_verified', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-rollback-order-'));
    const eventsFile = path.join(root, 'events.jsonl');
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    const candidateId = 'lf-invalid-rollback-order';
    seedLedger(ledgerDir, lifecyclePrefix(candidateId, 'post_merge_verified'));
    const before = fs.readFileSync(path.join(ledgerDir, 'lifecycle-events.jsonl'), 'utf8');
    writeJsonl(eventsFile, [terminalEvent(
      'rollback_requested',
      candidateId,
      '2026-09-10T14:30:00.000Z',
      22_100,
    )]);

    expect(() => appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toThrow(/rollback_requested occurs before post_merge_verified/u);
    expect(fs.readFileSync(path.join(ledgerDir, 'lifecycle-events.jsonl'), 'utf8')).toBe(before);
  });

  it('keeps inconclusive terminal semantics explicit at the inclusive TTL boundary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-inconclusive-ttl-'));
    const eventsFile = path.join(root, 'events.jsonl');
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    const candidateId = 'lf-inconclusive-ttl-boundary';
    // This alternative terminal closes an owned candidate that never became
    // a PR; only pr_opened is omitted from the recorder-owned prefix.
    seedLedger(ledgerDir, recorderChain(candidateId));
    writeJsonl(eventsFile, [terminalEvent(
      'inconclusive',
      candidateId,
      '2026-09-10T11:59:59.999Z',
      22_200,
    )]);
    const before = fs.readFileSync(path.join(ledgerDir, 'lifecycle-events.jsonl'), 'utf8');

    expect(() => appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toThrow(/inconclusive occurs before candidate TTL deadline 2026-09-10T12:00:00.000Z/u);
    expect(fs.readFileSync(path.join(ledgerDir, 'lifecycle-events.jsonl'), 'utf8')).toBe(before);

    writeJsonl(eventsFile, [terminalEvent(
      'inconclusive',
      candidateId,
      '2026-09-10T12:00:00.000Z',
      22_201,
    )]);
    expect(appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toMatchObject({ inputRecords: 1, appended: 1, skipped: 0 });
  });

  it('replays an incomplete historical downstream record without applying the new transition rule', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-lifecycle-replay-'));
    const eventsFile = path.join(root, 'events.jsonl');
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    const historical = terminalEvent(
      'tests_passed',
      'lf-historical-incomplete-chain',
      '2026-09-10T12:00:00.000Z',
      22_300,
    );
    seedLedger(ledgerDir, [historical]);
    writeJsonl(eventsFile, [historical]);
    const before = fs.readFileSync(path.join(ledgerDir, 'lifecycle-events.jsonl'), 'utf8');

    expect(appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toMatchObject({ inputRecords: 1, appended: 0, skipped: 1 });
    expect(fs.readFileSync(path.join(ledgerDir, 'lifecycle-events.jsonl'), 'utf8')).toBe(before);
  });

  it('rejects an isolated rolled_back event before writing the ledger', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-terminal-events-'));
    const eventsFile = path.join(root, 'events.jsonl');
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    const events = [terminalEvent(
      'rolled_back',
      'lf-terminal-appender-isolated-rolled-back',
      '2026-09-11T11:30:00.000Z',
      10_000,
    )];
    fs.writeFileSync(eventsFile, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

    expect(() => appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toThrow(/rolled_back requires predecessor chain/u);
    expect(fs.existsSync(path.join(ledgerDir, 'lifecycle-events.jsonl'))).toBe(false);
  });

  it.each([
    {
      label: 'merged',
      eventTypes: ['merged', 'inconclusive'],
      expected: 'inconclusive conflicts with a merged candidate',
    },
    {
      label: 'post_merge_verified',
      eventTypes: ['post_merge_verified', 'inconclusive'],
      expected: 'inconclusive conflicts with a merged candidate',
    },
    {
      label: 'rollback_requested',
      eventTypes: ['post_merge_verified', 'rollback_requested', 'inconclusive'],
      expected: 'inconclusive conflicts with a rollback terminal',
    },
    {
      label: 'rolled_back',
      eventTypes: ['post_merge_verified', 'rollback_requested', 'rolled_back', 'inconclusive'],
      expected: 'inconclusive conflicts with a rollback terminal',
    },
  ])('rejects inconclusive after or alongside an incompatible $label terminal before writing', ({ label, eventTypes, expected }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `loop-fleet-inconclusive-${label}-`));
    const eventsFile = path.join(root, 'events.jsonl');
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    const candidateId = `lf-terminal-appender-inconclusive-${label}`;
    const prefixByLabel: Record<string, string> = {
      merged: 'review_approved',
      post_merge_verified: 'merged',
      rollback_requested: 'post_merge_verified',
      rolled_back: 'post_merge_verified',
    };
    seedLedger(ledgerDir, lifecyclePrefix(candidateId, prefixByLabel[label]));
    const before = fs.readFileSync(path.join(ledgerDir, 'lifecycle-events.jsonl'), 'utf8');
    const events = eventTypes.map((eventType, index) => terminalEvent(
      eventType,
      candidateId,
      `2026-09-11T11:3${index}:00.000Z`,
      10_100 + index,
    ));
    fs.writeFileSync(eventsFile, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

    expect(() => appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toThrow(new RegExp(expected, 'u'));
    expect(fs.readFileSync(path.join(ledgerDir, 'lifecycle-events.jsonl'), 'utf8')).toBe(before);
  });

  it('persists an isolated inconclusive and valid rollback chains idempotently', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-valid-terminal-events-'));
    const eventsFile = path.join(root, 'events.jsonl');
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    seedLedger(ledgerDir, [
      ...lifecyclePrefix('lf-terminal-appender-valid-inconclusive', 'pr_opened'),
      ...lifecyclePrefix('lf-terminal-appender-valid-pending', 'merged'),
      ...lifecyclePrefix('lf-terminal-appender-valid-rolled-back', 'merged'),
    ]);
    const events = [
      terminalEvent('inconclusive', 'lf-terminal-appender-valid-inconclusive', '2026-09-11T11:30:00.000Z', 10_200),
      terminalEvent('post_merge_verified', 'lf-terminal-appender-valid-pending', '2026-09-11T11:30:00.000Z', 10_201),
      terminalEvent('rollback_requested', 'lf-terminal-appender-valid-pending', '2026-09-11T11:31:00.000Z', 10_202),
      terminalEvent('post_merge_verified', 'lf-terminal-appender-valid-rolled-back', '2026-09-11T11:30:00.000Z', 10_203),
      terminalEvent('rollback_requested', 'lf-terminal-appender-valid-rolled-back', '2026-09-11T11:31:00.000Z', 10_204),
      terminalEvent('rolled_back', 'lf-terminal-appender-valid-rolled-back', '2026-09-11T11:32:00.000Z', 10_205),
    ];
    fs.writeFileSync(eventsFile, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

    expect(appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toMatchObject({ inputRecords: 6, appended: 6, skipped: 0 });
    expect(appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toMatchObject({ inputRecords: 6, appended: 0, skipped: 6 });

    const continuation = [terminalEvent(
      'rolled_back',
      'lf-terminal-appender-valid-pending',
      '2026-09-11T11:32:00.000Z',
      10_206,
    )];
    fs.writeFileSync(eventsFile, `${continuation.map((event) => JSON.stringify(event)).join('\n')}\n`);
    expect(appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toMatchObject({ inputRecords: 1, appended: 1, skipped: 0 });

    const inconclusiveAfterMerge = [terminalEvent(
      'inconclusive',
      'lf-terminal-appender-valid-pending',
      '2026-09-11T11:33:00.000Z',
      10_207,
    )];
    fs.writeFileSync(eventsFile, `${inconclusiveAfterMerge.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const beforeRejectedAppend = fs.readFileSync(path.join(ledgerDir, 'lifecycle-events.jsonl'), 'utf8');
    expect(() => appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toThrow(/inconclusive conflicts with a merged candidate/u);
    expect(fs.readFileSync(path.join(ledgerDir, 'lifecycle-events.jsonl'), 'utf8')).toBe(beforeRejectedAppend);

    const conflicting = { ...continuation[0], artifactOrPr: 'https://example.test/conflict' };
    fs.writeFileSync(eventsFile, `${JSON.stringify(conflicting)}\n`);
    expect(() => appendLoopFleetLifecycle({
      eventsFile,
      ledgerDir,
      registryPath: path.resolve('data/loop-fleet/loop-registry.json'),
    })).toThrow('conflicting duplicate');
  });
});
