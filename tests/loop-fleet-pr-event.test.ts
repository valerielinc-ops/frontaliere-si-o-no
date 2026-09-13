import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — the PR lifecycle helper is a dependency-free ESM CI script.
import { appendLoopFleetPrOpenedEvents } from '../scripts/ci/append-loop-fleet-pr-event.mjs';

const registry = JSON.parse(fs.readFileSync(path.resolve('data/loop-fleet/loop-registry.json'), 'utf8'));
const NOW = new Date('2026-09-13T08:00:00.000Z');
const SHA = 'a'.repeat(40);

function fixture(dir: string) {
  const candidate = {
    recordType: 'lifecycle-event',
    schemaVersion: 1,
    recordId: 'candidate-record',
    eventType: 'candidate',
    loopId: 'L1',
    candidateId: 'decision-record',
    owner: registry.loops.find((loop: any) => loop.loopId === 'L1').owner,
    sourceRecordId: 'decision-record',
    sourceRefs: registry.loops.find((loop: any) => loop.loopId === 'L1').sourceRefs,
    lifecycle: registry.loops.find((loop: any) => loop.loopId === 'L1').lifecycle,
    occurredAt: NOW.toISOString(),
    artifactOrPr: null,
    recordedAt: NOW.toISOString(),
    execution: { loopId: 'L1', runId: '123', sha: SHA, recordedAt: NOW.toISOString() },
  };
  const ownerAssigned = {
    ...candidate,
    recordId: 'owner-record',
    eventType: 'owner_assigned',
  };
  fs.writeFileSync(path.join(dir, 'lifecycle-events.jsonl'), `${JSON.stringify(candidate)}\n${JSON.stringify(ownerAssigned)}\n`);
}

describe('append-loop-fleet-pr-event', () => {
  it('records a verifiable PR link and is idempotent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-pr-event-'));
    fixture(root);
    const first = appendLoopFleetPrOpenedEvents({
      loopId: 'L1',
      runId: '123',
      sha: SHA,
      ledgerDir: root,
      registryPath: 'data/loop-fleet/loop-registry.json',
      prUrl: 'https://github.com/example/repo/pull/1',
      prCreatedAt: '2026-09-13T08:01:00.000Z',
      now: NOW,
    });
    const second = appendLoopFleetPrOpenedEvents({
      loopId: 'L1',
      runId: '123',
      sha: SHA,
      ledgerDir: root,
      registryPath: 'data/loop-fleet/loop-registry.json',
      prUrl: 'https://github.com/example/repo/pull/1',
      prCreatedAt: '2026-09-13T08:01:00.000Z',
      now: NOW,
    });
    expect(first).toMatchObject({ candidates: 1, appended: 1, skipped: 0 });
    expect(second).toMatchObject({ candidates: 1, appended: 0, skipped: 1 });
    expect(fs.readFileSync(path.join(root, 'lifecycle-events.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('rejects a different PR for an already linked candidate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-pr-event-conflict-'));
    fixture(root);
    appendLoopFleetPrOpenedEvents({
      loopId: 'L1', runId: '123', sha: SHA, ledgerDir: root,
      registryPath: 'data/loop-fleet/loop-registry.json',
      prUrl: 'https://github.com/example/repo/pull/1',
      prCreatedAt: '2026-09-13T08:01:00.000Z', now: NOW,
    });
    expect(() => appendLoopFleetPrOpenedEvents({
      loopId: 'L1', runId: '123', sha: SHA, ledgerDir: root,
      registryPath: 'data/loop-fleet/loop-registry.json',
      prUrl: 'https://github.com/example/repo/pull/2',
      prCreatedAt: '2026-09-13T08:02:00.000Z', now: NOW,
    })).toThrow(/already linked/);
  });
});
