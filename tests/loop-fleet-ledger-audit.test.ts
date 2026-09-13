import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — the audit is a dependency-free ESM CI script.
import {
  auditArtifactRetention,
  auditLedger,
  auditWorkflowRetention,
  renderMarkdown,
} from '../scripts/ci/loop-fleet-ledger-audit.mjs';

const registry = JSON.parse(fs.readFileSync(path.resolve('data/loop-fleet/loop-registry.json'), 'utf8'));
const SHA = 'a'.repeat(40);
const NOW = new Date('2026-09-13T12:00:00.000Z');

function writeJsonl(dir: string, name: string, records: unknown[]) {
  fs.writeFileSync(path.join(dir, name), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

function seedRecord(type: 'observation' | 'decision' | 'health', runId = '100', loopId = 'L0') {
  const sourceFile = {
    observation: 'loop-observations.jsonl',
    decision: 'loop-decisions.jsonl',
    health: 'loop-health-history.jsonl',
  }[type];
  const source = fs.readFileSync(path.resolve('data/loop-fleet/ledger', sourceFile), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((record) => record.loopId === loopId);
  if (!source) throw new Error(`missing ${loopId} seed in ${sourceFile}`);
  return {
    ...source,
    recordId: `test-${type}-${loopId}-${runId}`,
    execution: { ...source.execution, loopId, runId, sha: SHA, recordedAt: '2026-09-13T11:00:00.000Z' },
    loopId,
    recordedAt: '2026-09-13T11:00:00.000Z',
  };
}

describe('loop-fleet-ledger-audit', () => {
  it('measures complete, partial and missing durable coverage by loop', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-ledger-audit-'));
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    writeJsonl(ledgerDir, 'loop-observations.jsonl', [seedRecord('observation'), seedRecord('observation', '101'), seedRecord('observation', '102', 'L1')]);
    writeJsonl(ledgerDir, 'loop-decisions.jsonl', [seedRecord('decision')]);
    writeJsonl(ledgerDir, 'loop-health-history.jsonl', [seedRecord('health')]);
    const audit = auditLedger({ ledgerDir, registry, now: NOW });
    expect(audit.errors).toEqual([]);
    expect(audit.summary).toMatchObject({ loopCount: 12, completeLoopCount: 1, coverageRate: 1 / 12 });
    expect(audit.loops.find((row: any) => row.loopId === 'L0')).toMatchObject({
      coverageState: 'complete', completeRunCount: 1, missingRecordTypes: [],
    });
    expect(audit.loops.find((row: any) => row.loopId === 'L1')).toMatchObject({
      coverageState: 'partial', completeRunCount: 0, missingRecordTypes: ['decision', 'health'],
    });
    expect(audit.loops.find((row: any) => row.loopId === 'L2')).toMatchObject({
      coverageState: 'missing', completeRunCount: 0,
    });
  });

  it('fails closed on malformed JSON and conflicting duplicate record IDs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-ledger-audit-invalid-'));
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    const record = seedRecord('health');
    writeJsonl(ledgerDir, 'loop-health-history.jsonl', [record, { ...record, warningCount: (record.warningCount || 0) + 1 }]);
    fs.writeFileSync(path.join(ledgerDir, 'loop-observations.jsonl'), '{not-json}\n');
    const audit = auditLedger({ ledgerDir, registry, now: NOW });
    expect(audit.errors.some((error: string) => error.includes('invalid JSON'))).toBe(true);
    expect(audit.errors.some((error: string) => error.includes('conflicting content'))).toBe(true);
    expect(audit.summary.status).toBe('error');
  });

  it('reports observe-only coverage, recording latency, duplicates and cardinality', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-ledger-audit-metrics-'));
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    const observation = seedRecord('observation', '100');
    const decision = {
      ...seedRecord('decision', '100'),
      recordedAt: '2026-09-13T11:02:00.000Z',
      execution: { ...seedRecord('decision', '100').execution, recordedAt: '2026-09-13T11:02:00.000Z' },
    };
    const health = {
      ...seedRecord('health', '100'),
      recordedAt: '2026-09-13T11:05:00.000Z',
      execution: { ...seedRecord('health', '100').execution, recordedAt: '2026-09-13T11:05:00.000Z' },
    };
    writeJsonl(ledgerDir, 'loop-observations.jsonl', [observation]);
    writeJsonl(ledgerDir, 'loop-decisions.jsonl', [decision]);
    writeJsonl(ledgerDir, 'loop-health-history.jsonl', [health, health]);
    const audit = auditLedger({ ledgerDir, registry, now: NOW });
    const row = audit.loops.find((candidate: any) => candidate.loopId === 'L0') as any;
    expect(row.metrics).toMatchObject({
      validRecordCount: 4,
      uniqueRecordIdCount: 3,
      duplicateRecordCount: 1,
      conflictingDuplicateRecordCount: 0,
      duplicateExecutionTypeCount: 1,
      executionCount: 1,
      completeExecutionCount: 1,
      coverageRate: 1,
      recordsPerExecution: 4,
      recordingLatencyMs: {
        measuredExecutionCount: 1,
        min: 300000,
        p50: 300000,
        p95: 300000,
        max: 300000,
      },
    });
    expect(audit.summary.metrics).toMatchObject({
      validRecordCount: 4,
      executionCount: 1,
      completeExecutionCount: 1,
      completeExecutionRate: 1,
      recordingLatencyMs: { p95: 300000 },
    });
  });

  it('checks every source workflow for 90-day artifacts and lifecycle transport', () => {
    const audit = auditWorkflowRetention({ workflowDir: '.github/workflows' });
    expect(audit.summary).toMatchObject({ loopCount: 12, compliantCount: 12, noncompliantCount: 0 });
    expect(audit.errors).toEqual([]);
  });

  it('reports live retention from paginated artifact metadata without mutating it', () => {
    const artifacts = ['L0', 'L11'].map((loopId) => {
      const prefix = loopId === 'L11' ? 'technical-operations-audit' : 'loop-l0-data-truth';
      return {
        name: `${prefix}-100`,
        created_at: '2026-09-10T12:00:00.000Z',
        expires_at: '2026-12-09T12:00:00.000Z',
        expired: false,
      };
    });
    const audit = auditArtifactRetention({
      payload: [{ total_count: artifacts.length, artifacts }],
      now: NOW,
    });
    expect(audit.available).toBe(true);
    expect(audit.summary).toMatchObject({ listedTotal: 2, declaredTotal: 2, apiComplete: true, measuredLoopCount: 2 });
    expect(audit.loops.find((row: any) => row.loopId === 'L0')).toMatchObject({ status: 'observed', artifactCount: 1, activeCount: 1 });
    expect(audit.loops.find((row: any) => row.loopId === 'L1')).toMatchObject({ status: 'unmeasurable', artifactCount: 0 });
  });

  it('does not turn missing Actions metadata into a false zero', () => {
    const audit = auditArtifactRetention({ payload: { available: false, error: 'API unavailable' }, now: NOW });
    expect(audit).toMatchObject({ available: false, summary: { status: 'unmeasurable', listedTotal: 0 } });
    expect(audit.loops.every((row: any) => row.status === 'unmeasurable')).toBe(true);
  });

  it('renders the report as an explicit read-only operational artifact', () => {
    const markdown = renderMarkdown({
      quality: 'partial',
      ledger: { summary: { completeLoopCount: 1, loopCount: 12, coverageRate: 1 / 12, independentOutcomeLoopCount: 0 }, loops: [] },
      workflows: { summary: { compliantCount: 12, loopCount: 12 }, loops: [] },
      artifacts: { summary: { measuredLoopCount: 0 }, loops: [] },
      errors: [],
    });
    expect(markdown).toContain('read-only');
    expect(markdown).toContain('Copertura ledger completa: 1/12');
    expect(markdown).toContain('Metriche ledger read-only');
  });
});
