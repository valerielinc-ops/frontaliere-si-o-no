import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — the lifecycle observer is a dependency-free ESM CI script.
import {
  explicitTerminalEvidence,
  expiredClosedPullRequestEvidence,
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

    const recorderEvent = { ...candidate(), eventType: 'candidate' };
    fs.writeFileSync(eventsFile, `${JSON.stringify(recorderEvent)}\n`);
    expect(() => appendLoopFleetLifecycle({ eventsFile, ledgerDir })).toThrow('must be a downstream event');
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
    })).toThrow(/rolled_back requires rollback_requested/u);
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
    expect(fs.existsSync(path.join(ledgerDir, 'lifecycle-events.jsonl'))).toBe(false);
  });

  it('persists an isolated inconclusive and valid rollback chains idempotently', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-valid-terminal-events-'));
    const eventsFile = path.join(root, 'events.jsonl');
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
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
