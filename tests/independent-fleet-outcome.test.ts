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
});
