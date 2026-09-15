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

  it('computes lifecycle TTL and owner SLA from trusted event timestamps', () => {
    const lifecycle = registry.loops.find((row: any) => row.loopId === 'L1').lifecycle;
    const event = (eventType: string, occurredAt: string) => ({
      eventType,
      candidateId: 'lf-decision-sla-check',
      owner: 'CTO / Reliability',
      sourceRecordId: 'lf-decision-sla-check',
      lifecycle,
      occurredAt,
    });
    const summary = summarizeLifecycleEvents([
      event('candidate', '2026-09-12T12:00:00.000Z'),
      event('owner_assigned', '2026-09-12T12:00:01.000Z'),
    ], { now: new Date('2026-09-14T13:00:00.000Z') });

    expect(summary.candidates[0]).toMatchObject({
      complete: false,
      sla: {
        status: 'overdue',
        coherent: true,
        candidateTtl: {
          hours: 24,
          deadlineAt: '2026-09-13T12:00:00.000Z',
          status: 'overdue',
        },
        ownerSla: {
          hours: 24,
          deadlineAt: '2026-09-13T12:00:00.000Z',
          status: 'met',
        },
        postMergeVerification: {
          status: 'not_started',
          deadlineAt: null,
        },
      },
    });
    expect(summary.sla).toMatchObject({
      status: 'overdue',
      candidateCount: 1,
      overdueCount: 1,
      pendingCount: 0,
      nextDeadlineAt: '2026-09-13T12:00:00.000Z',
    });
  });

  it('treats the exact SLA boundary as overdue and ignores invalid timestamps', () => {
    const lifecycle = registry.loops.find((row: any) => row.loopId === 'L1').lifecycle;
    const event = (eventType: string, occurredAt: string) => ({
      eventType,
      candidateId: 'lf-decision-sla-boundary',
      owner: 'CTO / Reliability',
      sourceRecordId: 'lf-decision-sla-boundary',
      lifecycle,
      occurredAt,
    });
    const summary = summarizeLifecycleEvents([
      event('candidate', 'invalid'),
      event('candidate', '2026-09-12T12:00:00.000Z'),
      event('owner_assigned', '2026-09-12T12:00:01.000Z'),
    ], { now: new Date('2026-09-13T12:00:00.000Z') });

    expect(summary).toMatchObject({
      sla: { status: 'unmeasurable' },
      candidates: [{
        sla: {
          status: 'unmeasurable',
          coherent: false,
          candidateTtl: { status: 'overdue' },
        },
      }],
    });
  });

  it('does not mark a present event set verified when order, owner or evidence is incoherent', () => {
    const base = (eventType: string, occurredAt: string, overrides: Record<string, unknown> = {}) => ({
      eventType,
      candidateId: 'lf-decision-coherent-check',
      owner: 'CTO / Reliability',
      sourceRecordId: 'lf-decision-coherent-check',
      lifecycle: registry.loops.find((row: any) => row.loopId === 'L1').lifecycle,
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
      sla: { status: 'unmeasurable', coherent: false },
    }] });
  });

  it('requires an ordered rollback terminal and keeps a pending request incomplete', () => {
    const lifecycle = registry.loops.find((row: any) => row.loopId === 'L1').lifecycle;
    const event = (eventType: string, occurredAt: string) => ({
      eventType,
      candidateId: 'lf-decision-rollback-order',
      owner: 'CTO / Reliability',
      sourceRecordId: 'lf-decision-rollback-order',
      lifecycle,
      occurredAt,
      artifactOrPr: `evidence://${eventType}`,
    });
    const verified = [
      event('candidate', '2026-09-12T12:00:00.000Z'),
      event('owner_assigned', '2026-09-12T12:00:01.000Z'),
      event('pr_opened', '2026-09-12T12:00:02.000Z'),
      event('tests_passed', '2026-09-12T12:00:03.000Z'),
      event('review_approved', '2026-09-12T12:00:04.000Z'),
      event('merged', '2026-09-12T12:00:05.000Z'),
      event('post_merge_verified', '2026-09-12T12:00:06.000Z'),
    ];

    const pending = summarizeLifecycleEvents([
      ...verified,
      event('rollback_requested', '2026-09-12T12:00:07.000Z'),
    ]);
    expect(pending.candidates[0]).toMatchObject({
      terminalEventTypes: ['rollback_requested'],
      terminalOrderValid: true,
      terminalPending: true,
      complete: false,
      incoherent: [],
    });

    const rolledBack = summarizeLifecycleEvents([
      ...verified,
      event('rollback_requested', '2026-09-12T12:00:07.000Z'),
      event('rolled_back', '2026-09-12T12:00:08.000Z'),
    ]);
    expect(rolledBack.candidates[0]).toMatchObject({
      terminalEventTypes: ['rollback_requested', 'rolled_back'],
      terminalOrderValid: true,
      terminalPending: false,
      complete: true,
      incoherent: [],
    });
  });

  it('marks terminal lifecycle contradictions incomplete instead of accepting them as rollback evidence', () => {
    const lifecycle = registry.loops.find((row: any) => row.loopId === 'L1').lifecycle;
    const event = (eventType: string, occurredAt: string) => ({
      eventType,
      candidateId: 'lf-decision-terminal-contradiction',
      owner: 'CTO / Reliability',
      sourceRecordId: 'lf-decision-terminal-contradiction',
      lifecycle,
      occurredAt,
      artifactOrPr: `evidence://${eventType}`,
    });
    const summary = summarizeLifecycleEvents([
      event('candidate', '2026-09-12T12:00:00.000Z'),
      event('owner_assigned', '2026-09-12T12:00:01.000Z'),
      event('pr_opened', '2026-09-12T12:00:02.000Z'),
      event('tests_passed', '2026-09-12T12:00:03.000Z'),
      event('review_approved', '2026-09-12T12:00:04.000Z'),
      event('merged', '2026-09-12T12:00:05.000Z'),
      event('rolled_back', '2026-09-12T12:00:06.000Z'),
      event('post_merge_verified', '2026-09-12T12:00:10.000Z'),
      event('rollback_requested', '2026-09-12T12:00:08.000Z'),
      event('inconclusive', '2026-09-12T12:00:09.000Z'),
    ]);

    expect(summary.candidates[0]).toMatchObject({
      terminalOrderValid: false,
      duplicateTerminalEventTypes: [],
      terminalPending: false,
      complete: false,
    });
    expect(summary.candidates[0].incoherent).toEqual(expect.arrayContaining([
      'rolled_back occurs before rollback_requested',
      'rollback_requested occurs before post_merge_verified',
      'inconclusive conflicts with a rollback terminal',
      'inconclusive conflicts with a merged candidate',
    ]));

    expect(summary.state).toBe('candidate');

    const missingRequest = summarizeLifecycleEvents([
      event('candidate', '2026-09-12T12:00:00.000Z'),
      event('owner_assigned', '2026-09-12T12:00:01.000Z'),
      event('pr_opened', '2026-09-12T12:00:02.000Z'),
      event('tests_passed', '2026-09-12T12:00:03.000Z'),
      event('review_approved', '2026-09-12T12:00:04.000Z'),
      event('merged', '2026-09-12T12:00:05.000Z'),
      event('post_merge_verified', '2026-09-12T12:00:06.000Z'),
      event('rolled_back', '2026-09-12T12:00:07.000Z'),
    ]);
    expect(missingRequest.candidates[0].incoherent).toContain('rolled_back requires rollback_requested');
  });

  it('rejects invalid lifecycle timestamps and duplicate terminal retries', () => {
    const lifecycle = registry.loops.find((row: any) => row.loopId === 'L1').lifecycle;
    const event = (eventType: string, occurredAt: string) => ({
      eventType,
      candidateId: 'lf-decision-terminal-integrity',
      owner: 'CTO / Reliability',
      sourceRecordId: 'lf-decision-terminal-integrity',
      lifecycle,
      occurredAt,
      artifactOrPr: `evidence://${eventType}`,
    });
    const summary = summarizeLifecycleEvents([
      event('candidate', 'invalid'),
      event('owner_assigned', '2026-09-12T12:00:01.000Z'),
      event('rollback_requested', '2026-09-12T12:00:02.000Z'),
      event('rollback_requested', '2026-09-12T12:00:03.000Z'),
    ]);

    expect(summary.candidates[0]).toMatchObject({
      orderValid: false,
      invalidOccurredAtEventTypes: ['candidate'],
      duplicateTerminalEventTypes: ['rollback_requested'],
      terminalOrderValid: false,
      complete: false,
    });
    expect(summary.candidates[0].incoherent).toEqual(expect.arrayContaining([
      'candidate has invalid occurredAt',
      'rollback_requested appears more than once',
      'rollback_requested requires post_merge_verified',
    ]));
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
      issue: 'operational telemetry incomplete: durationSeconds, retryCount, quotaUnits, collisions, gateBypass',
      missingOutcome: null,
      nextHumanAction: 'restore complete operational telemetry and rerun the loop',
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
      nextHumanAction: 'validate or attach the independent outcome before changing exposure',
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
      durationSeconds: 1.25,
      retryCount: 0,
      quotaUnits: 0,
      collisions: 0,
      gateBypass: false,
      operationalMetricsComplete: true,
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
      operationalMetrics: {
        durationSeconds: 1.25,
        retryCount: 0,
        quotaUnits: 0,
        collisions: 0,
        gateBypass: false,
        complete: true,
      },
    });
  });

  it('espone la telemetria mancante senza promuovere un ledger legacy', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-status-legacy-health-'));
    const ledgerDir = path.join(root, 'ledger');
    fs.mkdirSync(ledgerDir);
    fs.writeFileSync(path.join(ledgerDir, 'loop-health-history.jsonl'), `${JSON.stringify({
      recordType: 'health',
      schemaVersion: 1,
      recordId: 'health-legacy',
      loopId: 'L0',
      execution: { runId: '78', sha: 'b'.repeat(40) },
      recordedAt: '2026-09-12T12:00:00.000Z',
      quality: 'partial',
      ok: false,
      evidenceComplete: true,
      policyCompliant: true,
      outcomePolicyCompliant: true,
      lifecycleCompliant: true,
      actionClass: 'observe',
      requiredAutonomy: 'A0',
      outcome: {
        outcomeId: 'fresh-complete-published-data',
        status: 'partial',
        independent: false,
        sourceRefs: ['manifest-api-corpus'],
        primaryMetric: 'fresh_complete_manifest_rate',
        numerator: null,
        denominator: null,
        requiredFieldsPresent: [],
        missingFields: ['generatedAt', 'numerator', 'denominator'],
        reason: 'legacy fixture',
        recordedAt: '2026-09-12T12:00:00.000Z',
      },
    })}\n`);

    const rows = collectStatus({
      ledgerDir,
      ghRun: () => ({ run: null, error: 'no completed run found' }),
      download: () => ({ evidence: null, error: 'not called' }),
    });
    expect(rows.find((row: any) => row.loopId === 'L0')).toMatchObject({
      operationalMetrics: {
        complete: false,
        durationSeconds: null,
        missing: ['durationSeconds', 'retryCount', 'quotaUnits', 'collisions', 'gateBypass'],
      },
      nextHumanAction: 'validate or attach the independent outcome before changing exposure',
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
