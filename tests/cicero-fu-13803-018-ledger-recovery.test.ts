import { describe, expect, it } from 'vitest';
import {
  selectRecoveryCandidates,
  sourceDefinition,
} from '../scripts/ci/loop-fleet-ledger-reconcile.mjs';

const definition = sourceDefinition('L0');
const sha = 'a'.repeat(40);

function candidate(databaseId: number, overrides: Record<string, unknown> = {}) {
  return {
    definition,
    run: {
      databaseId,
      id: databaseId,
      status: 'completed',
      conclusion: 'success',
      headBranch: 'main',
      headSha: sha,
      event: 'schedule',
      createdAt: '2026-10-20T10:00:00.000Z',
      ...overrides,
    },
    missing: ['observation'],
  };
}

describe('loop-fleet ledger recovery candidates (#13803 FU-018)', () => {
  it('normalizes an invalid dispatch cap and excludes ineligible source runs', () => {
    const selected = selectRecoveryCandidates([
      candidate(1),
      candidate(2),
      candidate(3),
      candidate(4),
      candidate(5, { event: 'pull_request' }),
      candidate(6, { headSha: 'short' }),
    ], { maxDispatches: 0 });

    expect(selected.map((item) => item.run.databaseId)).toEqual([1, 2, 3]);
  });

  it('uses database id as the deterministic tie-breaker for equal timestamps', () => {
    const selected = selectRecoveryCandidates([
      candidate(30),
      candidate(10),
      candidate(20),
    ], { maxDispatches: 10 });

    expect(selected.map((item) => item.run.databaseId)).toEqual([10, 20, 30]);
  });
});
