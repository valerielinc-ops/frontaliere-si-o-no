import { describe, expect, it } from 'vitest';
// @ts-expect-error — the oracle is a dependency-free ESM module.
import { buildIndependentFleetControlOutcome } from '../scripts/lib/independent-fleet-outcome.mjs';

const NOW = new Date('2026-09-16T01:00:00.000Z');
const SHA = 'a'.repeat(40);

function health(runId: string, ok: boolean, overrides: Record<string, unknown> = {}) {
  return {
    recordType: 'health',
    loopId: 'L1',
    execution: { runId, sha: SHA, recordedAt: '2026-09-16T00:30:00.000Z' },
    recordedAt: '2026-09-16T00:30:00.000Z',
    ok,
    gateBypass: false,
    ...overrides,
  };
}

function run(databaseId: string, conclusion: string, overrides: Record<string, unknown> = {}) {
  return {
    databaseId,
    status: 'completed',
    conclusion,
    createdAt: '2026-09-16T00:30:00.000Z',
    headSha: SHA,
    ...overrides,
  };
}

const common = {
  outcomeId: 'verified-decision-throughput',
  primaryMetric: 'verified_decision_throughput',
  sourceRefs: ['github-actions', 'pr-issue', 'quota-health-ledger'],
};

describe('independent fleet outcome', () => {
  it('misura il throughput solo dopo il join completo con GitHub Actions', () => {
    const result = buildIndependentFleetControlOutcome({
      ...common,
      now: NOW,
      healthRecords: [health('101', true), health('102', false)],
      githubRuns: [run('101', 'success'), run('102', 'failure')],
    });

    expect(result.outcome).toMatchObject({
      status: 'observed',
      independent: true,
      numerator: 1,
      denominator: 2,
      missingFields: [],
    });
    expect(result.metrics).toMatchObject({ eligibleRuns: 2, joinedRuns: 2, reconciliationErrors: 0 });
    expect(result.metrics.reconciliationErrorClasses).toEqual({});
  });

  it('misura uno zero reale ma non nasconde una riga health mancante', () => {
    const zero = buildIndependentFleetControlOutcome({
      ...common,
      now: NOW,
      healthRecords: [health('101', false)],
      githubRuns: [run('101', 'success')],
    });
    expect(zero.outcome).toMatchObject({ status: 'zero', independent: true, numerator: 0, denominator: 1 });

    const incomplete = buildIndependentFleetControlOutcome({
      ...common,
      now: NOW,
      healthRecords: [health('101', true)],
      githubRuns: [run('101', 'success'), run('102', 'success')],
    });
    expect(incomplete.outcome).toMatchObject({ status: 'partial', independent: false, numerator: null, denominator: null });
    expect(incomplete.reconciliation.errors.join(' ')).toContain('102');
  });

  it('rifiuta SHA incoerenti e sorgenti oltre il limite bounded', () => {
    const mismatch = buildIndependentFleetControlOutcome({
      ...common,
      now: NOW,
      healthRecords: [health('101', true)],
      githubRuns: [run('101', 'success', { headSha: 'b'.repeat(40) })],
    });
    expect(mismatch.outcome).toMatchObject({ status: 'partial', independent: false });
    expect(mismatch.reconciliation.errors.join(' ')).toContain('SHA');

    const capped = buildIndependentFleetControlOutcome({
      ...common,
      now: NOW,
      maxRecords: 1,
      healthRecords: [health('101', true), health('102', true)],
      githubRuns: [run('101', 'success'), run('102', 'success')],
    });
    expect(capped.outcome).toMatchObject({ status: 'partial', independent: false });
    expect(capped.reconciliation.errors.join(' ')).toContain('bounded');
  });

  it('classifica ogni errore di riconciliazione per messaggio, workflow ed evento senza id di run', () => {
    const result = buildIndependentFleetControlOutcome({
      ...common,
      now: NOW,
      healthRecords: [health('37130952290', true)],
      githubRuns: [
        run('37130952280', 'success', { workflowFile: 'loop-l1-reliability.yml', event: 'schedule' }),
        run('37130952281', 'failure', { workflowFile: 'loop-l1-reliability.yml', event: 'schedule' }),
        run('37130952282', 'success', { workflowFile: 'loop-l3-job-quality.yml', event: 'push' }),
        run('37130952290', 'success', {
          workflowFile: 'loop-l1-reliability.yml',
          event: 'schedule',
          headSha: 'b'.repeat(40),
        }),
      ],
    });

    const classes = result.metrics.reconciliationErrorClasses as Record<string, number>;
    expect(classes).toEqual({
      'GitHub run <id> has no canonical health row|loop-l1-reliability.yml|schedule': 2,
      'GitHub run <id> has no canonical health row|loop-l3-job-quality.yml|push': 1,
      'GitHub run <id> SHA does not match canonical health execution|loop-l1-reliability.yml|schedule': 1,
    });
    const total = Object.values(classes).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(result.metrics.reconciliationErrors);
    expect(Object.keys(classes).join('\n')).not.toMatch(/3713095/u);
    // The raw per-run messages stay available for diagnosis.
    expect(result.reconciliation.errors).toHaveLength(result.metrics.reconciliationErrors);
    expect(result.reconciliation.errors.join(' ')).toContain('37130952280');
  });

  it('resta tutto-o-niente: un solo errore classificato basta per lasciare il join partial', () => {
    const result = buildIndependentFleetControlOutcome({
      ...common,
      now: NOW,
      healthRecords: [health('101', true)],
      githubRuns: [
        run('101', 'success', { workflowFile: 'loop-l0-data-truth.yml', event: 'schedule' }),
        run('102', 'success', { workflowFile: 'loop-l0-data-truth.yml', event: 'schedule' }),
      ],
    });

    expect(result.outcome).toMatchObject({ status: 'partial', independent: false, numerator: null, denominator: null });
    expect(result.metrics.reconciliationErrors).toBe(1);
    expect(result.metrics.reconciliationErrorClasses).toEqual({
      'GitHub run <id> has no canonical health row|loop-l0-data-truth.yml|schedule': 1,
    });
  });

  it('classifica gli errori lato ledger con workflow ed evento della riga health', () => {
    const result = buildIndependentFleetControlOutcome({
      ...common,
      now: NOW,
      healthRecords: [health('201', true, {
        execution: {
          runId: '201',
          sha: SHA,
          workflow: 'Loop L2 demand utility',
          event: 'workflow_run',
          recordedAt: '2026-09-16T00:30:00.000Z',
        },
      })],
      githubRuns: [],
    });

    expect(result.metrics.reconciliationErrorClasses).toEqual({
      'canonical health execution <id> has no eligible GitHub run in the window|Loop L2 demand utility|workflow_run': 1,
    });
  });

  it('esclude dal denominatore i run cancellati che il bridge non persiste', () => {
    const result = buildIndependentFleetControlOutcome({
      ...common,
      now: NOW,
      healthRecords: [],
      githubRuns: [run('101', 'cancelled')],
    });

    expect(result.outcome).toMatchObject({ status: 'unmeasurable', independent: false });
    expect(result.metrics).toMatchObject({ eligibleRuns: null, excludedRuns: 1, reconciliationErrors: 0 });
  });
});
