import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — the status roll-up is a dependency-free ESM CI script.
import { buildStatusRows, collectStatus, summarizeLifecycleEvents } from '../scripts/ci/loop-fleet-status.mjs';

const registry = JSON.parse(fs.readFileSync(path.resolve('data/loop-fleet/loop-registry.json'), 'utf8'));

function run(id: number) {
  return {
    run: {
      databaseId: id,
      conclusion: 'success',
      status: 'completed',
      createdAt: '2026-09-12T12:00:00.000Z',
      updatedAt: '2026-09-12T12:01:00.000Z',
      headSha: 'a'.repeat(40),
      url: `https://example.test/runs/${id}`,
    },
    error: null,
  };
}

describe('loop fleet status', () => {
  it('reports lifecycle gaps without treating the missing downstream events as success', () => {
    const summary = summarizeLifecycleEvents([
      {
        eventType: 'candidate',
        candidateId: 'lf-decision-1',
        owner: 'CTO / Reliability',
        occurredAt: '2026-09-12T12:00:00.000Z',
      },
      {
        eventType: 'owner_assigned',
        candidateId: 'lf-decision-1',
        owner: 'CTO / Reliability',
        occurredAt: '2026-09-12T12:00:01.000Z',
      },
    ]);
    expect(summary).toMatchObject({
      available: true,
      eventCount: 2,
      candidateCount: 1,
      complete: false,
      state: 'candidate',
      candidates: [{
        candidateId: 'lf-decision-1',
        eventTypes: ['candidate', 'owner_assigned'],
        missing: ['pr_opened', 'tests_passed', 'review_approved', 'merged', 'post_merge_verified'],
        complete: false,
      }],
    });
  });

  it('does not mark a present event set verified when order, owner or evidence is incoherent', () => {
    const base = (eventType: string, occurredAt: string, overrides: Record<string, unknown> = {}) => ({
      eventType,
      candidateId: 'lf-decision-coherent-check',
      owner: 'CTO / Reliability',
      sourceRecordId: 'lf-decision-coherent-check',
      occurredAt,
      artifactOrPr: `evidence://${eventType}`,
      ...overrides,
    });
    const summary = summarizeLifecycleEvents([
      base('candidate', '2026-09-12T12:00:00.000Z'),
      base('candidate', '2026-09-12T12:00:00.500Z'),
      base('owner_assigned', '2026-09-12T12:00:01.000Z'),
      base('pr_opened', '2026-09-12T12:00:02.000Z'),
      base('tests_passed', '2026-09-12T12:00:03.000Z'),
      base('review_approved', '2026-09-12T12:00:04.000Z', { owner: 'CFO / Unit Economics' }),
      base('merged', '2026-09-12T11:59:00.000Z'),
      base('post_merge_verified', '2026-09-12T12:00:06.000Z', { artifactOrPr: null }),
    ]);
    expect(summary).toMatchObject({ state: 'candidate', complete: false, candidates: [{
      orderValid: false,
      ownerConsistent: false,
      sourceConsistent: true,
      duplicateEventTypes: ['candidate'],
      missingEvidence: ['post_merge_verified'],
      complete: false,
    }] });
  });

  it('keeps missing evidence explicit instead of reporting a false healthy state', () => {
    const rows = buildStatusRows(
      registry,
      { L0: run(10) },
      { L0: { evidence: {
        quality: 'observed',
        evidenceComplete: true,
        lifecycleCompliant: true,
        policyCompliant: true,
        outcomePolicyCompliant: true,
        decision: 'observing',
        actionClass: 'observe',
        requiredAutonomy: 'A0',
        outcome: {
          outcomeId: 'fresh-complete-published-data',
          status: 'observed',
          independent: true,
          sourceRefs: ['manifest-api-corpus'],
          primaryMetric: 'fresh_complete_manifest_rate',
          numerator: 1,
          denominator: 1,
          requiredFieldsPresent: ['generatedAt', 'numerator', 'denominator'],
          missingFields: [],
          reason: 'test outcome',
        },
        health: { issueCount: 0, warningCount: 0 },
      }, error: null } },
    );
    expect(rows).toHaveLength(12);
    expect(rows.find((row: any) => row.loopId === 'L0')).toMatchObject({
      quality: 'observed',
      decision: 'observing',
      requiredAutonomy: 'A0',
      actualAutonomy: 'A0',
      sourceRefs: registry.loops.find((row: any) => row.loopId === 'L0').sourceRefs,
      policyCompliant: true,
      lifecycleCompliant: true,
      issue: null,
      missingOutcome: null,
    });
    expect(rows.find((row: any) => row.loopId === 'L1')).toMatchObject({
      quality: 'unmeasurable',
      evidenceComplete: false,
      policyCompliant: false,
      issue: 'evidence not inspected',
      missingOutcome: 'independent outcome not recorded',
    });
  });

  it('marks pre-lifecycle evidence incomplete during migration', () => {
    const rows = buildStatusRows(
      registry,
      { L0: run(11) },
      { L0: { evidence: {
        quality: 'observed',
        evidenceComplete: true,
        policyCompliant: true,
        outcomePolicyCompliant: true,
        decision: 'observing',
        actionClass: 'observe',
        requiredAutonomy: 'A0',
        outcome: {
          outcomeId: 'fresh-complete-published-data',
          status: 'observed',
          independent: true,
          sourceRefs: ['manifest-api-corpus'],
          primaryMetric: 'fresh_complete_manifest_rate',
          numerator: 1,
          denominator: 1,
          requiredFieldsPresent: ['generatedAt', 'numerator', 'denominator'],
          missingFields: [],
          reason: 'test outcome',
        },
        health: { issueCount: 0, warningCount: 0 },
      }, error: null } },
    );
    expect(rows.find((row: any) => row.loopId === 'L0')).toMatchObject({
      policyCompliant: false,
      lifecycleCompliant: false,
      lifecycleState: 'unavailable',
      lifecycleEventCount: null,
      evidenceError: 'canonical lifecycle evidence is missing or noncompliant',
      issue: 'canonical lifecycle evidence is missing or noncompliant',
    });
  });

  it('keeps an available lifecycle ledger explicit for loops with no candidate yet', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-status-empty-lifecycle-'));
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    fs.writeFileSync(path.join(ledgerDir, 'lifecycle-events.jsonl'), '');

    const rows = collectStatus({
      ledgerDir,
      ghRun: () => ({ run: null, error: 'no completed run found' }),
      download: () => ({ evidence: null, error: 'not called' }),
    });
    expect(rows.find((row: any) => row.loopId === 'L0')).toMatchObject({
      lifecycleState: 'no_candidate',
      lifecycleEventCount: 0,
      lifecycleComplete: null,
    });
  });

  it('keeps a legacy evidence record incomplete when its outcome contract is absent', () => {
    const rows = buildStatusRows(
      registry,
      { L0: run(12) },
      { L0: { evidence: { quality: 'observed', evidenceComplete: true, lifecycleCompliant: true, policyCompliant: true, decision: 'observing', actionClass: 'observe', requiredAutonomy: 'A0', health: { issueCount: 0, warningCount: 0 } }, error: null } },
    );
    expect(rows.find((row: any) => row.loopId === 'L0')).toMatchObject({
      policyCompliant: false,
      missingOutcome: 'independent outcome not recorded',
      nextHumanAction: 'restore or attach the independent source and rerun the loop',
    });
  });

  it('uses the durable health ledger as a validated cross-run fallback', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-status-ledger-'));
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    fs.writeFileSync(path.join(ledgerDir, 'loop-health-history.jsonl'), `${JSON.stringify({
      recordType: 'health',
      schemaVersion: 1,
      recordId: 'health-1',
      loopId: 'L0',
      execution: { runId: '77', sha: 'a'.repeat(40) },
      recordedAt: '2026-09-12T12:00:00.000Z',
      quality: 'observed',
      ok: true,
      evidenceComplete: true,
      policyCompliant: true,
      outcomePolicyCompliant: true,
      lifecycleCompliant: true,
      actionClass: 'observe',
      requiredAutonomy: 'A0',
      outcome: {
        outcomeId: 'fresh-complete-published-data',
        status: 'observed',
        independent: true,
        sourceRefs: ['manifest-api-corpus'],
        primaryMetric: 'fresh_complete_manifest_rate',
        numerator: 1,
        denominator: 1,
        requiredFieldsPresent: ['generatedAt', 'numerator', 'denominator'],
        missingFields: [],
        reason: 'durable test outcome',
        recordedAt: '2026-09-12T12:00:00.000Z',
      },
    })}\n`);

    const rows = collectStatus({
      ledgerDir,
      ghRun: () => ({ run: null, error: 'no completed run found' }),
      download: () => ({ evidence: null, error: 'not called' }),
    });
    expect(rows.find((row: any) => row.loopId === 'L0')).toMatchObject({
      historyAvailable: true,
      outcome: { outcomeId: 'fresh-complete-published-data', status: 'observed' },
      missingOutcome: null,
      ledgerLastRun: { id: '77', headSha: 'a'.repeat(40) },
    });
  });

  it('preserves registry owner, metric and autonomy ceiling in every row', () => {
    const rows = buildStatusRows(registry, {}, {});
    for (const policy of registry.loops) {
      expect(rows.find((row: any) => row.loopId === policy.loopId)).toMatchObject({
        owner: policy.owner,
        primaryMetric: policy.primaryMetric,
        maxAutonomy: policy.maxAutonomy,
        lifecycle: policy.lifecycle,
        sourceRefs: policy.sourceRefs,
        candidateTtlHours: policy.lifecycle.candidateTtlHours,
        ownerSlaHours: policy.lifecycle.ownerSlaHours,
        postMergeVerificationHours: policy.lifecycle.postMergeVerificationHours,
      });
    }
  });
});
