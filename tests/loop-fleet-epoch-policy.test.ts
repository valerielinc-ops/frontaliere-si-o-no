import { describe, expect, it } from 'vitest';
import {
  buildLedgerBatchBranch,
  isBridgeLedgerBranch,
  isLifecycleLedgerBranch,
  LEDGER_EPOCH_LIMITS,
  ledgerEpochDecision,
} from '../scripts/ci/loop-fleet-epoch-policy.mjs';

describe('loop-fleet ledger epoch policy', () => {
  it('allows a new epoch without an open PR', () => {
    expect(ledgerEpochDecision()).toMatchObject({
      allow: true,
      route: 'canonical-branch',
      preserveSource: true,
      reason: 'no-open-epoch',
    });
  });

  it('allows a bounded append before either limit', () => {
    expect(ledgerEpochDecision({
      openPr: true,
      batchCount: LEDGER_EPOCH_LIMITS.maxBatches - 1,
      ageMinutes: LEDGER_EPOCH_LIMITS.maxAgeMinutes - 1,
    })).toMatchObject({
      allow: true,
      route: 'open-epoch',
      preserveSource: true,
      reason: 'within-bounds',
    });
  });

  it('freezes the epoch at the batch cap', () => {
    expect(ledgerEpochDecision({
      openPr: true,
      batchCount: LEDGER_EPOCH_LIMITS.maxBatches,
      ageMinutes: 1,
    })).toMatchObject({
      allow: false,
      route: 'new-batch-branch',
      preserveSource: true,
      reason: 'batch-cap-reached',
    });
  });

  it('freezes the epoch at the age cap', () => {
    expect(ledgerEpochDecision({
      openPr: true,
      batchCount: 1,
      ageMinutes: LEDGER_EPOCH_LIMITS.maxAgeMinutes,
    })).toMatchObject({
      allow: false,
      route: 'new-batch-branch',
      preserveSource: true,
      reason: 'age-cap-reached',
    });
  });

  it('freezes when an open epoch has no trustworthy age', () => {
    expect(ledgerEpochDecision({ openPr: true, batchCount: 1 })).toMatchObject({
      allow: false,
      route: 'new-batch-branch',
      preserveSource: true,
      reason: 'epoch-age-unavailable',
    });
  });

  it('uses a bridge-only batch branch and excludes lifecycle branches', () => {
    const batch = buildLedgerBatchBranch({ loopId: 'L11', runId: '35190000000', attempt: '2' });
    expect(batch).toBe('chore/loop-fleet-ledger-L11-35190000000-2');
    expect(isBridgeLedgerBranch(batch)).toBe(true);
    expect(isBridgeLedgerBranch('chore/loop-fleet-ledger-lifecycle-35190000000-2')).toBe(false);
    expect(isLifecycleLedgerBranch('chore/loop-fleet-ledger-lifecycle-35190000000-2')).toBe(true);
    expect(isLifecycleLedgerBranch(batch)).toBe(false);
  });

  it('rejects malformed or out-of-range producer branches', () => {
    expect(() => buildLedgerBatchBranch({ loopId: 'L12', runId: '1', attempt: '1' })).toThrow(/L0-L11/u);
    expect(() => buildLedgerBatchBranch({ loopId: 'L0', runId: 'abc', attempt: '1' })).toThrow(/runId/u);
    expect(isBridgeLedgerBranch('chore/loop-fleet-ledger-L0-1-1-extra')).toBe(false);
    expect(isLifecycleLedgerBranch('chore/loop-fleet-ledger-lifecycle-abc-1')).toBe(false);
  });
});
