import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — the reconciler is a dependency-free ESM CI script.
import {
  SOURCE_LOOPS,
  durableRecordIds,
  eligibleSourceRun,
  missingEvidenceRecordIds,
  selectRecoveryCandidates,
  sourceArtifactName,
  sourceDefinition,
} from '../scripts/ci/loop-fleet-ledger-reconcile.mjs';

const SHA = 'a'.repeat(40);

function run(overrides: Record<string, unknown> = {}) {
  return {
    databaseId: 123,
    status: 'completed',
    conclusion: 'success',
    headBranch: 'main',
    headSha: SHA,
    event: 'schedule',
    createdAt: '2026-09-13T01:00:00.000Z',
    ...overrides,
  };
}

function writeJson(root: string, name: string, value: unknown) {
  fs.writeFileSync(path.join(root, name), `${JSON.stringify(value)}\n`);
}

function writeJsonl(root: string, name: string, records: unknown[]) {
  fs.writeFileSync(path.join(root, name), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

describe('loop-fleet-ledger-reconcile', () => {
  it('declares one exact source workflow and artifact family for every loop', () => {
    expect(SOURCE_LOOPS).toHaveLength(12);
    expect(new Set(SOURCE_LOOPS.map((definition: any) => definition.loopId)).size).toBe(12);
    expect(sourceDefinition('L11')).toMatchObject({
      workflowFile: 'technical-operations-supervisor.yml',
      artifactPrefix: 'technical-operations-audit',
    });
    expect(sourceArtifactName('L3', 456)).toBe('loop-l3-job-quality-456');
    expect(sourceArtifactName('L11', 456)).toBe('technical-operations-audit-456');
    expect(sourceArtifactName('L99', 456)).toBeNull();
  });

  it('accepts only completed non-PR main runs with a full SHA', () => {
    const definition = sourceDefinition('L0');
    expect(eligibleSourceRun(run(), definition)).toBe(true);
    expect(eligibleSourceRun(run({ headBranch: 'feature' }), definition)).toBe(false);
    expect(eligibleSourceRun(run({ event: 'pull_request' }), definition)).toBe(false);
    expect(eligibleSourceRun(run({ conclusion: 'cancelled' }), definition)).toBe(false);
    expect(eligibleSourceRun(run({ headSha: 'short' }), definition)).toBe(false);
    expect(eligibleSourceRun(run({ status: 'in_progress' }), definition)).toBe(false);
  });

  it('requests recovery only when the immutable health artifact is not durable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-reconcile-test-'));
    const input = path.join(root, 'input');
    const ledger = path.join(root, 'ledger');
    fs.mkdirSync(input);
    fs.mkdirSync(ledger);
    const execution = { loopId: 'L0', runId: '123', sha: SHA };
    const records = {
      observation: { recordType: 'observation', loopId: 'L0', recordId: 'observation-1', execution },
      decision: { recordType: 'decision', loopId: 'L0', recordId: 'decision-1', execution },
      health: { recordType: 'health', loopId: 'L0', recordId: 'health-1', execution },
    };
    writeJson(input, 'loop-fleet-evidence.json', { loopId: 'L0', run: { runId: '123', sha: SHA } });
    writeJsonl(input, 'loop-observations.jsonl', [records.observation]);
    writeJsonl(input, 'loop-decisions.jsonl', [records.decision]);
    writeJsonl(input, 'loop-health-history.jsonl', [records.health]);

    expect(missingEvidenceRecordIds(input, ledger, { loopId: 'L0', runId: '123', sha: SHA })).toMatchObject({
      ok: true,
      missing: [
        { type: 'observation', recordId: 'observation-1' },
        { type: 'decision', recordId: 'decision-1' },
        { type: 'health', recordId: 'health-1' },
      ],
    });

    writeJsonl(ledger, 'loop-observations.jsonl', [records.observation]);
    writeJsonl(ledger, 'loop-decisions.jsonl', [records.decision]);
    writeJsonl(ledger, 'loop-health-history.jsonl', [records.health]);
    expect(missingEvidenceRecordIds(input, ledger, { loopId: 'L0', runId: '123', sha: SHA })).toMatchObject({
      ok: true,
      missing: [],
      reason: 'source run is already durable',
    });
  });

  it('fails closed for missing, mismatched or incomplete artifacts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-reconcile-test-'));
    const ledger = path.join(root, 'ledger');
    fs.mkdirSync(ledger);
    expect(missingEvidenceRecordIds(root, ledger, { loopId: 'L0', runId: '123', sha: SHA })).toMatchObject({
      ok: false,
      reason: 'loop-fleet-evidence.json is missing',
    });
    writeJson(root, 'loop-fleet-evidence.json', { loopId: 'L1', run: { runId: '123', sha: SHA } });
    expect(missingEvidenceRecordIds(root, ledger, { loopId: 'L0', runId: '123', sha: SHA })).toMatchObject({
      ok: false,
      reason: 'evidence summary provenance does not match the source run',
    });
    writeJson(root, 'loop-fleet-evidence.json', { loopId: 'L0', run: { runId: '123', sha: SHA } });
    expect(missingEvidenceRecordIds(root, ledger, { loopId: 'L0', runId: '123', sha: SHA })).toMatchObject({
      ok: false,
      reason: 'health evidence is missing',
    });
  });

  it('selects the oldest bounded recovery candidates', () => {
    const definition = sourceDefinition('L0');
    const candidates = [
      { definition, run: run({ databaseId: 3, createdAt: '2026-09-13T03:00:00.000Z' }), missing: [] },
      { definition, run: run({ databaseId: 1, createdAt: '2026-09-13T01:00:00.000Z' }), missing: [] },
      { definition, run: run({ databaseId: 2, createdAt: '2026-09-13T02:00:00.000Z' }), missing: [] },
    ];
    expect(selectRecoveryCandidates(candidates, { maxDispatches: 2 }).map((candidate: any) => candidate.run.databaseId))
      .toEqual([1, 2]);
  });

  it('reads durable IDs from all three canonical ledgers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-reconcile-test-'));
    fs.mkdirSync(path.join(root, 'ledger'));
    writeJsonl(path.join(root, 'ledger'), 'loop-health-history.jsonl', [{ recordId: 'health-1' }]);
    expect([...durableRecordIds(path.join(root, 'ledger')).health]).toEqual(['health-1']);
    expect(durableRecordIds(path.join(root, 'ledger')).observation.size).toBe(0);
    expect(durableRecordIds(path.join(root, 'ledger')).decision.size).toBe(0);
  });
});
